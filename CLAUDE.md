# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`agent-runtime` (arc) — a TypeScript **agent harness**, not a framework. Zero-dependency core,
streaming-native, provider/storage-agnostic via small interfaces.

```
input → [pre-hooks] → ( loop: provider ↔ tools ) → [post-hooks] → output
```

pnpm workspace monorepo, ESM-only, Node >= 24, TypeScript project references.

| Package                       | Runtime deps                                  |
| ----------------------------- | --------------------------------------------- |
| `packages/core`               | **none** (node builtins only — lint-enforced) |
| `packages/provider-anthropic` | peer `@anthropic-ai/sdk`                      |
| `packages/store-postgres`     | peer `@prisma/client`                         |
| `examples/echo-bot`           | private REPL wiring every seam                |

## Commands

```bash
pnpm build            # tsc --build (project references)
pnpm lint             # incl. the core zero-dependency import guard
pnpm test             # build, then each package's tests sequentially
pnpm format           # prettier --write .
```

**Tests import from `../dist/index.js`, not from `src/`.** A source edit is invisible to tests
until you rebuild. Always `pnpm build` (or `tsc --build` in the package) before running tests
directly.

Single test file — run from inside the package, after a build:

```bash
cd packages/core && node --test test/loop.test.ts
node --test --test-name-pattern 'supersede' test/supersede.test.ts
```

Type-level tests (compile-only, assert illegal states are compile errors):

```bash
cd packages/core && tsc -p tsconfig.typetest.json
```

Env-gated suites (skip silently without the env var):

```bash
ANTHROPIC_API_KEY=... SMOKE_MODEL=<model-id> pnpm --filter agent-runtime-anthropic test
cd packages/store-postgres && docker compose up -d && \
  DATABASE_URL=postgresql://postgres:postgres@localhost:5439/simple_agent pnpm exec prisma db push && \
  DATABASE_URL=postgresql://postgres:postgres@localhost:5439/simple_agent pnpm test

MODEL=<model-id> ANTHROPIC_API_KEY=... pnpm --filter echo-bot start
```

## Architecture

`createAgent()` (`packages/core/src/agent.ts`) is the orchestrator; everything else is a seam it
composes. `stream()` is the primitive (`AsyncIterable<AgentEvent>`), `handle()` = collect(stream()).

**Provider seam = exactly one generation turn.** `Provider.stream()` yields a five-member
normalized union (`text_delta | tool_use_start | tool_input_delta | tool_use_end | message_done`).
The loop lives in core (`src/loop.ts`) — adding a provider is one method, never a rewrite.
Providers must honour `AbortSignal` and throw an error with `name === 'AbortError'`.

**Hooks and tools are one primitive**, split on two axes encoded in the type unions
(`src/types/hooks.ts`):

- harness-invoked (`PreHook`/`PostHook`) vs model-invoked (`Tool`)
- `blocking` (sequential, can `halt`/`replace`, shared mutable `state`) vs `async` (fire-and-forget,
  frozen `structuredClone` state, return ignored, errors swallowed+logged — can never affect the run)
- post-hooks add `streamable` (delta transformer on the live stream) vs `terminal` (needs full text)

**Buffer mode is derived, not configured.** `planPostHooks()` sets `bufferMode` iff a blocking
terminal post-hook exists; the agent then withholds deltas until terminal hooks have run. Don't add
a config flag for this.

**Context is reconstructed, never stored** (`src/context/replay.ts`, three passes):

1. `expandAndCompact` — trace rows → turns, applying each tool's `CompactionPolicy`
   (`keep | ttl | drop`) **resolved by tool name at replay time**. Policies are pure data, so
   changing a TTL retroactively rewrites all history with no migration.
2. `rehydrate` — re-executes `lazyload: true` tools whose stub survived compaction. These get the
   reduced `LazyContext` (no `state`, `store`, or `llm`) — purity enforced as far as types allow.
3. `packByBudget` — includes **whole run blocks** newest→oldest until the budget is exhausted.
   Whole-block granularity keeps each assistant `toolCalls` turn paired with its `tool_result` turns
   (providers reject orphans). The newest block is always kept, even over budget.

Overflow beyond that goes to the optional tier-2 `summarizer`. Budget = window − system − output
reservation − tool schemas − 10% safety margin, with a deliberately cheap chars/4 estimator.

**Two-table storage** (`ConversationStore`): `messages` = what the human saw (with an idempotency
key on `externalMessageId`); `messages_llm` = the append-only trace of what the model did (runId,
tool calls + results, usage, latency). Only the `interrupted` flag is ever mutated.
`runStoreConformance()` is the executable spec — **any new store adapter must pass it**.

**Supersede concurrency**: `Lock.claim(conversationId)` aborts the in-flight run for that
conversation so the newest message answers with the fullest context. The inbound message is
persisted _before_ claiming the lock precisely so the superseding run sees it. On abort, the partial
text actually delivered to the consumer is persisted — history must match what the user saw.

## Constraints to preserve

- **`packages/core` is zero-dependency.** An eslint `no-restricted-imports` rule in
  `eslint.config.js` rejects any import that isn't `node:*` or relative. Never relax it.
- **Model ids are never hardcoded** — they come from config/env everywhere, including tests
  (`SMOKE_MODEL`, `MODEL`) and `contextWindows` in the Anthropic adapter.
- **Prefer making illegal states unrepresentable** over runtime validation. The hook/tool unions and
  `LazyContext` exist for this; `packages/core/test-d/types.test-d.ts` pins which misuses must fail
  to compile. New API surface should extend that file.
- `verbatimModuleSyntax` + `consistent-type-imports`: type-only imports must use `import type`.
  `erasableSyntaxOnly` bans enums, namespaces, and parameter properties.
- `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` are on — hence the
  `...(x !== undefined ? { x } : {})` spread idiom and `!` after indexing throughout.
- Relative imports carry the `.js` extension (NodeNext).
- Keep `packages/core/src/index.ts` the single public surface; consumers import from the package
  root, never deep paths.

## If the repo moves or a workspace is renamed

The workspace member list lives in four places that must agree: `pnpm-workspace.yaml`, the
`references` array in the root `tsconfig.json`, the root `lint` glob in `package.json`, and the
directory name itself. A mismatch surfaces as `TS5083: Cannot read file .../tsconfig.json` from
`tsc --build`, and pnpm silently reporting fewer workspace projects than exist. After any such
change: `pnpm install` (relinks workspace deps), delete stale `*.tsbuildinfo` and the orphaned
package's `node_modules`, then `pnpm build`.
