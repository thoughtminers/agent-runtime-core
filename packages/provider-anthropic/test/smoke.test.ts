import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgent, silentLogger, type AnyTool } from '@thoughtminers/agent-runtime-core';
import { createAnthropicProvider } from '../dist/index.js';

/**
 * Env-gated smoke test against the real API.
 * Run:  ANTHROPIC_API_KEY=... SMOKE_MODEL=<model-id> node --test test/smoke.test.ts
 */
const apiKey = process.env.ANTHROPIC_API_KEY;
const model = process.env.SMOKE_MODEL;
const gated = !apiKey || !model;

test(
  'real API: one tool round-trip',
  { skip: gated && 'set ANTHROPIC_API_KEY + SMOKE_MODEL' },
  async () => {
    const getTime: AnyTool = {
      name: 'get_time',
      description: 'Returns the current server time as an ISO string. Call when asked the time.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => ({ result: { now: new Date().toISOString() } }),
    };

    const agent = createAgent({
      provider: createAnthropicProvider(),
      model: model!,
      maxOutputTokens: 300,
      system: 'You are a terse assistant. Use tools when relevant.',
      tools: [getTime],
      log: silentLogger,
    });

    const result = await agent.handle({
      conversationId: 'smoke-1',
      text: 'What time is it right now? Use your tool.',
      ctx: {},
    });

    assert.equal(result.interrupted, false);
    assert.ok(result.turns >= 2, `expected a tool round-trip, got ${result.turns} turn(s)`);
    assert.ok(result.response.length > 0);
    const toolEvents = result.events.filter((e) => e.type === 'tool_start');
    assert.ok(toolEvents.length >= 1, 'model should have called get_time');
    const usageEvent = result.events.find((e) => e.type === 'turn_end' && e.usage);
    assert.ok(usageEvent, 'usage reported');
  }
);

test(
  'real API: abort mid-stream',
  { skip: gated && 'set ANTHROPIC_API_KEY + SMOKE_MODEL' },
  async () => {
    const controller = new AbortController();
    const agent = createAgent({
      provider: createAnthropicProvider(),
      model: model!,
      maxOutputTokens: 600,
      system: 'You are a verbose assistant.',
      log: silentLogger,
    });

    let sawDelta = false;
    for await (const ev of agent.stream({
      conversationId: 'smoke-2',
      text: 'Write a 500-word story about a lighthouse.',
      ctx: {},
      signal: controller.signal,
    })) {
      if (ev.type === 'text_delta' && !sawDelta) {
        sawDelta = true;
        controller.abort();
      }
      if (ev.type === 'done') {
        assert.equal(ev.interrupted, true);
      }
    }
    assert.ok(sawDelta, 'stream produced at least one delta before abort');
  }
);
