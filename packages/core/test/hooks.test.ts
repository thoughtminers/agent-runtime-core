import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONTEXT_NOTES_KEY,
  createAgent,
  createInMemoryStore,
  createMockProvider,
  mockTextTurn,
  silentLogger,
  type AgentEvent,
  type PostHook,
  type PreHook,
} from '../dist/index.js';

test('blocking pre-hook halt: provider never called, canned response streamed + persisted', async () => {
  const provider = createMockProvider({ turns: [] });
  const store = createInMemoryStore();
  const guard: PreHook = {
    name: 'guard',
    mode: 'blocking',
    run: async (step) =>
      step.input.length > 5 ? { action: 'halt', response: 'Too long.' } : { action: 'continue' },
  };
  const agent = createAgent({
    provider,
    model: 'm',
    system: 's',
    preHooks: [guard],
    store,
    log: silentLogger,
  });

  const result = await agent.handle({ conversationId: 'c1', text: 'way too long', ctx: {} });

  assert.equal(result.halted, true);
  assert.equal(result.response, 'Too long.');
  assert.equal(result.turns, 0);
  assert.equal(provider.requests.length, 0); // model never touched
  const history = await store.loadHistory('c1');
  assert.deepEqual(
    history.messages.map((m) => [m.role, m.content]),
    [
      ['user', 'way too long'],
      ['assistant', 'Too long.'],
    ]
  );
  // Hook events present with the action recorded.
  const hookEnd = result.events.find((e) => e.type === 'hook_end');
  assert.ok(hookEnd && hookEnd.type === 'hook_end' && hookEnd.action === 'halt');
});

test('blocking pre-hook enrichment: context notes injected ephemerally, never persisted', async () => {
  const provider = createMockProvider({ turns: [mockTextTurn('ok')] });
  const store = createInMemoryStore();
  const enrich: PreHook = {
    name: 'enrich',
    mode: 'blocking',
    run: async (step) => {
      step.state[CONTEXT_NOTES_KEY] = ['Summary of https://example.com: a test page.'];
      return { action: 'continue' };
    },
  };
  const agent = createAgent({
    provider,
    model: 'm',
    system: 's',
    preHooks: [enrich],
    store,
    log: silentLogger,
  });

  await agent.handle({ conversationId: 'c1', text: 'summarize that url', ctx: {} });

  const req = provider.requests[0]!;
  const notesTurn = req.turns.find(
    (t) => t.role === 'user' && String(t.content).startsWith('[Context]')
  );
  assert.ok(notesTurn, 'ephemeral context turn injected into the model request');
  // ...but the note is not in the persisted transcript.
  const history = await store.loadHistory('c1');
  assert.ok(history.messages.every((m) => !m.content.includes('[Context]')));
});

test('async pre-hook: frozen state, errors swallowed, run unaffected', async () => {
  const provider = createMockProvider({ turns: [mockTextTurn('fine')] });
  let sawFrozen: boolean | null = null;
  let hookRan: (() => void) | null = null;
  const ran = new Promise<void>((r) => {
    hookRan = r;
  });

  const analytics: PreHook = {
    name: 'analytics',
    mode: 'async',
    run: async (step) => {
      sawFrozen = Object.isFrozen(step.state);
      hookRan!();
      throw new Error('analytics backend down'); // must be swallowed
    },
  };
  const agent = createAgent({
    provider,
    model: 'm',
    system: 's',
    preHooks: [analytics],
    log: silentLogger,
  });

  const result = await agent.handle({ conversationId: 'c1', text: 'hi', ctx: {} });
  await ran;

  assert.equal(result.response, 'fine'); // hook error did not affect the run
  assert.equal(sawFrozen, true); // snapshot is frozen
});

test('streamable post-hook transforms deltas live; response matches what was streamed', async () => {
  const provider = createMockProvider({ turns: [mockTextTurn('secret code abc')] });
  const store = createInMemoryStore();
  const redact: PostHook = {
    name: 'redact',
    mode: 'blocking',
    delivery: 'streamable',
    transform: (delta) => delta.replaceAll('abc', '[redacted]'),
  };
  const agent = createAgent({
    provider,
    model: 'm',
    system: 's',
    postHooks: [redact],
    store,
    log: silentLogger,
  });

  const events: AgentEvent[] = [];
  for await (const ev of agent.stream({ conversationId: 'c1', text: 'go', ctx: {} })) {
    events.push(ev);
  }

  const streamed = events
    .filter((e): e is Extract<AgentEvent, { type: 'text_delta' }> => e.type === 'text_delta')
    .map((e) => e.text)
    .join('');
  assert.equal(streamed, 'secret code [redacted]');
  const done = events.at(-1)!;
  assert.ok(done.type === 'done');
  assert.equal(done.response, 'secret code [redacted]');
  // Persisted user-facing message is the transformed one; raw stays in the trace.
  const history = await store.loadHistory('c1');
  assert.equal(history.messages.at(-1)!.content, 'secret code [redacted]');
  assert.equal(history.trace.at(-1)!.content, 'secret code abc');
});

