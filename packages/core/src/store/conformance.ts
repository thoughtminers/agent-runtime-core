import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ConversationStore } from '../types/store.js';

/**
 * Executable specification for ConversationStore adapters. Runner-agnostic:
 * call it from any test framework — it throws on the first violation.
 * Uses fresh random conversation ids so it can run repeatedly against a
 * shared database.
 */
export const runStoreConformance = async (store: ConversationStore): Promise<void> => {
  const conv = `conf-${randomUUID()}`;

  // ── seen(): false before, true after ─────────────────────────────────────
  assert.equal(await store.seen(conv, 'ext-1'), false, 'seen() must be false before ingest');
  const first = await store.appendMessage({
    conversationId: conv,
    role: 'user',
    content: 'hello',
    externalMessageId: 'ext-1',
  });
  assert.ok(first.id, 'appendMessage must assign an id');
  assert.ok(first.createdAt instanceof Date, 'appendMessage must stamp createdAt');
  assert.equal(first.interrupted, false, 'interrupted defaults to false');
  assert.equal(await store.seen(conv, 'ext-1'), true, 'seen() must be true after ingest');
  assert.equal(await store.seen(conv, 'ext-other'), false, 'seen() is per-externalMessageId');

  // ── appendMessage idempotency on (conversationId, externalMessageId) ─────
  const dup = await store.appendMessage({
    conversationId: conv,
    role: 'user',
    content: 'hello again (should be ignored)',
    externalMessageId: 'ext-1',
  });
  assert.equal(dup.id, first.id, 'duplicate externalMessageId must return the existing row');
  assert.equal(dup.content, 'hello', 'duplicate must not overwrite content');

  // Same externalMessageId in ANOTHER conversation is a different message.
  const otherConv = `conf-${randomUUID()}`;
  const crossConv = await store.appendMessage({
    conversationId: otherConv,
    role: 'user',
    content: 'other conversation',
    externalMessageId: 'ext-1',
  });
  assert.notEqual(crossConv.id, first.id, 'uniqueness is scoped per conversation');

  // Null externalMessageId rows never dedupe.
  const anonA = await store.appendMessage({
    conversationId: conv,
    role: 'assistant',
    content: 'reply',
    externalMessageId: null,
  });
  const anonB = await store.appendMessage({
    conversationId: conv,
    role: 'assistant',
    content: 'reply',
    externalMessageId: null,
  });
  assert.notEqual(anonA.id, anonB.id, 'null externalMessageId rows are always distinct');

  // ── trace: append + chronological loadHistory ────────────────────────────
  const runA = `run-${randomUUID()}`;
  const runB = `run-${randomUUID()}`;
  await store.appendTrace({
    conversationId: conv,
    runId: runA,
    role: 'user',
    content: 'q1',
    toolCalls: null,
    model: null,
    usage: null,
    latencyMs: null,
  });
  await store.appendTrace({
    conversationId: conv,
    runId: runA,
    role: 'assistant',
    content: 'a1',
    toolCalls: [{ id: 't1', name: 'lookup', input: { q: 1 }, result: { ok: true }, error: null }],
    model: 'test-model',
    usage: { inputTokens: 10, outputTokens: 5 },
    latencyMs: 42,
  });
  await store.appendTrace({
    conversationId: conv,
    runId: runB,
    role: 'user',
    content: 'q2',
    toolCalls: null,
    model: null,
    usage: null,
    latencyMs: null,
  });

  const history = await store.loadHistory(conv);
  assert.deepEqual(
    history.trace.map((t) => [t.runId, t.role]),
    [
      [runA, 'user'],
      [runA, 'assistant'],
      [runB, 'user'],
    ],
    'trace must be chronological'
  );
  const withTools = history.trace[1]!;
  assert.deepEqual(withTools.toolCalls, [
    { id: 't1', name: 'lookup', input: { q: 1 }, result: { ok: true }, error: null },
  ]);
  assert.deepEqual(withTools.usage, { inputTokens: 10, outputTokens: 5 });
  assert.equal(withTools.latencyMs, 42);
  assert.ok(
    history.messages.every((m) => m.conversationId === conv),
    'loadHistory must not leak other conversations'
  );

  // ── markRunInterrupted: flags exactly that run ───────────────────────────
  await store.markRunInterrupted(runA);
  const after = await store.loadHistory(conv);
  for (const row of after.trace) {
    assert.equal(
      row.interrupted,
      row.runId === runA,
      `interrupted flag wrong for run ${row.runId}`
    );
  }
};
