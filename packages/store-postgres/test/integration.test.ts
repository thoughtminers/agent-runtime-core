import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runStoreConformance } from 'agent-runtime-core';
import { createPostgresStore, type SimpleAgentDb } from '../dist/index.js';

/**
 * Env-gated integration test against a real Postgres.
 * Setup (from this package):
 *   docker compose up -d
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5439/simple_agent pnpm exec prisma db push
 *   DATABASE_URL=... pnpm test
 */
const databaseUrl = process.env.DATABASE_URL;

test(
  'postgres store passes the ConversationStore conformance suite',
  { skip: !databaseUrl && 'set DATABASE_URL (see docker-compose.yml)' },
  async () => {
    // Dynamic import: @prisma/client only exists after `prisma generate`.
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();
    try {
      const store = createPostgresStore(prisma as unknown as SimpleAgentDb);
      await runStoreConformance(store);

      // Concurrency idempotency race: same externalMessageId inserted twice
      // in parallel must yield exactly one row.
      const store2 = createPostgresStore(prisma as unknown as SimpleAgentDb);
      const conv = `race-${Date.now()}`;
      const [a, b] = await Promise.all([
        store.appendMessage({
          conversationId: conv,
          role: 'user',
          content: 'racer',
          externalMessageId: 'same-id',
        }),
        store2.appendMessage({
          conversationId: conv,
          role: 'user',
          content: 'racer',
          externalMessageId: 'same-id',
        }),
      ]);
      assert.equal(a.id, b.id, 'concurrent duplicate deliveries must converge on one row');
    } finally {
      await prisma.$disconnect();
    }
  }
);