test('blocking terminal post-hook forces buffer mode; replace swaps the text', async () => {
  const provider = createMockProvider({ turns: [mockTextTurn('draft answer')] });
  const store = createInMemoryStore();
  const moderate: PostHook = {
    name: 'moderate',
    mode: 'blocking',
    delivery: 'terminal',
    run: async (_step, fullText) => ({ action: 'replace', response: `[checked] ${fullText}` }),
  };
  const agent = createAgent({
    provider,
    model: 'm',
    system: 's',
    postHooks: [moderate],
    store,
    log: silentLogger,
  });

  const events: AgentEvent[] = [];
  for await (const ev of agent.stream({ conversationId: 'c1', text: 'go', ctx: {} })) {
    events.push(ev);
  }

  const types = events.map((e) => e.type);
  // Buffer mode: NO delta may appear before the terminal hook finished.
  const firstDelta = types.indexOf('text_delta');
  const hookEnd = types.indexOf('hook_end');
  assert.ok(hookEnd !== -1 && firstDelta !== -1);
  assert.ok(hookEnd < firstDelta, `hook_end(${hookEnd}) must precede first delta(${firstDelta})`);
  // Single flush delta with the final text.
  const deltas = events.filter(
    (e): e is Extract<AgentEvent, { type: 'text_delta' }> => e.type === 'text_delta'
  );
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0]!.text, '[checked] draft answer');
  const history = await store.loadHistory('c1');
  assert.equal(history.messages.at(-1)!.content, '[checked] draft answer');
});

test('terminal halt stops remaining post-hooks and takes its response', async () => {
  const provider = createMockProvider({ turns: [mockTextTurn('bad draft')] });
  let secondRan = false;
  const veto: PostHook = {
    name: 'veto',
    mode: 'blocking',
    delivery: 'terminal',
    run: async () => ({ action: 'halt', response: 'I cannot help with that.' }),
  };
  const after: PostHook = {
    name: 'after',
    mode: 'blocking',
    delivery: 'terminal',
    run: async (_s, _fullText) => {
      secondRan = true;
      return { action: 'continue' } as const;
    },
  };
  const agent = createAgent({
    provider,
    model: 'm',
    system: 's',
    postHooks: [veto, after],
    log: silentLogger,
  });

  const result = await agent.handle({ conversationId: 'c1', text: 'go', ctx: {} });
  assert.equal(result.response, 'I cannot help with that.');
  assert.equal(result.halted, true);
  assert.equal(secondRan, false);
});

test('async post-hook gets the final text, fire-and-forget', async () => {
  const provider = createMockProvider({
    turns: [mockTextTurn('The answer.'), mockTextTurn('A Fine Title')],
  });
  let received: string | null = null;
  let titled: (() => void) | null = null;
  const done = new Promise<void>((r) => {
    titled = r;
  });

  const title: PostHook = {
    name: 'title',
    mode: 'async',
    run: async (step, fullText) => {
      received = fullText;
      // Async hooks can still use llm() — consumes the second scripted turn.
      await step.llm({ prompt: `title for: ${fullText}` });
      titled!();
    },
  };
  const agent = createAgent({
    provider,
    model: 'm',
    system: 's',
    postHooks: [title],
    log: silentLogger,
  });

  const result = await agent.handle({ conversationId: 'c1', text: 'go', ctx: {} });
  await done;

  assert.equal(result.response, 'The answer.');
  assert.equal(received, 'The answer.');
  assert.equal(provider.requests.length, 2);
});

test('hook llm() runs at the hook model, not the agent model', async () => {
  const provider = createMockProvider({
    turns: [mockTextTurn('classified: ok'), mockTextTurn('main answer')],
  });
  const guard: PreHook = {
    name: 'guard',
    mode: 'blocking',
    model: 'cheap-model',
    run: async (step) => {
      await step.llm({ prompt: 'classify this' });
      return { action: 'continue' };
    },
  };
  const agent = createAgent({
    provider,
    model: 'main-model',
    system: 's',
    preHooks: [guard],
    log: silentLogger,
  });

  await agent.handle({ conversationId: 'c1', text: 'go', ctx: {} });

  assert.equal(provider.requests[0]!.model, 'cheap-model'); // hook call
  assert.equal(provider.requests[1]!.model, 'main-model'); // loop call
});
