# @thoughtminers/agent-runtime-redis

Cross-instance **supersede** `Lock` for `@thoughtminers/agent-runtime-core`.

The in-memory lock only serializes within one process; behind a load balancer with
no session affinity (Cloud Run, k8s), rapid messages for one conversation land on
different instances and race. This lock coordinates through Redis so a newer message
aborts the in-flight run on **any** instance and processes with the fuller context.

```ts
import Redis from 'ioredis';
import { createRedisLock } from '@thoughtminers/agent-runtime-redis';

const lock = createRedisLock(new Redis(process.env.REDIS_URL!));
// createAgent({ ..., lock });
```

Client-agnostic: it needs only a small `RedisLike` surface (`incr`, `pexpire`,
`set … NX PX`, `get`, `eval`) — `ioredis` satisfies it as-is; no peer dependency.

## How it works (poll-based, one connection, no pub/sub)

- `INCR arl:gen:{id}` → a monotonic generation; the highest is the newest claimant.
- `SET arl:lock:{id} <gen> NX PX ttl` → the mutex, retried until the prior holder frees it.
- a background poller (`pollMs`, default 250) aborts the lease the moment a newer
  generation appears, and heartbeats the lock TTL while held.
- release is a Lua compare-and-del — it never deletes another holder's lock.

Abort latency ≈ `pollMs`. **Fails safe:** any Redis error degrades to a no-op lease
(no serialization) instead of throwing — a reply matters more than strict ordering.

## Options

| Option | Default | |
|---|---|---|
| `keyPrefix` | `arl` | key namespace |
| `ttlMs` | `30_000` | lock lease TTL (heartbeated while held) |
| `pollMs` | `250` | supersede-check / heartbeat interval (≈ abort latency) |
| `acquireTimeoutMs` | `60_000` | max wait before degrading (proceed without the lock) |
| `genTtlMs` | `3_600_000` | TTL on the generation counter |
| `onError` | noop | called on any Redis error (the lock degrades) |

Testing: `pnpm test` runs deterministic fake-Redis unit tests; the integration test is
env-gated — `REDIS_URL=redis://localhost:6399 pnpm test` against a real Redis.
