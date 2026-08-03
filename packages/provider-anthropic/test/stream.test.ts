import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { createAnthropicProvider, normalizeStream } from '../dist/index.js';
import { collect, type ProviderEvent } from '@thoughtminers/agent-runtime-core';

/** Minimal fake of the SDK's MessageStream. */
const fakeStream = (
  events: unknown[],
  final: { stop_reason: string | null; usage: Record<string, unknown> }
) => ({
  async *[Symbol.asyncIterator]() {
    for (const ev of events) yield ev as Anthropic.MessageStreamEvent;
  },
  finalMessage: async () => final as unknown as Anthropic.Message,
});

const sdkToolFlow = [
  { type: 'message_start', message: {} },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me check. ' } },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup' },
  },
  {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"q":' },
  },
  {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '"x"}' },
  },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
  { type: 'message_stop' },
];

test('normalizeStream: SDK events → ProviderEvents (tool flow)', async () => {
  const stream = fakeStream(sdkToolFlow, {
    stop_reason: 'tool_use',
    usage: { input_tokens: 11, output_tokens: 9, cache_read_input_tokens: 5 },
  });

  const events: ProviderEvent[] = [];
  for await (const ev of normalizeStream(stream)) events.push(ev);

  assert.deepEqual(events, [
    { type: 'text_delta', text: 'Let me check. ' },
    { type: 'tool_use_start', id: 'toolu_1', name: 'lookup' },
    { type: 'tool_input_delta', json: '{"q":' },
    { type: 'tool_input_delta', json: '"x"}' },
    { type: 'tool_use_end' },
    {
      type: 'message_done',
      stopReason: 'tool_use',
      usage: { inputTokens: 11, outputTokens: 9, cacheReadInputTokens: 5 },
    },
  ]);

  // And it collects into a clean CollectedTurn.
  const collected = await collect(
    normalizeStream(
      fakeStream(sdkToolFlow, {
        stop_reason: 'tool_use',
        usage: { input_tokens: 11, output_tokens: 9 },
      })
    )
  );
  assert.equal(collected.text, 'Let me check. ');
  assert.deepEqual(collected.toolCalls, [{ id: 'toolu_1', name: 'lookup', input: { q: 'x' } }]);
  assert.equal(collected.stopReason, 'tool_use');
});

test('stop reason mapping: refusal and unknown values', async () => {
  const refusal = await collect(
    normalizeStream(
      fakeStream([], { stop_reason: 'refusal', usage: { input_tokens: 1, output_tokens: 0 } })
    )
  );
  assert.equal(refusal.stopReason, 'refusal');

  const paused = await collect(
    normalizeStream(
      fakeStream([], { stop_reason: 'pause_turn', usage: { input_tokens: 1, output_tokens: 0 } })
    )
  );
  assert.equal(paused.stopReason, 'other');
});

test('provider.stream: request rendered with system cache_control, tools, tool_choice', async () => {
  let captured: Record<string, unknown> | null = null;
  const fakeClient = {
    messages: {
      stream: (params: Record<string, unknown>) => {
        captured = params;
        return fakeStream(
          [
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'hi' },
            },
          ],
          { stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
        );
      },
    },
  } as unknown as Anthropic;

  const provider = createAnthropicProvider({
    client: fakeClient,
    contextWindows: { 'my-model': 123_456 },
  });
  assert.equal(provider.contextWindow('my-model'), 123_456);
  assert.equal(provider.contextWindow('unknown'), 200_000);

  const collected = await collect(
    provider.stream({
      model: 'my-model',
      maxOutputTokens: 99,
      system: 'sys',
      turns: [{ role: 'user', content: 'q' }],
      tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }],
      toolChoice: 'auto',
    })
  );

  assert.equal(collected.text, 'hi');
  assert.ok(captured);
  const params = captured as Record<string, unknown>;
  assert.equal(params['model'], 'my-model');
  assert.equal(params['max_tokens'], 99);
  const system = params['system'] as Array<Record<string, unknown>>;
  assert.deepEqual(system[0]!['cache_control'], { type: 'ephemeral' });
  assert.deepEqual(params['tool_choice'], { type: 'auto' });
});

test('extraParams are merged into every request', async () => {
  let captured: Record<string, unknown> | null = null;
  const fakeClient = {
    messages: {
      stream: (params: Record<string, unknown>) => {
        captured = params;
        return fakeStream([], {
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      },
    },
  } as unknown as Anthropic;

  const provider = createAnthropicProvider({
    client: fakeClient,
    extraParams: { thinking: { type: 'adaptive' } },
  });
  await collect(
    provider.stream({ model: 'm', maxOutputTokens: 10, turns: [{ role: 'user', content: 'q' }] })
  );
  assert.deepEqual((captured as Record<string, unknown>)['thinking'], { type: 'adaptive' });
});
