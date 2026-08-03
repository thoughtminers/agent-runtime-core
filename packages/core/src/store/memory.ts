import { randomUUID } from 'node:crypto';
import type {
  ConversationHistory,
  ConversationStore,
  MessageRecord,
  NewMessage,
  NewTrace,
  TraceRecord,
} from '../types/store.js';

/**
 * In-memory ConversationStore: the reference implementation for tests/dev and
 * the executable specification for real adapters (see the conformance suite).
 * `now` is injectable so TTL-compaction tests can share one fake clock with
 * the agent (a real DB's now() and the app clock agree the same way).
 */
export const createInMemoryStore = (opts?: { now?: () => number }): ConversationStore => {
  const now = opts?.now ?? Date.now;
  const messages = new Map<string, MessageRecord[]>();
  const trace = new Map<string, TraceRecord[]>();

  const messagesOf = (conversationId: string): MessageRecord[] => {
    let list = messages.get(conversationId);
    if (!list) {
      list = [];
      messages.set(conversationId, list);
    }
    return list;
  };
  const traceOf = (conversationId: string): TraceRecord[] => {
    let list = trace.get(conversationId);
    if (!list) {
      list = [];
      trace.set(conversationId, list);
    }
    return list;
  };

  return {
    seen: async (conversationId, externalMessageId) =>
      messagesOf(conversationId).some((m) => m.externalMessageId === externalMessageId),

    appendMessage: async (msg: NewMessage) => {
      const list = messagesOf(msg.conversationId);
      if (msg.externalMessageId != null) {
        const existing = list.find((m) => m.externalMessageId === msg.externalMessageId);
        if (existing) return existing; // idempotent on the unique key
      }
      const record: MessageRecord = {
        id: randomUUID(),
        conversationId: msg.conversationId,
        role: msg.role,
        content: msg.content,
        externalMessageId: msg.externalMessageId,
        interrupted: msg.interrupted ?? false,
        createdAt: new Date(now()),
      };
      list.push(record);
      return record;
    },

    appendTrace: async (row: NewTrace) => {
      const record: TraceRecord = {
        id: randomUUID(),
        conversationId: row.conversationId,
        runId: row.runId,
        role: row.role,
        content: row.content,
        toolCalls: row.toolCalls,
        model: row.model,
        usage: row.usage,
        latencyMs: row.latencyMs,
        interrupted: row.interrupted ?? false,
        createdAt: new Date(now()),
      };
      traceOf(row.conversationId).push(record);
      return record;
    },

    loadHistory: async (conversationId, opts): Promise<ConversationHistory> => {
      const all = {
        messages: [...messagesOf(conversationId)],
        trace: [...traceOf(conversationId)],
      };
      if (opts?.limit != null) {
        all.messages = all.messages.slice(-opts.limit);
        // Trace rows are bounded by the run ids still present in messages —
        // keep it simple in-memory: same tail count heuristic.
        all.trace = all.trace.slice(-opts.limit * 4);
      }
      return all;
    },

    markRunInterrupted: async (runId) => {
      for (const rows of trace.values()) {
        for (const row of rows) {
          if (row.runId === runId) row.interrupted = true;
        }
      }
      for (const rows of messages.values()) {
        // Messages don't carry runId; interrupted flags on messages are set at
        // write time by the agent (partial responses). Nothing to do here.
        void rows;
      }
    },
  };
};
