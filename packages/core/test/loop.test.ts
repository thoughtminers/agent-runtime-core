import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createAgent,
  createMockProvider,
  mockTextTurn,
  mockToolTurn,
  silentLogger,
  type AnyTool,
  type ProviderEvent,
} from '../dist/index.js';

const echoTool: AnyTool = {
  name: 'echo',
  description: 'Echoes the input back.',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
  execute: async (input) => ({ result: { echoed: input } }),
};

const makeAgent = (provider: ReturnType<typeof createMockProvider>, tools: AnyTool[] = []) =>
  createAgent({
    provider,
    model: 'mock-model',
    system: 'You are a test agent.',
    tools,
    log: silentLogger,
  });

test('text-only answer: one turn, no tools', async () => {
  const provider = createMockProvider({ turns: [mockTextTurn('Hello there.')] });
  const agent = makeAgent(provider, [echoTool]);

  const result = await agent.handle({ conversationId: 'c1', text: 'hi', ctx: {} });

  assert.equal(result.response, 'Hello there.');
  assert.equal(result.turns, 1);
  assert.equal(result.interrupted, false);
  assert.equal(result.halted, false);
  assert.equal(provider.requests.length, 1);
  const req = provider.requests[0]!;
  assert.equal(req.system, 'You are a test agent.');
  assert.equal(req.toolChoice, 'auto');
  assert.deepEqual(req.turns.at(-1), { role: 'user', content: 'hi' });
});

test('one tool call then answer', async () => {
  const provider = createMockProvider({
    turns: [
      mockToolTurn([{ id: 't1', name: 'echo', input: { value: 'x' } }]),
      mockTextTurn('Echoed x.'),
    ],
  });
  const agent = makeAgent(provider, [echoTool]);

  const result = await agent.handle({ conversationId: 'c1', text: 'echo x', ctx: {} });

  assert.equal(result.response, 'Echoed x.');
  assert.equal(result.turns, 2);
  // Second request must contain the assistant tool call + its tool_result.
  const second = provider.requests[1]!;
  const assistant = second.turns.find((t) => t.role === 'assistant' && t.toolCalls);
  assert.ok(assistant, 'assistant turn with toolCalls present');
  const toolResult = second.turns.find((t) => t.role === 'tool_result');
  assert.ok(toolResult && toolResult.role === 'tool_result');
  assert.equal(toolResult.toolUseId, 't1');
  assert.match(String(toolResult.content), /"echoed"/);
  // Tool events emitted in order.
  const types = result.events.map((e) => e.type);
  assert.ok(types.indexOf('tool_start') < types.indexOf('tool_end'));
});

test('parallel tool calls are all answered before the next request', async () => {
  const provider = createMockProvider({
    turns: [
      mockToolTurn([
        { id: 'a', name: 'echo', input: { value: '1' } },
        { id: 'b', name: 'echo', input: { value: '2' } },
      ]),
      mockTextTurn('Both echoed.'),
    ],
  });
  const agent = makeAgent(provider, [echoTool]);

  const result = await agent.handle({ conversationId: 'c1', text: 'echo both', ctx: {} });

  assert.equal(result.response, 'Both echoed.');
  const second = provider.requests[1]!;
  const results = second.turns.filter((t) => t.role === 'tool_result');
  assert.equal(results.length, 2);
  // Consecutive tool_result turns (one model round-trip) — renderers group them.
  const idx = second.turns.findIndex((t) => t.role === 'tool_result');
  assert.equal(second.turns[idx + 1]!.role, 'tool_result');
});

test('unknown tool produces a synthetic is_error tool_result and the loop continues', async () => {
  const provider = createMockProvider({
    turns: [mockToolTurn([{ id: 'x', name: 'nope', input: {} }]), mockTextTurn('Recovered.')],
  });
  const agent = makeAgent(provider, [echoTool]);

  const result = await agent.handle({ conversationId: 'c1', text: 'go', ctx: {} });

  assert.equal(result.response, 'Recovered.');
  const second = provider.requests[1]!;
  const toolResult = second.turns.find((t) => t.role === 'tool_result');
  assert.ok(toolResult && toolResult.role === 'tool_result');
  assert.equal(toolResult.isError, true);
  assert.match(String(toolResult.content), /Unknown tool/);
  const toolEnd = result.events.find((e) => e.type === 'tool_end');
  assert.ok(toolEnd && toolEnd.type === 'tool_end' && toolEnd.error);
});

