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

test('abort mid-stream: partial delivered text is persisted, marked interrupted', async () => {
  const store = createInMemoryStore();
  // Slow provider: 5ms between events, so we can abort after the first delta.
  const provider = createMockProvider({
    turns: [mockTextTurn('This is a long answer that will be cut short.')],
    delayMs: 5,
  });
  const controller = new AbortController();
  const agent = createAgent({ provider, model: 'm', system: 's', store, log: silentLogger });

  const events: AgentEvent[] = [];
  for await (const ev of agent.stream({
    conversationId: 'c1',
    text: 'go',
    ctx: {},
    signal: controller.signal,
  })) {
    events.push(ev);
    if (ev.type === 'text_delta') controller.abort(); // cut after the first delta
  }

  const done = events.at(-1)!;
  assert.ok(done.type === 'done');
  assert.equal(done.interrupted, true);
  // What was delivered before the abort is the recorded response.
  assert.equal(done.response, 'This is a long answer that will be cut short.');

  const history = await store.loadHistory('c1');
  const assistant = history.messages.find((m) => m.role === 'assistant');
  assert.ok(assistant, 'partial persisted as assistant message');
  assert.equal(assistant.interrupted, true);
  assert.equal(assistant.content, done.response);
  // Trace rows of the run are flagged.
  assert.ok(history.trace.every((t) => t.interrupted === true));
});

test('abort before any output: nothing delivered, no assistant message, trace flagged', async () => {
  const store = createInMemoryStore();
  const provider = createMockProvider({ turns: [mockTextTurn('Never seen.')], delayMs: 20 });
  const controller = new AbortController();
  const agent = createAgent({ provider, model: 'm', system: 's', store, log: silentLogger });

  const streamP = (async () => {
    const events: AgentEvent[] = [];
    for await (const ev of agent.stream({
      conversationId: 'c1',
      text: 'go',
      ctx: {},
      signal: controller.signal,
    })) {
      events.push(ev);
    }
    return events;
  })();
  controller.abort(); // immediately

  const events = await streamP;
  const done = events.at(-1)!;
  assert.ok(done.type === 'done' && done.interrupted === true);
  assert.equal(done.response, '');

  const history = await store.loadHistory('c1');
  assert.equal(history.messages.filter((m) => m.role === 'assistant').length, 0);
  // The inbound user message survives — a later run must still answer it.
  assert.equal(history.messages.filter((m) => m.role === 'user').length, 1);
});

test('abort during tool execution: signal observed inside the tool, turn trace persisted', async () => {
  const store = createInMemoryStore();
  const controller = new AbortController();

  // Well-behaved abortable tool: reject-if-already-aborted, else listen.
  // The abort fires 5ms AFTER execution starts — genuinely mid-flight.
  const slowTool: AnyTool = {
    name: 'slow',
    description: 'Waits until aborted.',
    inputSchema: { type: 'object' },
    execute: (_input, step) =>
      new Promise((_resolve, reject) => {
        const rejectAborted = () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (step.signal.aborted) return rejectAborted();
        step.signal.addEventListener('abort', rejectAborted, { once: true });
        setTimeout(() => controller.abort(), 5);
      }),
  };

  const provider = createMockProvider({
    turns: [mockToolTurn([{ id: 't1', name: 'slow', input: {} }], 'Working on it.')],
  });
  const agent = createAgent({
    provider,
    model: 'm',
    system: 's',
    tools: [slowTool],
    store,
    log: silentLogger,
  });

  const events: AgentEvent[] = [];
  for await (const ev of agent.stream({
    conversationId: 'c1',
    text: 'go',
    ctx: {},
    signal: controller.signal,
  })) {
    events.push(ev);
  }

  const done = events.at(-1)!;
  assert.ok(done.type === 'done' && done.interrupted === true);

  const history = await store.loadHistory('c1');
  // The in-flight turn (with its aborted tool entry) was persisted before propagating.
  const assistantRow = history.trace.find((t) => t.role === 'assistant');
  assert.ok(assistantRow && assistantRow.toolCalls);
  assert.equal(assistantRow.toolCalls[0]!.error, 'aborted');
  assert.equal(assistantRow.interrupted, true);
});

test('non-abort errors emit an error event and reject', async () => {
  const provider = createMockProvider({ turns: [] }); // no scripted turn → provider throws
  const agent = createAgent({ provider, model: 'm', system: 's', log: silentLogger });

  const events: AgentEvent[] = [];
  await assert.rejects(async () => {
    for await (const ev of agent.stream({ conversationId: 'c1', text: 'go', ctx: {} })) {
      events.push(ev);
    }
  }, /no scripted turn/);
  assert.ok(events.some((e) => e.type === 'error'));
});
