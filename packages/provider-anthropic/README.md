# agent-runtime-anthropic

Claude adapter for `agent-runtime-core`. Wraps `@anthropic-ai/sdk`
(peer dependency) `messages.stream()` into the harness's normalized
`ProviderEvent` stream.

```ts
import { createAnthropicProvider } from 'agent-runtime-anthropic';

const provider = createAnthropicProvider({
  // all optional:
  apiKey: process.env.ANTHROPIC_API_KEY, // or ambient env / your own client
  contextWindows: { '<model-id>': 200_000 }, // model ids are config, never hardcoded
  defaultContextWindow: 200_000,
  extraParams: { thinking: { type: 'adaptive' } }, // merged verbatim into every request
});
```

What it does for you:

- **Prompt caching**: `cache_control: { type: 'ephemeral' }` on the last system
  block, every request.
- **Parallel-tool contract**: consecutive `tool_result` turns render into ONE
  user message (the API rejects orphans).
- **Abort**: the caller's `AbortSignal` aborts the underlying request; errors
  normalize to the harness `AbortError` contract.
- **Stop reasons**: `end_turn / tool_use / max_tokens / stop_sequence / refusal`
  map 1:1; anything else (e.g. `pause_turn`) becomes `other`.
- **Usage**: input/output + cache read/write tokens surfaced on `turn_end`.

Testing: unit tests run against a fake SDK stream (no network). The smoke test
is env-gated: `ANTHROPIC_API_KEY=... SMOKE_MODEL=<model-id> pnpm test`.
