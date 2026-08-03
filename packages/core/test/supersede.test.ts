import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createAgent,
  createInMemoryLock,
  createInMemoryStore,
  createMockProvider,
  mockTextTurn,
  silentLogger,
} from '../dist/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('lock: a new claim aborts the current holder', async () => {
  const lock = createInMemoryLock();
  const first = await lock.claim('c1');
  assert.equal(first.signal.aborted, false);

  const secondP = lock.claim('c1'); // supersedes
  assert.equal(first.signal.aborted, true);

  await first.release();
  const second = await secondP;
  assert.equal(second.signal.aborted, false);
  await second.release();
});

test('supersede: newer message aborts the in-flight run; new run sees the partial', async () => {
  const provider = createMockProvider({
    turns: [mockTextTurn('Partial answer being written'), mockTextTurn('Full answer to both.')],
    delayMs: 10,
  });
  const store = createInMemoryStore();
  const agent = createAgent({
    provider,
    model: 'm',
    system: 's',
    store,
    lock: createInMemoryLock(),
    log: silentLogger,
  });

  const first = agent.handle({ conversationId: 'c1', text: 'first message', ctx: {} });
  await sleep(15); // let the first run stream its delta, then supersede it
  const second = await agent.handle({ conversationId: 'c1', text: 'second message', ctx: {} });
  const firstResult = await first;

  assert.equal(firstResult.interrupted, true);
  assert.equal(second.interrupted, false);
  assert.equal(second.response, 'Full answer to both.');

  // The second run's context contains BOTH user messages and the partial.
  const req = provider.requests[1]!;
  const texts = req.turns.map((t) => ('content' in t ? String(t.content) : ''));
  assert.ok(texts.includes('first message'));
  assert.ok(texts.includes('second message'));
  assert.ok(
    texts.some((t) => t.includes('Partial answer being written')),
    `expected interrupted partial in context, got: ${JSON.stringify(texts)}`
  );

  // The partial is persisted user-facing, marked interrupted.
  const history = await store.loadHistory('c1');
  const partial = history.messages.find((m) => m.role === 'assistant' && m.interrupted);
  assert.ok(partial);
});

test('three rapid messages: only the last runs to completion, with full context', async () => {
  // Each superseded run may have started its provider call before being
  // aborted mid-stream — script one turn per run.
  const provider = createMockProvider({
    turns: [
      mockTextTurn('doomed first answer'),
      mockTextTurn('doomed second answer'),
      mockTextTurn('Answer to all three.'),
    ],
    delayMs: 10,
  });
  const agent = createAgent({
    provider,
    model: 'm',
    system: 's',
    lock: createInMemoryLock(),
    log: silentLogger,
  });

  const r1 = agent.handle({ conversationId: 'c1', text: 'm1', ctx: {} });
  await sleep(2);
  const r2 = agent.handle({ conversationId: 'c1', text: 'm2', ctx: {} });
  await sleep(2);
  const r3 = agent.handle({ conversationId: 'c1', text: 'm3', ctx: {} });

  const [a, b, c] = await Promise.all([r1, r2, r3]);
  assert.equal(a.interrupted, true);
  assert.equal(b.interrupted, true);
  assert.equal(b.response, ''); // queued run was pre-aborted before any work
  assert.equal(c.interrupted, false);
  assert.equal(c.response, 'Answer to all three.');

  // The surviving run saw every message.
  const finalReq = provider.requests.at(-1)!;
  const texts = finalReq.turns.map((t) => ('content' in t ? String(t.content) : ''));
  for (const m of ['m1', 'm2', 'm3']) {
    assert.ok(texts.includes(m), `missing ${m} in final context`);
  }
});

test('different conversations run concurrently (no cross-serialization)', async () => {
  const provider = createMockProvider({
    turns: [mockTextTurn('answer A'), mockTextTurn('answer B')],
    delayMs: 5,
  });
  const agent = createAgent({
    provider,
    model: 'm',
    system: 's',
    lock: createInMemoryLock(),
    log: silentLogger,
  });

  const [a, b] = await Promise.all([
    agent.handle({ conversationId: 'convA', text: 'hi', ctx: {} }),
    agent.handle({ conversationId: 'convB', text: 'hi', ctx: {} }),
  ]);
  assert.equal(a.interrupted, false);
  assert.equal(b.interrupted, false);
});

test('noopLock: same-conversation runs are NOT serialized or superseded', async () => {
  const provider = createMockProvider({
    turns: [mockTextTurn('one'), mockTextTurn('two')],
    delayMs: 5,
  });
  const agent = createAgent({
    provider,
    model: 'm',
    system: 's',
    log: silentLogger, // default lock = noopLock
  });

  const [a, b] = await Promise.all([
    agent.handle({ conversationId: 'c1', text: 'x', ctx: {} }),
    agent.handle({ conversationId: 'c1', text: 'y', ctx: {} }),
  ]);
  assert.equal(a.interrupted, false);
  assert.equal(b.interrupted, false);
});
