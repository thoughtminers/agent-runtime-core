import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createAgent,
  createInMemoryStore,
  createMockProvider,
  mockTextTurn,
  mockToolTurn,
  silentLogger,
  type AgentEvent,
  type AnyTool,
} from '../dist/index.js';

const echoTool: AnyTool = {
  name: 'echo',
  description: 'Echoes input.',
  inputSchema: { type: 'object' },
  execute: async (input) => ({ result: input, emit: 'echoing...' }),
};

test('stream(): full event ordering across a tool run', async () => {
  const provider = createMockProvider({
    turns: [
      mockToolTurn([{ id: 't1', name: 'echo', input: { a: 1 } }], 'Checking.'),
      mockTextTurn('Answer.'),
    ],
  });
  const agent = createAgent({
    provider,
    model: 'm',
    system: 's',
    tools: [echoTool],
    log: silentLogger,
  });

  const events: AgentEvent[] = [];
  for await (const ev of agent.stream({ conversationId: 'c1', text: 'go', ctx: {} })) {
    events.push(ev);
  }

  const types = events.map((e) => e.type);
  // run_start first, done last.
  assert.equal(types[0], 'run_start');
  assert.equal(types.at(-1), 'done');
  // Deltas arrive before turn_end of their turn; tool events between turns.
  const order = ['run_start', 'text_delta', 'turn_end', 'tool_start', 'tool_emit', 'tool_end'];
  let cursor = -1;
  for (const t of order) {
    const idx = types.indexOf(t, cursor + 1);
    assert.ok(idx > cursor, `expected ${t} after position ${cursor}, got order ${types.join(',')}`);
    cursor = idx;
  }
  // Streamed deltas concatenate to the final response.
  const streamed = events
    .filter((e): e is Extract<AgentEvent, { type: 'text_delta' }> => e.type === 'text_delta')
    .map((e) => e.text)
    .join('');
  const done = events.at(-1)!;
  assert.ok(done.type === 'done');
  assert.equal(streamed, done.response);
  assert.equal(done.response, 'Checking.\n\nAnswer.');
});

test('handle() equals collecting stream()', async () => {
  const mk = () =>
    createAgent({
      provider: createMockProvider({ turns: [mockTextTurn('Same.')] }),
      model: 'm',
      system: 's',
      log: silentLogger,
    });

  const viaHandle = await mk().handle({ conversationId: 'c', text: 'x', ctx: {} });
  const events: AgentEvent[] = [];
  for await (const ev of mk().stream({ conversationId: 'c', text: 'x', ctx: {} })) events.push(ev);
  const done = events.at(-1)!;
  assert.ok(done.type === 'done');
  assert.equal(viaHandle.response, done.response);
  assert.deepEqual(
    viaHandle.events.map((e) => e.type),
    events.map((e) => e.type)
  );
});

test('persistence: user + assistant messages and trace rows written', async () => {
  const store = createInMemoryStore();
  const provider = createMockProvider({
    turns: [mockToolTurn([{ id: 't1', name: 'echo', input: {} }]), mockTextTurn('Done.')],
  });
  const agent = createAgent({
    provider,
    model: 'test-model',
    system: 's',
    tools: [echoTool],
    store,
    log: silentLogger,
  });

  await agent.handle({ conversationId: 'c1', text: 'hello', ctx: {}, externalMessageId: 'ext-1' });

  const history = await store.loadHistory('c1');
  // messages: user + assistant
  assert.deepEqual(
    history.messages.map((m) => [m.role, m.content]),
    [
      ['user', 'hello'],
      ['assistant', 'Done.'],
    ]
  );
  assert.equal(history.messages[0]!.externalMessageId, 'ext-1');
  // trace: user row + one assistant row per provider turn
  assert.deepEqual(
    history.trace.map((t) => t.role),
    ['user', 'assistant', 'assistant']
  );
  const toolRow = history.trace[1]!;
  assert.equal(toolRow.model, 'test-model');
  assert.ok(toolRow.toolCalls && toolRow.toolCalls.length === 1);
  assert.equal(toolRow.toolCalls[0]!.name, 'echo');
  assert.equal(toolRow.toolCalls[0]!.error, null);
  assert.ok(toolRow.usage);
  assert.ok(typeof toolRow.latencyMs === 'number');
  // All rows share the same runId.
  assert.equal(new Set(history.trace.map((t) => t.runId)).size, 1);
});

test('duplicate externalMessageId short-circuits without calling the provider', async () => {
  const provider = createMockProvider({ turns: [mockTextTurn('First.')] });
  const store = createInMemoryStore();
  const agent = createAgent({ provider, model: 'm', system: 's', store, log: silentLogger });

  const first = await agent.handle({
    conversationId: 'c1',
    text: 'hi',
    ctx: {},
    externalMessageId: 'dup-1',
  });
  assert.equal(first.response, 'First.');

  const second = await agent.handle({
    conversationId: 'c1',
    text: 'hi',
    ctx: {},
    externalMessageId: 'dup-1',
  });
  assert.equal(second.halted, true);
  assert.equal(second.response, '');
  assert.equal(provider.requests.length, 1); // no second model call
  const history = await store.loadHistory('c1');
  assert.equal(history.messages.filter((m) => m.role === 'user').length, 1); // no dup row
});
