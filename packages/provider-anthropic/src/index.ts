import Anthropic from '@anthropic-ai/sdk';
import type { GenerateRequest, Provider } from '@thoughtminers/agent-runtime-core';
import { renderSystem, renderToolChoice, renderTools, renderTurns } from './render.js';
import { normalizeStream, type AnthropicMessageStreamLike } from './stream.js';

export interface AnthropicProviderOptions {
  /** Bring your own client (also how tests inject a fake). */
  client?: Anthropic;
  /** Used only when no client is given; falls back to ANTHROPIC_API_KEY. */
  apiKey?: string;
  /** Per-model context windows (tokens). Model ids are CONFIG, never hardcoded. */
  contextWindows?: Record<string, number>;
  /** Fallback window for models not in the map. Default 200_000. */
  defaultContextWindow?: number;
  /**
   * Provider-specific request params merged verbatim into every call
   * (e.g. thinking/effort knobs) — keeps the core seam provider-neutral.
   */
  extraParams?: Record<string, unknown>;
}

export const createAnthropicProvider = (options: AnthropicProviderOptions = {}): Provider => {
  // Lazy client: importing/configuring the provider must not require the key.
  let client: Anthropic | undefined = options.client;
  const getClient = (): Anthropic => {
    if (!client) {
      client = new Anthropic(options.apiKey !== undefined ? { apiKey: options.apiKey } : {});
    }
    return client;
  };

  return {
    name: 'anthropic',
    contextWindow: (model) =>
      options.contextWindows?.[model] ?? options.defaultContextWindow ?? 200_000,
    stream: (req: GenerateRequest, opts) => {
      const system = renderSystem(req.system);
      const tools = renderTools(req.tools);
      const toolChoice = tools ? renderToolChoice(req.toolChoice) : undefined;

      const params = {
        model: req.model,
        max_tokens: req.maxOutputTokens,
        messages: renderTurns(req.turns),
        ...(system ? { system } : {}),
        ...(tools ? { tools } : {}),
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
        ...(options.extraParams ?? {}),
      } as Anthropic.MessageStreamParams;

      const stream = getClient().messages.stream(
        params,
        opts?.signal ? { signal: opts.signal } : {}
      ) as AnthropicMessageStreamLike;

      return normalizeStream(stream, opts?.signal);
    },
  };
};

export { normalizeStream, type AnthropicMessageStreamLike } from './stream.js';
export { renderSystem, renderToolChoice, renderTools, renderTurns } from './render.js';
