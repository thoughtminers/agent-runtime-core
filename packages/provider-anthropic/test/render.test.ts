import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSystem, renderTools, renderTurns } from '../dist/index.js';
import type { Turn } from '@thoughtminers/agent-runtime-core';

test('system: single block with cache_control ephemeral on the last (only) block', () => {
  const system = renderSystem('You are helpful.');
  assert.ok(system);
  assert.equal(system.length, 1);
  assert.equal(system[0]!.text, 'You are helpful.');
  assert.deepEqual(system[0]!.cache_control, { type: 'ephemeral' });
  assert.equal(renderSystem(undefined), undefined);
  assert.equal(renderSystem(''), undefined);
});

test('tools: name/description/input_schema mapping', () => {
  const tools = renderTools([
    { name: 't', description: 'd', inputSchema: { type: 'object', properties: {} } },
  ]);
  assert.ok(tools);
  assert.deepEqual(tools[0], {
    name: 't',
    description: 'd',
    input_schema: { type: 'object', properties: {} },
  });
  assert.equal(renderTools([]), undefined);
});

test('consecutive tool_result turns are grouped into ONE user message', () => {
  const turns: Turn[] = [
    { role: 'user', content: 'do both' },
    {
      role: 'assistant',
      content: 'on it',
      toolCalls: [
        { id: 'a', name: 'x', input: { n: 1 } },
        { id: 'b', name: 'x', input: { n: 2 } },
      ],
    },
    { role: 'tool_result', toolUseId: 'a', content: '1' },
    { role: 'tool_result', toolUseId: 'b', content: '2', isError: true },
    { role: 'assistant', content: 'done' },
  ];
  const messages = renderTurns(turns);

  assert.deepEqual(
    messages.map((m) => m.role),
    ['user', 'assistant', 'user', 'assistant']
  );
  const group = messages[2]!;
  assert.ok(Array.isArray(group.content));
  assert.equal(group.content.length, 2);
  const [r1, r2] = group.content as Array<Record<string, unknown>>;
  assert.equal(r1!['type'], 'tool_result');
  assert.equal(r1!['tool_use_id'], 'a');
  assert.equal(r1!['is_error'], undefined);
  assert.equal(r2!['tool_use_id'], 'b');
  assert.equal(r2!['is_error'], true);
});

test('assistant turn renders text + tool_use blocks; empty assistant is skipped', () => {
  const messages = renderTurns([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'thinking', toolCalls: [{ id: 'a', name: 't', input: {} }] },
    { role: 'assistant', content: '' }, // unrepresentable → skipped
  ]);
  assert.equal(messages.length, 2);
  const blocks = messages[1]!.content as Array<Record<string, unknown>>;
  assert.deepEqual(
    blocks.map((b) => b['type']),
    ['text', 'tool_use']
  );
});

test('image content parts render as base64 sources', () => {
  const messages = renderTurns([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' },
      ],
    },
  ]);
  const blocks = messages[0]!.content as Array<Record<string, unknown>>;
  assert.deepEqual(blocks[1], {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
  });
});
