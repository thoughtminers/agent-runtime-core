# agent-runtime-core

The zero-dependency agent harness: types, loop, hooks, streaming, abort,
replay-time context compaction, idempotency, and supersede locking. Imports
only `node:*` builtins (lint-enforced).

See the [repo README](../../README.md) for the full picture. Quick map:

| Export                                                             | Role                                                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `createAgent(config)` → `{ stream, handle }`                       | The orchestrator. `stream()` is the primitive; `handle()` collects it.                           |
| `Provider` / `ProviderEvent`                                       | The single-turn streaming seam an adapter implements.                                            |
| `Tool` / `LazyTool` (`CompactionPolicy`)                           | Model-invoked steps; compaction is data resolved by name at replay.                              |
| `PreHook` / `PostHook` (`blocking\|async`, `streamable\|terminal`) | Harness-invoked steps around the loop.                                                           |
| `ConversationStore` (+ `runStoreConformance`)                      | Two-table storage seam; the conformance suite is the executable spec for adapters.               |
| `Lock` / `Lease`                                                   | Per-conversation supersede serialization. `createInMemoryLock()` in-process; `noopLock` default. |
| `createMockProvider` / `createInMemoryStore`                       | Deterministic test doubles (used by this package's own 48 tests).                                |
| `replayTranscript` / `packByBudget` / `computeBudget`              | The context pipeline, exposed for advanced use.                                                  |

## Behavioral contracts worth knowing

- Abort (`AbortSignal`) is checked at every loop boundary and forwarded to the
  provider and every tool; on abort the delivered partial is persisted and the
  run's trace rows are flagged `interrupted`.
- Parallel tool calls are all answered before the next provider call, as
  consecutive `tool_result` turns (renderers group them into one message).
- The final allowed turn injects a wrap-up note and forces `toolChoice: 'none'`.
- An async hook's return value is ignored and its errors are swallowed+logged —
  it can never affect the run (TypeScript's void-assignability makes this a
  runtime guarantee rather than a compile error; the other illegal states are
  compile errors — see `test-d/`).
