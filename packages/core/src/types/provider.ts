import type { JSONSchema, ToolCall, Turn } from './turns.js';

/**
 * Normalized stop reasons. Adapters map their wire values into this set;
 * anything unmappable becomes 'other'.
 */
export type StopReason =
  'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'refusal' | 'other';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/**
 * The normalized event union every provider emits. Proven shape: the same
 * five events cleanly cover Anthropic, OpenAI-family, and Gemini streaming.
 */
export type ProviderEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_input_delta'; json: string }
  | { type: 'tool_use_end' }
  | { type: 'message_done'; stopReason: StopReason; usage?: Usage };

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

export interface GenerateRequest {
  model: string;
  maxOutputTokens: number;
  system?: string;
  /** Never contains role:'system' turns — system travels separately. */
  turns: Turn[];
  tools?: ToolSpec[];
  toolChoice?: 'auto' | 'any' | 'none';
}

/**
 * The provider seam: ONE generation turn as a normalized event stream.
 * The harness owns the loop; a provider only knows how to generate once.
 */
export interface Provider {
  readonly name: string;
  /** Total context window (tokens) for a model id. */
  contextWindow(model: string): number;
  /** Optional accurate counter; the harness falls back to chars/4. */
  countTokens?(text: string, model: string): number | Promise<number>;
  /**
   * MUST respect `signal`: abort the upstream request and throw an error with
   * name === 'AbortError'.
   */
  stream(req: GenerateRequest, opts?: { signal?: AbortSignal }): AsyncIterable<ProviderEvent>;
}

/** Result of collecting one provider stream. */
export interface CollectedTurn {
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  usage?: Usage;
}
