import type { Usage } from './provider.js';

/**
 * Two-table storage model:
 *  - `messages`      — the user-facing transcript (what the human saw)
 *  - `messages_llm`  — the raw agent trace (what the model actually did)
 *
 * The trace is APPEND-ONLY: the wire payload is reconstructed at replay time
 * (with per-tool compaction policies applied); stored rows are never mutated
 * except the `interrupted` flag.
 */

export interface MessageRecord {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  /** Idempotency key (e.g. the transport's message id). UNIQUE per conversation. */
  externalMessageId: string | null;
  interrupted: boolean;
  createdAt: Date;
}

export interface ToolCallEntry {
  /** Provider tool-use id, verbatim. */
  id: string;
  /** Registry key — the compaction policy is resolved by this name at replay. */
  name: string;
  /** Verbatim model args. */
  input: unknown;
  /** Verbatim result, OR { lazy: true } stub (lazyload tools), OR null on error. */
  result: unknown;
  error: string | null;
}

/** One trace row. Tool results live embedded on the assistant row. */
export interface TraceRecord {
  id: string;
  conversationId: string;
  /** Groups every row produced for one inbound message. */
  runId: string;
  role: 'user' | 'assistant';
  content: string | null;
  toolCalls: ToolCallEntry[] | null;
  model: string | null;
  usage: Usage | null;
  latencyMs: number | null;
  interrupted: boolean;
  createdAt: Date;
}

export type NewMessage = Omit<MessageRecord, 'id' | 'createdAt' | 'interrupted'> & {
  interrupted?: boolean;
};
export type NewTrace = Omit<TraceRecord, 'id' | 'createdAt' | 'interrupted'> & {
  interrupted?: boolean;
};

export interface ConversationHistory {
  /** Chronological user-facing messages. */
  messages: MessageRecord[];
  /** Chronological trace rows (all runs). */
  trace: TraceRecord[];
}

export interface ConversationStore {
  /** Idempotency: has this external message id already been ingested? */
  seen(conversationId: string, externalMessageId: string): Promise<boolean>;

  /**
   * Append a user-facing message. MUST be idempotent on
   * (conversationId, externalMessageId): a duplicate returns the existing row.
   */
  appendMessage(msg: NewMessage): Promise<MessageRecord>;

  /** Append one raw trace row (append-only). */
  appendTrace(row: NewTrace): Promise<TraceRecord>;

  /** Everything the replay pipeline needs, chronological. */
  loadHistory(conversationId: string, opts?: { limit?: number }): Promise<ConversationHistory>;

  /** Flag every row of an aborted run (rows were written incrementally). */
  markRunInterrupted(runId: string): Promise<void>;
}