test('a throwing tool surfaces as is_error and the model reacts', async () => {
  const bomb: AnyTool = {
    name: 'bomb',
    description: 'Always throws.',
    inputSchema: { type: 'object' },
    execute: async () => {
      throw new Error('kaboom');
    },
  };
  const provider = createMockProvider({
    turns: [mockToolTurn([{ id: 'x', name: 'bomb', input: {} }]), mockTextTurn('Handled.')],
  });
  const agent = makeAgent(provider, [bomb]);

  const result = await agent.handle({ conversationId: 'c1', text: 'go', ctx: {} });
  assert.equal(result.response, 'Handled.');
  const toolResult = provider.requests[1]!.turns.find((t) => t.role === 'tool_result');
  assert.ok(toolResult && toolResult.role === 'tool_result' && toolResult.isError);
  assert.match(String(toolResult.content), /kaboom/);
});

test('max turns: final turn gets wrap-up injection and toolChoice none', async () => {
  // Model insists on calling tools every turn; cap at 3.
  const provider = createMockProvider({
    turns: [
      mockToolTurn([{ id: '1', name: 'echo', input: {} }]),
      mockToolTurn([{ id: '2', name: 'echo', input: {} }]),
      mockTextTurn('Final answer.'),
    ],
  });
  const agent = createAgent({
    provider,
    model: 'mock-model',
    system: 's',
    tools: [echoTool],
    maxTurns: 3,
    log: silentLogger,
  });

  const result = await agent.handle({ conversationId: 'c1', text: 'go', ctx: {} });

  assert.equal(result.response, 'Final answer.');
  assert.equal(result.turns, 3);
  const finalReq = provider.requests[2]!;
  assert.equal(finalReq.toolChoice, 'none');
  const lastTurn = finalReq.turns.at(-1)!;
  assert.equal(lastTurn.role, 'user');
  assert.match(String(lastTurn.content), /final response turn/i);
});

test('narration across turns is joined with a separator', async () => {
  const provider = createMockProvider({
    turns: [
      mockToolTurn([{ id: '1', name: 'echo', input: {} }], 'Let me check.'),
      mockTextTurn('Done: 42.'),
    ],
  });
  const agent = makeAgent(provider, [echoTool]);

  const result = await agent.handle({ conversationId: 'c1', text: 'go', ctx: {} });
  assert.equal(result.response, 'Let me check.\n\nDone: 42.');
});

test('multi-turn conversation: second run sees first exchange in history', async () => {
  const provider = createMockProvider({
    turns: [mockTextTurn('First reply.'), mockTextTurn('Second reply.')],
  });
  const agent = makeAgent(provider);

  await agent.handle({ conversationId: 'c1', text: 'first', ctx: {} });
  await agent.handle({ conversationId: 'c1', text: 'second', ctx: {} });

  const second = provider.requests[1]!;
  const contents = second.turns.map((t) => ('content' in t ? t.content : ''));
  assert.deepEqual(contents, ['first', 'First reply.', 'second']);
});

test('malformed streamed tool JSON falls back to {}', async () => {
  const badToolTurn: ProviderEvent[] = [
    { type: 'tool_use_start', id: 't1', name: 'echo' },
    { type: 'tool_input_delta', json: '{"value": "unclosed' },
    { type: 'tool_use_end' },
    { type: 'message_done', stopReason: 'tool_use' },
  ];
  const provider = createMockProvider({ turns: [badToolTurn, mockTextTurn('ok')] });
  const agent = makeAgent(provider, [echoTool]);

  const result = await agent.handle({ conversationId: 'c1', text: 'go', ctx: {} });
  assert.equal(result.response, 'ok');
  const toolStart = result.events.find((e) => e.type === 'tool_start');
  assert.ok(toolStart && toolStart.type === 'tool_start');
  assert.deepEqual(toolStart.input, {});
});
