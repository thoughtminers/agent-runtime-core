import type { CollectedTurn, GenerateRequest, Provider, ProviderEvent } from './types/provider.js';
import type { ToolCall } from './types/turns.js';

interface PendingToolCall {
  id: string;
  name: string;
  json: string;
}

const finalizeToolCall = (pending: PendingToolCall): ToolCall => {
  let input: unknown = {};
  if (pending.json.trim() !== '') {
    try {
      input = JSON.parse(pending.json);
    } catch {
      // Malformed streamed JSON: fall back to {} so the loop can still answer
      // the call with an error-shaped tool_result instead of crashing.
      input = {};
    }
  }
  return { id: pending.id, name: pending.name, input };
};

/**
 * Pass provider events through (so a caller can re-yield deltas live) while
 * accumulating them; RETURNS the CollectedTurn when the stream ends.
 */
export async function* collectStreaming(
  events: AsyncIterable<ProviderEvent>
): AsyncGenerator<ProviderEvent, CollectedTurn> {
  let text = '';
  const toolCalls: ToolCall[] = [];
  let pending: PendingToolCall | null = null;
  let stopReason: CollectedTurn['stopReason'] = 'other';
  let usage: CollectedTurn['usage'];

  for await (const ev of events) {
    switch (ev.type) {
      case 'text_delta':
        text += ev.text;
        break;
      case 'tool_use_start':
        // A provider that omits tool_use_end between calls still finalizes.
        if (pending) toolCalls.push(finalizeToolCall(pending));
        pending = { id: ev.id, name: ev.name, json: '' };
        break;
      case 'tool_input_delta':
        if (pending) pending.json += ev.json;
        break;
      case 'tool_use_end':
        if (pending) {
          toolCalls.push(finalizeToolCall(pending));
          pending = null;
        }
        break;
      case 'message_done':
        stopReason = ev.stopReason;
        if (ev.usage) usage = ev.usage;
        break;
    }
    yield ev;
  }
  if (pending) toolCalls.push(finalizeToolCall(pending));

  return usage ? { text, toolCalls, stopReason, usage } : { text, toolCalls, stopReason };
}

/** Drain a provider event stream into a CollectedTurn (buffered). */
export const collect = async (events: AsyncIterable<ProviderEvent>): Promise<CollectedTurn> => {
  const collector = collectStreaming(events);
  while (true) {
    const next = await collector.next();
    if (next.done) return next.value;
  }
};

/** One buffered generation turn: collect(provider.stream(req)). */
export const generate = async (
  provider: Provider,
  req: GenerateRequest,
  opts?: { signal?: AbortSignal }
): Promise<CollectedTurn> => collect(provider.stream(req, opts));
