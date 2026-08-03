import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  expandAndCompact,
  rehydrate,
  replayTranscript,
  silentLogger,
  type AnyTool,
  type LazyContext,
  type ToolCallEntry,
  type TraceRecord,
} from '../dist/index.js';

const T0 = 1_000_000; // deterministic epoch for tests

let idCounter = 0;
const traceRow = (
  runId: string,
  role: 'user' | 'assistant',
  content: string | null,
  toolCalls: ToolCallEntry[] | null = null,
  createdAtMs = T0
): TraceRecord => ({
  id: `row-${idCounter++}`,
  conversationId: 'c1',
  runId,
  role,
  content,
  toolCalls,
  model: role === 'assistant' ? 'm' : null,
  usage: null,
  latencyMs: null,
  interrupted: false,
  createdAt: new Date(createdAtMs),
});

const entry = (id: string, name: string, result: unknown, error: string | null = null) => ({
  id,
  name,
  input: { q: 1 },
  result,
  error,
});

const lazyCtx: LazyContext = {
  conversationId: 'c1',
  ctx: {},
  signal: new AbortController().signal,
  log: silentLogger,
};

const toolWith = (name: string, compaction: AnyTool['compaction']): AnyTool => ({
  name,
  description: 'd',
  inputSchema: {},
  ...(compaction ? { compaction } : {}),
  execute: async () => ({ result: 'fresh' }),
});

const contentOfToolResult = (blocks: ReturnType<typeof expandAndCompact>, index = 0): string => {
  const turns = blocks.flatMap((b) => b.turns.map((p) => p.turn));
  const results = turns.filter((t) => t.role === 'tool_result');
  return String(results[index]!.content);
};

test('keep policy: verbatim forever', () => {
  const trace = [
    traceRow('r1', 'user', 'q'),
    traceRow('r1', 'assistant', '', [entry('t1', 'k', { data: 42 })]),
  ];
  const blocks = expandAndCompact(trace, [toolWith('k', { mode: 'keep' })], T0 + 10 ** 9);
  assert.equal(contentOfToolResult(blocks), JSON.stringify({ data: 42 }));
});

test('ttl policy: verbatim while fresh, stale stub after expiry', () => {
  const tools = [toolWith('t', { mode: 'ttl', ttlMs: 5_000 })];
  const trace = [
    traceRow('r1', 'user', 'q'),
    traceRow('r1', 'assistant', '', [entry('t1', 't', { data: 1 })], T0),
  ];

  const fresh = expandAndCompact(trace, tools, T0 + 4_999);
  assert.equal(contentOfToolResult(fresh), JSON.stringify({ data: 1 }));

  const stale = expandAndCompact(trace, tools, T0 + 5_001);
  assert.match(contentOfToolResult(stale), /stale result omitted/);
});

test('drop policy: verbatim inside the in-flight run, dropped marker afterwards', () => {
  const tools = [toolWith('d', { mode: 'drop' })];
  const trace = [
    traceRow('r1', 'user', 'q'),
    traceRow('r1', 'assistant', '', [entry('t1', 'd', { big: 'blob' })]),
  ];

  const inFlight = expandAndCompact(trace, tools, T0, 'r1');
  assert.equal(contentOfToolResult(inFlight), JSON.stringify({ big: 'blob' }));

  const later = expandAndCompact(trace, tools, T0, 'r2');
  assert.match(contentOfToolResult(later), /"dropped":true/);
});

test('executor errors surface verbatim regardless of policy, never rehydrated', async () => {
  const lazyErr: AnyTool = {
    name: 'l',
    description: 'd',
    inputSchema: {},
    lazyload: true,
    compaction: { mode: 'keep' },
    execute: async () => ({ result: 'should never be called' }),
  };
  const trace = [
    traceRow('r1', 'user', 'q'),
    traceRow('r1', 'assistant', '', [entry('t1', 'l', null, 'boom')]),
  ];
  const blocks = expandAndCompact(trace, [lazyErr], T0);
  assert.equal(contentOfToolResult(blocks), JSON.stringify({ error: 'boom' }));
  const before = contentOfToolResult(blocks);
  await rehydrate(blocks, [lazyErr], lazyCtx);
  assert.equal(contentOfToolResult(blocks), before); // untouched
});

