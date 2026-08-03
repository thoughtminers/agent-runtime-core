import type Anthropic from '@anthropic-ai/sdk';
import type { ProviderEvent, StopReason, Usage } from '@thoughtminers/agent-runtime-core';

const mapStopReason = (reason: string | null): StopReason => {
  switch (reason) {
    case 'end_turn':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
};

const mapUsage = (usage: Anthropic.Usage): Usage => ({
  inputTokens: usage.input_tokens,
  outputTokens: usage.output_tokens,
  ...(usage.cache_read_input_tokens != null
    ? { cacheReadInputTokens: usage.cache_read_input_tokens }
    : {}),
  ...(usage.cache_creation_input_tokens != null
    ? { cacheCreationInputTokens: usage.cache_creation_input_tokens }
    : {}),
});

const abortError = (): Error => {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
};

/**
 * The minimal structural surface this adapter needs from the SDK stream —
 * lets tests inject a fake without depending on SDK internals.
 */
export interface AnthropicMessageStreamLike extends AsyncIterable<Anthropic.MessageStreamEvent> {
  finalMessage(): Promise<Anthropic.Message>;
}

/**
 * Normalize the Anthropic SSE event stream to ProviderEvents.
 * A plain pull-based async generator suffices — the harness owns the loop.
 */
export async function* normalizeStream(
  stream: AnthropicMessageStreamLike,
  signal?: AbortSignal
): AsyncGenerator<ProviderEvent> {
  let inToolBlock = false;
  try {
    for await (const event of stream) {
      switch (event.type) {
        case 'content_block_start':
          if (event.content_block.type === 'tool_use') {
            inToolBlock = true;
            yield {
              type: 'tool_use_start',
              id: event.content_block.id,
              name: event.content_block.name,
            };
          }
          break;
        case 'content_block_delta':
          if (event.delta.type === 'text_delta') {
            yield { type: 'text_delta', text: event.delta.text };
          } else if (event.delta.type === 'input_json_delta') {
            yield { type: 'tool_input_delta', json: event.delta.partial_json };
          }
          break;
        case 'content_block_stop':
          if (inToolBlock) {
            inToolBlock = false;
            yield { type: 'tool_use_end' };
          }
          break;
        default:
          break;
      }
    }
    const final = await stream.finalMessage();
    yield {
      type: 'message_done',
      stopReason: mapStopReason(final.stop_reason),
      usage: mapUsage(final.usage),
    };
  } catch (err) {
    // Normalize the SDK's APIUserAbortError (or any error observed after the
    // caller aborted) to the harness AbortError contract.
    if (signal?.aborted || (err instanceof Error && err.name === 'APIUserAbortError')) {
      throw abortError();
    }
    throw err;
  }
}
