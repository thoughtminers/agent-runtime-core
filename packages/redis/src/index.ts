import type { Lease, Lock } from '@thoughtminers/agent-runtime-core';

/**
 * The minimal Redis surface this adapter needs. `ioredis` satisfies it as-is
 * (`new Redis(url)`), so the package stays client-agnostic and dependency-free.
 */
export interface RedisLike {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<string | null>;
  get(key: string): Promise<string | null>;
  eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export interface RedisLockOptions {
  /** Key namespace. Default `arl`. */
  keyPrefix?: string;
  /** Lock lease TTL in ms (heartbeated while held). Default 30_000. */
  ttlMs?: number;
  /** Supersede-check / heartbeat interval in ms. Also the abort latency. Default 250. */
  pollMs?: number;
  /** Max wait to acquire before degrading (proceed without the lock). Default 60_000. */
  acquireTimeoutMs?: number;
  /** TTL on the per-conversation generation counter. Default 1h. */
  genTtlMs?: number;
  /** Called on any Redis error; the lock degrades (never drops a message). */
  onError?: (err: unknown) => void;
}

// Compare-and-delete: only release the lock if we still own the token.
const RELEASE_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

const noopLease = (): Lease => ({
  signal: new AbortController().signal, // never fires
  release: async () => {},
});

/**
 * Cross-instance per-conversation **supersede** lock (matches the harness
 * `Lock` contract). A newer `claim` for a conversation aborts the in-flight
 * lease on ANY instance and processes with the fuller context.
 *
 * Mechanism (poll-based — one Redis connection, no pub/sub):
 *  - `INCR arl:gen:{id}` → a monotonic generation; the highest is the newest claimant.
 *  - `SET arl:lock:{id} <gen> NX PX ttl` → the mutex; retried until the prior
 *    holder releases (its poller sees the newer gen, aborts, releases).
 *  - a background poller (every `pollMs`) aborts the lease when a newer gen
 *    appears, and heartbeats the lock TTL while held.
 *  - release is a compare-and-del (Lua) so we never delete someone else's lock.
 *
 * Fails safe: any Redis error degrades to a no-op lease (no serialization)
 * rather than throwing — a reply matters more than strict ordering.
 */
export const createRedisLock = (redis: RedisLike, opts: RedisLockOptions = {}): Lock => {
  const prefix = opts.keyPrefix ?? 'arl';
  const ttlMs = opts.ttlMs ?? 30_000;
  const pollMs = opts.pollMs ?? 250;
  const acquireTimeoutMs = opts.acquireTimeoutMs ?? 60_000;
  const genTtlMs = opts.genTtlMs ?? 3_600_000;
  const onError = opts.onError ?? (() => {});

  const lockKey = (id: string) => `${prefix}:lock:${id}`;
  const genKey = (id: string) => `${prefix}:gen:${id}`;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  return {
    claim: async (conversationId): Promise<Lease> => {
      const lk = lockKey(conversationId);
      const gk = genKey(conversationId);

      let myGen: number;
      try {
        myGen = await redis.incr(gk);
        await redis.pexpire(gk, genTtlMs);
      } catch (err) {
        onError(err); // Redis unreachable → degrade, don't drop the message.
        return noopLease();
      }
      const token = String(myGen);

      const controller = new AbortController();
      let held = false;
      let released = false;
      let poller: ReturnType<typeof setInterval> | undefined;
      const stopPoller = () => {
        if (poller) {
          clearInterval(poller);
          poller = undefined;
        }
      };

      poller = setInterval(() => {
        void (async () => {
          try {
            const cur = await redis.get(gk);
            if (cur !== null && Number(cur) > myGen) {
              controller.abort(); // superseded by a newer claim
              stopPoller();
              return;
            }
            if (held) await redis.pexpire(lk, ttlMs); // heartbeat only while holding
          } catch (err) {
            onError(err);
          }
        })();
      }, pollMs);
      poller.unref();

      const lease: Lease = {
        signal: controller.signal,
        release: async () => {
          if (released) return;
          released = true;
          stopPoller();
          try {
            await redis.eval(RELEASE_LUA, 1, lk, token);
          } catch (err) {
            onError(err);
          }
        },
      };

      const deadline = Date.now() + acquireTimeoutMs;
      while (true) {
        if (controller.signal.aborted) {
          // Superseded before acquiring — the run will see signal.aborted and
          // exit interrupted. We hold no key, so nothing to release.
          stopPoller();
          return { signal: controller.signal, release: async () => {} };
        }
        let ok: string | null = null;
        try {
          ok = await redis.set(lk, token, 'PX', ttlMs, 'NX');
        } catch (err) {
          onError(err);
          stopPoller();
          return noopLease(); // degrade
        }
        if (ok) {
          // Acquired. Close the acquire↔supersede race: re-check the generation.
          let cur: string | null = null;
          try {
            cur = await redis.get(gk);
          } catch (err) {
            onError(err);
          }
          if (controller.signal.aborted || (cur !== null && Number(cur) > myGen)) {
            await lease.release();
            return { signal: controller.signal, release: async () => {} };
          }
          held = true;
          return lease;
        }
        if (Date.now() > deadline) {
          // Stuck prior holder — degrade rather than drop. The poller still
          // aborts us if a newer claim arrives; release() Lua no-ops (not owner).
          onError(new Error(`agent-runtime-redis: acquire timeout for "${conversationId}"`));
          return lease;
        }
        await sleep(pollMs);
      }
    },
  };
};
