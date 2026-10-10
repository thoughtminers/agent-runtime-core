import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRedisLock, type RedisLike } from '../dist/index.js';

/** Faithful in-memory fake of the RedisLike surface (NX/PX, TTL expiry, compare-del). */
class FakeRedis implements RedisLike {
  private store = new Map<string, { value: string; expireAt: number | null }>();
  failIncr = false;
  private live(key: string) {
    const e = this.store.get(key);
    if (!e) return null;
    if (e.expireAt !== null && Date.now() > e.expireAt) {
      this.store.delete(key);
      return null;
    }
    return e;
  }
  async incr(key: string): Promise<number> {
    if (this.failIncr) throw new Error('redis down');
    const e = this.live(key);
    const n = (e ? Number(e.value) : 0) + 1;
    this.store.set(key, { value: String(n), expireAt: e ? e.expireAt : null });
    return n;
  }
  async pexpire(key: string, ms: number): Promise<number> {
    const e = this.live(key);
    if (!e) return 0;
    e.expireAt = Date.now() + ms;
    return 1;
  }
  async set(key: string, value: string, _px: 'PX', ttlMs: number, _nx: 'NX'): Promise<string | null> {
    if (this.live(key)) return null; // NX
    this.store.set(key, { value, expireAt: Date.now() + ttlMs });
    return 'OK';
  }
  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }
  async eval(_script: string, _n: number, key: string, arg: string | number): Promise<unknown> {
    const e = this.live(key);
    if (e && e.value === String(arg)) {
      this.store.delete(key);
      return 1;
    }
    return 0;
  }
}

const waitFor = async (pred: () => boolean, timeoutMs = 1000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

test('acquires a free conversation immediately', async () => {
  const lock = createRedisLock(new FakeRedis(), { pollMs: 10 });
  const lease = await lock.claim('c1');
  assert.equal(lease.signal.aborted, false);
  await lease.release();
});

test('supersede: a newer claim aborts the in-flight lease; after release the newer acquires', async () => {
  const lock = createRedisLock(new FakeRedis(), { pollMs: 10, ttlMs: 5000 });

  const leaseA = await lock.claim('c1'); // gen 1 — holds
  assert.equal(leaseA.signal.aborted, false);

  const bClaim = lock.claim('c1'); // gen 2 — supersedes A, waits for A to release

  await waitFor(() => leaseA.signal.aborted); // A's poller sees the newer gen
  assert.equal(leaseA.signal.aborted, true);

  await leaseA.release(); // A's run exits → frees the mutex
  const leaseB = await bClaim;
  assert.equal(leaseB.signal.aborted, false);
  await leaseB.release();
});

test('three rapid claims: only the last ends up holding, unaborted', async () => {
  const lock = createRedisLock(new FakeRedis(), { pollMs: 10, ttlMs: 5000 });
  const a = await lock.claim('c1');
  const bClaim = lock.claim('c1');
  const cClaim = lock.claim('c1');

  await waitFor(() => a.signal.aborted);
  await a.release();

  // B was superseded by C before/while waiting → resolves aborted, holds nothing.
  const b = await bClaim;
  assert.equal(b.signal.aborted, true);
  await b.release();

  const c = await cClaim;
  assert.equal(c.signal.aborted, false);
  await c.release();
});

test('different conversations do not interfere', async () => {
  const lock = createRedisLock(new FakeRedis(), { pollMs: 10 });
  const a = await lock.claim('convA');
  const b = await lock.claim('convB');
  assert.equal(a.signal.aborted, false);
  assert.equal(b.signal.aborted, false);
  await a.release();
  await b.release();
});

test('fails safe: a Redis error degrades to a no-op lease (never throws, never aborts)', async () => {
  const redis = new FakeRedis();
  redis.failIncr = true;
  const errors: unknown[] = [];
  const lock = createRedisLock(redis, { pollMs: 10, onError: (e) => errors.push(e) });

  const lease = await lock.claim('c1'); // must not throw
  assert.equal(lease.signal.aborted, false);
  await lease.release(); // safe
  assert.equal(errors.length >= 1, true);
});
