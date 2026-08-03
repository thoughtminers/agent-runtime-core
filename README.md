# agent-runtime (arc)

A small, sharp TypeScript agent harness — the **a**gent **r**untime **c**ore.
Zero-dependency core, streaming-native, storage-agnostic, provider-extensible —
extracted from four production agent implementations instead of designed on a
whiteboard.

```
input → [pre-hooks] → ( loop: provider ↔ tools ) → [post-hooks] → output
```

## Why this exists

Agent frameworks bundle the wrong opinions (provider-agnosticism you don't want,
graph DSLs you don't need, heavy dependency trees) and skip the hard parts
(per-conversation concurrency, abort-mid-stream, context decay). This library is
the opposite: the **harness** — loop, hooks, streaming, abort, replay-time
compaction, idempotency, supersede locking — with every integration point behind
a small interface.

## Packages

| Package                                  | What                                                                        | Runtime deps                                     |
| ---------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------ |
| `@thoughtminers/agent-runtime-core`      | Types, loop, hooks, context management, in-memory store/lock, mock provider | **none** (node builtins only — enforced by lint) |
| `@thoughtminers/agent-runtime-anthropic` | Claude adapter (streaming, prompt caching, tool wire format)                | peer: `@anthropic-ai/sdk`                        |
| `@thoughtminers/agent-runtime-postgres`  | Two-table Postgres store over **your** Prisma client                        | peer: `@prisma/client`                           |
| `examples/echo-bot`                      | REPL wiring every seam (private)                                            | —                                                |

## Quick taste

```ts
import { createAgent, createInMemoryLock } from '@thoughtminers/agent-runtime-core';
import { createAnthropicProvider } from '@thoughtminers/agent-runtime-anthropic';

const agent = createAgent<{ userId: string }>({
  provider: createAnthropicProvider(),
  model: process.env.MODEL!,
  system: ({ userId }) => `You are a terse assistant for ${userId}.`,
  tools: [
    {
      name: 'get_order_status',
      description: 'Look up one of THIS user’s orders. Call when asked about an order.',
      inputSchema: { type: 'object', properties: { orderCode: { type: 'string' } } },
      compaction: { mode: 'ttl', ttlMs: 60_000 }, // decays out of context after 1 min
      execute: async (input, step) => ({
        // step.ctx is YOUR opaque identity — auth scoping by construction
        result: await lookupOrder(step.ctx.userId, input),
      }),
    },
  ],
  preHooks: [guard], // blocking: can halt before the model is ever called
  postHooks: [redact, title], // streamable transform + async fire-and-forget
  lock: createInMemoryLock(), // newer message supersedes (aborts) the in-flight run
});

for await (const ev of agent.stream({ conversationId, text, ctx: { userId } })) {
  if (ev.type === 'text_delta') process.stdout.write(ev.text);
}
```

## The load-bearing ideas

- **Provider seam = one streaming turn.** The loop lives in core; a `Provider`
  implements a single generation as normalized events
  (`text_delta | tool_use_start | tool_input_delta | tool_use_end | message_done`).
  Adding a provider is one method, not a rewrite.
- **Hooks and tools are one primitive.** Harness-invoked (pre/post hooks) vs
  model-invoked (tools); `blocking` vs `async` (fire-and-forget, frozen state,
  errors swallowed — an async hook can never affect the run). Every step gets
  `llm()` at its own model, `store`, `ctx`, `signal`, `log`.
- **Buffer mode is derived, not configured.** A blocking _terminal_ post-hook
  (moderation/veto) forces collecting the stream before flushing; purely
  _streamable_ post-hooks (delta transforms) keep it live.
- **Context is reconstructed, never stored.** Append-only trace; per-tool
  `CompactionPolicy` (`keep | ttl | drop`) resolved by name at replay —
  retroactively tunable, no migration. Pure `lazyload` tools persist a stub and
  re-execute at replay. Whole-run packing newest→oldest to a token budget, with
  an optional tier-2 summarizer on overflow.
- **Two-table storage.** `messages` = what the human saw (with an idempotency
  key); `messages_llm` = what the model actually did (runId, tool calls +
  results, usage, latency). History feeds from the compacted replay.
- **Supersede concurrency.** `Lock.claim()` aborts the in-flight run for the
  same conversation; the newest message processes with the fullest context and
  the interrupted partial is persisted exactly as delivered.

## Develop

```bash
pnpm install
pnpm build         # tsc project references
pnpm lint          # incl. the core zero-dependency import guard
pnpm test          # 60 tests, no network (mock provider + in-memory store)

# env-gated extras
ANTHROPIC_API_KEY=... SMOKE_MODEL=<model-id> pnpm --filter @thoughtminers/agent-runtime-anthropic test
cd packages/store-postgres && docker compose up -d && \
  DATABASE_URL=postgresql://postgres:postgres@localhost:5439/simple_agent \
  pnpm exec prisma db push && DATABASE_URL=... pnpm test

# play with it
MODEL=<model-id> ANTHROPIC_API_KEY=... pnpm --filter echo-bot start
```

MIT
