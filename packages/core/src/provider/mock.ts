import type { GenerateRequest, Provider, ProviderEvent } from '../types/provider.js';
import { newAbortError } from '../util.js';

export interface MockProviderOptions {
  /** One scripted event array per expected stream() call, consumed in order. */
  turns: ProviderEvent[][];
  /** Optional delay before each event — makes mid-stream aborts testable. */
  delayMs?: number;
  contextWindow?: number;
}

export interface MockProvider extends Provider {
  /** Every GenerateRequest received, in order — assert loop behavior on these. */
  readonly requests: GenerateRequest[];
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(newAbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(newAbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Deterministic scripted provider for tests. */
export const createMockProvider = (options: MockProviderOptions): MockProvider => {
  const scripts = [...options.turns];
  const requests: GenerateRequest[] = [];

  return {
    name: 'mock',
    requests,
    contextWindow: () => options.contextWindow ?? 100_000,
    stream: (req, opts) => {
      requests.push(structuredClone(req));
      const script = scripts.shift();
      if (!script) throw new Error('MockProvider: no scripted turn left for this stream() call');
      const signal = opts?.signal;

      return (async function* () {
        for (const ev of script) {
          if (options.delayMs) await sleep(options.delayMs, signal);
          else if (signal?.aborted) throw newAbortError();
          yield ev;
        }
      })();
    },
  };
};

/** Convenience builders for scripted turns. */
export const mockTextTurn = (text: string, stopReason: 'end_turn' | 'refusal' = 'end_turn') =>
  [
    { type: 'text_delta', text } satisfies ProviderEvent,
    {
      type: 'message_done',
      stopReason,
      usage: { inputTokens: 10, outputTokens: 5 },
    } satisfies ProviderEvent,
  ] as ProviderEvent[];

export const mockToolTurn = (
  calls: Array<{ id: string; name: string; input: unknown }>,
  text = ''
): ProviderEvent[] => {
  const events: ProviderEvent[] = [];
  if (text) events.push({ type: 'text_delta', text });
  for (const call of calls) {
    events.push({ type: 'tool_use_start', id: call.id, name: call.name });
    events.push({ type: 'tool_input_delta', json: JSON.stringify(call.input) });
    events.push({ type: 'tool_use_end' });
  }
  events.push({
    type: 'message_done',
    stopReason: 'tool_use',
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  return events;
};
