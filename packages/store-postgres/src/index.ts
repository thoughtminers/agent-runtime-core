import { randomUUID } from 'node:crypto';
import type {
  ConversationStore,
  MessageRecord,
  ToolCallEntry,
  TraceRecord,
  Usage,
} from '@thoughtminers/agent-runtime-core';

/**
 * Postgres ConversationStore over the CONSUMER'S Prisma client — this adapter
 * never owns a PrismaClient (no second connection pool, your migrations).
 * Copy the models from ../prisma/schema.prisma into your schema, run your
 * migration, then:
 *
 *   const store = createPostgresStore(prisma);
 *
 * `SimpleAgentDb` is structural: any object exposing the two generated model
 * delegates satisfies it.
 */

export interface MessageRow {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  externalMessageId: string | null;
  interrupted: boolean;
  createdAt: Date;
}

export interface TraceRow {
  id: string;
  conversationId: string;
  runId: string;
  role: string;
  content: string | null;
  toolCalls: unknown;
  model: string | null;
  usage: unknown;
  latencyMs: number | null;
  interrupted: boolean;
  createdAt: Date;
}

export interface SimpleAgentDb {
  simpleAgentMessage: {
    findFirst(args: {
      where: { conversationId: string; externalMessageId: string };
    }): Promise<MessageRow | null>;
    findMany(args: {
      where: { conversationId: string };
      orderBy: { createdAt: 'asc' };
      take?: number;
    }): Promise<MessageRow[]>;
    create(args: {
      data: {
        id: string;
        conversationId: string;
        role: string;
        content: string;
        externalMessageId: string | null;
        interrupted: boolean;
      };
    }): Promise<MessageRow>;
  };
  simpleAgentTrace: {
    findMany(args: {
      where: { conversationId: string };
      orderBy: { createdAt: 'asc' };
      take?: number;
    }): Promise<TraceRow[]>;
    create(args: {
      data: {
        id: string;
        conversationId: string;
        runId: string;
        role: string;
        content: string | null;
        toolCalls?: unknown;
        model: string | null;
        usage?: unknown;
        latencyMs: number | null;
        interrupted: boolean;
      };
    }): Promise<TraceRow>;
    updateMany(args: {
      where: { runId: string };
      data: { interrupted: boolean };
    }): Promise<unknown>;
  };
}

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';

const toMessageRecord = (row: MessageRow): MessageRecord => ({
  id: row.id,
  conversationId: row.conversationId,
  role: row.role as MessageRecord['role'],
  content: row.content,
  externalMessageId: row.externalMessageId,
  interrupted: row.interrupted,
  createdAt: row.createdAt,
});

const toTraceRecord = (row: TraceRow): TraceRecord => ({
  id: row.id,
  conversationId: row.conversationId,
  runId: row.runId,
  role: row.role as TraceRecord['role'],
  content: row.content,
  toolCalls: (row.toolCalls ?? null) as ToolCallEntry[] | null,
  model: row.model,
  usage: (row.usage ?? null) as Usage | null,
  latencyMs: row.latencyMs,
  interrupted: row.interrupted,
  createdAt: row.createdAt,
});

export const createPostgresStore = (db: SimpleAgentDb): ConversationStore => ({
  seen: async (conversationId, externalMessageId) =>
    (await db.simpleAgentMessage.findFirst({ where: { conversationId, externalMessageId } })) !==
    null,

  appendMessage: async (msg) => {
    try {
      const row = await db.simpleAgentMessage.create({
        data: {
          id: randomUUID(),
          conversationId: msg.conversationId,
          role: msg.role,
          content: msg.content,
          externalMessageId: msg.externalMessageId,
          interrupted: msg.interrupted ?? false,
        },
      });
      return toMessageRecord(row);
    } catch (err) {
      // Idempotency: the (conversationId, externalMessageId) unique index
      // fired — a concurrent or repeated delivery. Return the existing row.
      if (isUniqueViolation(err) && msg.externalMessageId !== null) {
        const existing = await db.simpleAgentMessage.findFirst({
          where: {
            conversationId: msg.conversationId,
            externalMessageId: msg.externalMessageId,
          },
        });
        if (existing) return toMessageRecord(existing);
      }
      throw err;
    }
  },

  appendTrace: async (row) => {
    const created = await db.simpleAgentTrace.create({
      data: {
        id: randomUUID(),
        conversationId: row.conversationId,
        runId: row.runId,
        role: row.role,
        content: row.content,
        // Omit null JSON columns so they default to SQL NULL.
        ...(row.toolCalls !== null ? { toolCalls: row.toolCalls } : {}),
        model: row.model,
        ...(row.usage !== null ? { usage: row.usage } : {}),
        latencyMs: row.latencyMs,
        interrupted: row.interrupted ?? false,
      },
    });
    return toTraceRecord(created);
  },

  loadHistory: async (conversationId, opts) => {
    const [messages, trace] = await Promise.all([
      db.simpleAgentMessage.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'asc' },
        ...(opts?.limit !== undefined ? { take: opts.limit } : {}),
      }),
      db.simpleAgentTrace.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'asc' },
        ...(opts?.limit !== undefined ? { take: opts.limit * 4 } : {}),
      }),
    ]);
    return {
      messages: messages.map(toMessageRecord),
      trace: trace.map(toTraceRecord),
    };
  },

  markRunInterrupted: async (runId) => {
    await db.simpleAgentTrace.updateMany({ where: { runId }, data: { interrupted: true } });
  },
});