test('unknown tool (registry changed): safe stub', () => {
  const trace = [
    traceRow('r1', 'user', 'q'),
    traceRow('r1', 'assistant', '', [entry('t1', 'gone', { x: 1 })]),
  ];
  const blocks = expandAndCompact(trace, [], T0);
  assert.match(contentOfToolResult(blocks), /unknown tool/);
});

test('lazyload: stub persisted → re-executed at replay with fresh data', async () => {
  let executions = 0;
  const lazy: AnyTool = {
    name: 'lazy',
    description: 'd',
    inputSchema: {},
    lazyload: true,
    compaction: { mode: 'keep' },
    execute: async (input) => {
      executions++;
      return { result: { fresh: true, input } };
    },
  };
  const trace = [
    traceRow('r1', 'user', 'q'),
    traceRow('r1', 'assistant', '', [entry('t1', 'lazy', { lazy: true })]),
  ];
  const blocks = expandAndCompact(trace, [lazy], T0);
  assert.match(contentOfToolResult(blocks), /lazy result unavailable/); // pre-rehydrate stub
  await rehydrate(blocks, [lazy], lazyCtx);
  assert.equal(executions, 1);
  assert.match(contentOfToolResult(blocks), /"fresh":true/);
});

test('lazyload: rehydrate failure keeps the stub, never throws', async () => {
  const lazy: AnyTool = {
    name: 'lazy',
    description: 'd',
    inputSchema: {},
    lazyload: true,
    execute: async () => {
      throw new Error('backend down');
    },
  };
  const trace = [
    traceRow('r1', 'user', 'q'),
    traceRow('r1', 'assistant', '', [entry('t1', 'lazy', { lazy: true })]),
  ];
  const blocks = expandAndCompact(trace, [lazy], T0);
  await rehydrate(blocks, [lazy], lazyCtx);
  assert.match(contentOfToolResult(blocks), /lazy result unavailable/);
});

test('lazyload: expired TTL lazies are never re-executed', async () => {
  let executions = 0;
  const lazy: AnyTool = {
    name: 'lazy',
    description: 'd',
    inputSchema: {},
    lazyload: true,
    compaction: { mode: 'ttl', ttlMs: 1_000 },
    execute: async () => {
      executions++;
      return { result: 'x' };
    },
  };
  const trace = [
    traceRow('r1', 'user', 'q'),
    traceRow('r1', 'assistant', '', [entry('t1', 'lazy', { lazy: true })], T0),
  ];
  const blocks = expandAndCompact(trace, [lazy], T0 + 60_000); // long expired
  await rehydrate(blocks, [lazy], lazyCtx);
  assert.equal(executions, 0);
  assert.match(contentOfToolResult(blocks), /stale result omitted/);
});

test('full replay: assistant toolCalls turn stays paired with its tool_results', async () => {
  const tools = [toolWith('k', { mode: 'keep' })];
  const trace = [
    traceRow('r1', 'user', 'question'),
    traceRow('r1', 'assistant', 'narration', [
      entry('a', 'k', { n: 1 }),
      entry('b', 'k', { n: 2 }),
    ]),
    traceRow('r1', 'assistant', 'final answer'),
  ];
  const packed = await replayTranscript({
    trace,
    tools,
    now: T0,
    lazyCtx,
    budget: 100_000,
  });
  assert.deepEqual(
    packed.turns.map((t) => t.role),
    ['user', 'assistant', 'tool_result', 'tool_result', 'assistant']
  );
  const assistant = packed.turns[1]!;
  assert.ok(assistant.role === 'assistant' && assistant.toolCalls?.length === 2);
});
