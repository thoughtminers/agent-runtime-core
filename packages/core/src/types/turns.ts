/**
 * Provider-neutral message model. Providers render these turns to their own
 * wire format (Anthropic content blocks, OpenAI chat messages, ...) — the core
 * never sees a provider wire shape.
 */

/** Loose JSON Schema, passed verbatim to the provider wire format. */
export type JSONSchema = Record<string, unknown>;

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string } // base64
  | Record<string, unknown>; // pass-through escape hatch for provider-specific parts

export interface ToolCall {
  /** Provider tool-use id, verbatim. */
  id: string;
  name: string;
  input: unknown;
}

/**
 * One provider-neutral conversational turn.
 *
 * Notes:
 * - `system` turns never appear in GenerateRequest.turns (system travels
 *   separately); the variant exists for pipeline-internal representations.
 * - Consecutive `tool_result` turns belong to ONE model round-trip; renderers
 *   MUST group them into a single user-side message (parallel-tool contract).
 */
export type Turn =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool_result'; toolUseId: string; content: string | ContentPart[]; isError?: boolean };
