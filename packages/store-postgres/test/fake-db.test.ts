import { test } from 'node:test';
import { runStoreConformance } from 'agent-runtime-core';
import {
  createPostgresStore,
  type MessageRow,
  type SimpleAgentDb,
  type TraceRow,
} from '../dist/index.js';

/**
 * A faithful in-memory fake of the two Prisma delegates — including the
 * P2002 unique violation on (conversationId, externalMessageId). Lets the
 * adapter's mapping + idempotency logic run the full conformance suite
 * without a database. The env-gated integration test covers the real thing.
 */
const createFakeDb = (): SimpleAgentDb => {
  const messages: MessageRow[] = [];
  const trace: TraceRow[] = [];
  let tick = 0;
  const nextDate = () => new Date(1_700_000_000_000 + tick++);

  return {
    simpleAgentMessage: {
      findFirst: async ({ where }) =>
        messages.find(
          (m) =>
            m.conversationId === where.conversationId &&
            m.externalMessageId === where.externalMessageId
        ) ?? null,
      findMany: async ({ where, take }) => {
        const rows = messages
          .filter((m) => m.conversationId === where.conversationId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        return take !== undefined ? rows.slice(0, take) : rows;
      },
      create: async ({ data }) => {
        if (
          data.externalMessageId !== null &&
          messages.some(
            (m) =>
              m.conversationId === data.conversationId &&
              m.externalMessageId === data.externalMessageId
          )
        ) {
          const err = new Error('Unique constraint failed') as Error & { code: string };
          err.code = 'P2002';
          throw err;
        }
        const row: MessageRow = { ...data, createdAt: nextDate() };
        messages.push(row);
        return row;
      },
    },
    simpleAgentTrace: {
      findMany: async ({ where, take }) => {
        const rows = trace
          .filter((t) => t.conversationId === where.conversationId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        return take !== undefined ? rows.slice(0, take) : rows;
      },
      create: async ({ data }) => {
        const row: TraceRow = {
          toolCalls: null,
          usage: null,
          ...data,
          createdAt: nextDate(),
        };
        trace.push(row);
        return row;
      },
      updateMany: async ({ where, data }) => {
        for (const row of trace) {
          if (row.runId === where.runId) row.interrupted = data.interrupted;
        }
        return { count: 0 };
      },
    },
  };
};

test('postgres adapter (fake db) passes the ConversationStore conformance suite', async () => {
  await runStoreConformance(createPostgresStore(createFakeDb()));
});
