import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRedisLock } from '../dist/index.js';

/**
 * Env-gated integration test against a real Redis.
 *   docker run -p 6399:6379 --rm redis:7-alpine
 *   REDIS_URL=redis://localhost:6399 pnpm test
 */
const url = process.env.REDIS_URL;

test(
  'real Redis: cross-instance supersede via two independent clients',
  { skip: !url && 'set REDIS_URL (e.g. redis://localhost:6399)' },
  async () => {
    const { default: Redis } = await import('ioredis');
    // Two clients = two "instances" sharing one Redis.
    const redisA = new Redis(url!);
    const redisB = new Redis(url!);
    try {
      const conv = `it-${Date.now()}`;
      const lockA = createRedisLock(redisA, { pollMs: 25, ttlMs: 3000 });
      const lockB = createRedisLock(redisB, { pollMs: 25, ttlMs: 3000 });

      const leaseA = await lockA.claim(conv); // instance A holds
      assert.equal(leaseA.signal.aborted, false);

      const bClaim = lockB.claim(conv); // instance B supersedes A

      const deadline = Date.now() + 2000;
      while (!leaseA.signal.aborted && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(leaseA.signal.aborted, true, 'A aborted cross-instance');

      await leaseA.release();
      const leaseB = await bClaim;
      assert.equal(leaseB.signal.aborted, false, 'B holds after A released');
      await leaseB.release();
    } finally {
      redisA.disconnect();
      redisB.disconnect();
    }
  }
);
