import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeBudget,
  createAgent,
  createInMemoryStore,
  createMockProvider,
  estimateTurnTokens,
  mockTextTurn,
  mockToolTurn,
  packByBudget,
  silentLogger,
  type AnyTool,
  type RunBlock,
  type TierTwoSummarizer,
  type Turn,
} from '../dist/index.js';

const userTurn = (content: string): Turn => ({ role: 'user', content });
const assistantTurn = (content: string): Turn => ({ role: 'assistant', content });

const block = (runId: string, turns: Turn[]): RunBlock => ({
  runId,
  turns: turns.map((t) => ({ turn: t })),
});

test('packByBudget: whole blocks newest→oldest, chronological output', () => {
  const blocks = [
    block('r1', [userTurn('oldest question'), assistantTurn('oldest answer')]),
    block('r2', [userTurn('middle question'), assistantTurn('middle answer')]),
    block('r3', [userTurn('newest question')]),
  ];
  const total = blocks.flatMap((b) => b.turns).reduce((s, p) => s + estimateTurnTokens(p.turn), 0);

  // Generous budget: everything fits, order preserved.
  const all = packByBudget(blocks, total + 10);
  assert.deepEqual(
    all.turns.map((t) => ('content' in t ? t.content : '')),
    ['oldest question', 'oldest answer', 'middle question', 'middle answer', 'newest question']
  );
  assert.equal(all.dropped.length, 0);

  // Tight budget: oldest block dropped WHOLE, newer ones kept chronological.
  const r2r3 = blocks[1]!.turns
    .concat(blocks[2]!.turns)
    .reduce((s, p) => s + estimateTurnTokens(p.turn), 0);
  const partial = packByBudget(blocks, r2r3);
  assert.deepEqual(
    partial.turns.map((t) => ('content' in t ? t.content : '')),
    ['middle question', 'middle answer', 'newest question']
  );
  assert.deepEqual(
    partial.dropped.map((t) => ('content' in t ? t.content : '')),
    ['oldest question', 'oldest answer']
  );
});

test('packByBudget: newest block always included, even over budget', () => {
  const blocks = [block('r1', [userTurn('a huge current message that exceeds everything')])];
  const packed = packByBudget(blocks, 1);
  assert.equal(packed.turns.length, 1);
  assert.equal(packed.dropped.length, 0);
});

test('packByBudget: no gaps — the first non-fitting block ends the window', () => {
  // r1 tiny, r2 huge, r3 tiny: r2 doesn't fit → r1 must be dropped too even
  // though it would fit (a window with a hole would desync the conversation).
  const blocks = [
    block('r1', [userTurn('t')]),
    block('r2', [userTurn('x'.repeat(4000))]),
    block('r3', [userTurn('now')]),
  ];
  const r3Cost = estimateTurnTokens(blocks[2]!.turns[0]!.turn);
  const packed = packByBudget(blocks, r3Cost + 10);
  assert.deepEqual(
    packed.turns.map((t) => ('content' in t ? t.content : '')),
    ['now']
  );
  assert.equal(packed.dropped.length, 2);
});

test('packByBudget: window advances to start on a user turn', () => {
  // A block starting with an assistant turn (e.g. its user row was pruned by a
  // store limit) must not lead the window.
  const blocks = [
    block('r1', [assistantTurn('orphan answer'), userTurn('q2'), assistantTurn('a2')]),
  ];
  const packed = packByBudget(blocks, 100_000);
  assert.equal(packed.turns[0]!.role, 'user');
  assert.deepEqual(
    packed.turns.map((t) => ('content' in t ? t.content : '')),
    ['q2', 'a2']
  );
});

test('computeBudget subtracts system, output, tools, and the safety margin', () => {
  const budget = computeBudget({
    contextWindow: 10_000,
    system: 'x'.repeat(400), // 100 tokens
    maxOutputTokens: 1_000,
    toolSpecs: [],
    safetyMargin: 0.1, // 1000 tokens
  });
  // 10_000 − 100 − 1_000 − ~1 (empty tools "[]") − 1_000
  assert.ok(budget > 7_800 && budget < 8_000, `unexpected budget ${budget}`);
});

test('agent end-to-end: ttl tool result decays between runs (injected clock)', async () => {
  let clock = 1_000_000;
  const cached: AnyTool = {
    name: 'lookup',
    description: 'd',
    inputSchema: {},
    compaction: { mode: 'ttl', ttlMs: 60_000 },
    execute: async () => ({ result: { price: 99 } }),
  };
  const provider = createMockProvider({
    turns: [
      mockToolTurn([{ id: 't1', name: 'lookup', input: {} }]),
      mockTextTurn('It costs 99.'),
      mockTextTurn('Second answer.'),
      mockTextTurn('Third answer.'),
    ],
  });
  const agent = createAgent({
    provider,
    model: 'm',
    system: 's',
    tools: [cached],
    now: () => clock,
    store: createInMemoryStore({ now: () => clock }), // same fake clock as the agent
    log: silentLogger,
  });

  await agent.handle({ conversationId: 'c1', text: 'price?', ctx: {} });

  // Second run 10s later: ttl fresh → verbatim result replayed.
  clock += 10_000;
  await agent.handle({ conversationId: 'c1', text: 'again?', ctx: {} });
  const freshReq = provider.requests[2]!;
  const freshResult = freshReq.turns.find((t) => t.role === 'tool_result')!;
  assert.match(String(freshResult.content), /"price":99/);

  // Third run 10min later: expired → stale stub replayed.
  clock += 600_000;
  await agent.handle({ conversationId: 'c1', text: 'and now?', ctx: {} });
  const staleReq = provider.requests[3]!;
  const staleResult = staleReq.turns.find((t) => t.role === 'tool_result')!;
  assert.match(String(staleResult.content), /stale result omitted/);
});

test('tier-2 summarizer: invoked only on overflow, summary prepended', async () => {
  const calls: Turn[][] = [];
  const summarizer: TierTwoSummarizer = async (overflow) => {
    calls.push(overflow);
    return { role: 'user', content: '[Summary of earlier conversation: old stuff]' };
  };

  // Tiny window: the 8000-char reply (~2000 tokens) exceeds run 2's ~1000-token
  // history budget, forcing packing to drop the first exchange.
  const provider = createMockProvider({
    turns: [mockTextTurn('x'.repeat(8_000)), mockTextTurn('short two')],
    contextWindow: 1_200,
  });
  const agent = createAgent({
    provider,
    model: 'm',
    system: 's',
    maxOutputTokens: 100,
    summarizer,
    now: () => 1_000_000,
    log: silentLogger,
  });

  await agent.handle({ conversationId: 'c1', text: 'first', ctx: {} });
  assert.equal(calls.length, 0); // no overflow on the first run

  await agent.handle({ conversationId: 'c1', text: 'second', ctx: {} });
  assert.equal(calls.length, 1, 'summarizer invoked exactly once, on overflow');
  assert.ok(calls[0]!.length > 0);

  const secondReq = provider.requests[1]!;
  const first = secondReq.turns[0]!;
  assert.equal(first.role, 'user');
  assert.match(String(first.content), /^\[Summary of earlier conversation/);
});
