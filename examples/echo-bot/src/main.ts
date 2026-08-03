/**
 * echo-bot: a minimal REPL wiring every simple-agent seam.
 *
 * Run:  MODEL=<model-id> ANTHROPIC_API_KEY=... pnpm --filter echo-bot start
 *
 * Demonstrates:
 *  - a blocking pre-hook guard (halts over-long input, model never called)
 *  - an async post-hook (title generation via step.llm — fire-and-forget)
 *  - one tool with a ttl compaction policy + lazyload (pure, re-run at replay)
 *  - live streaming with tool cards
 */
import { createInterface } from 'node:readline/promises';
import {
  createAgent,
  createInMemoryLock,
  silentLogger,
  type AnyTool,
  type PostHook,
  type PreHook,
} from 'agent-runtime-core';
import { createAnthropicProvider } from 'agent-runtime-anthropic';

const model = process.env.MODEL;
if (!model) {
  console.error('Set MODEL=<model-id> (and ANTHROPIC_API_KEY) to run the echo bot.');
  process.exit(1);
}

interface Ctx {
  userId: string;
}

const getTime: AnyTool<Ctx> = {
  name: 'get_time',
  description: 'Returns the current server time as an ISO string. Call when asked the time.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  compaction: { mode: 'ttl', ttlMs: 60_000 }, // stale after a minute
  lazyload: true, // pure → stub persisted, re-executed at replay
  execute: async () => ({ result: { now: new Date().toISOString() }, emit: 'Checked the clock.' }),
};

const guard: PreHook<Ctx> = {
  name: 'guard',
  mode: 'blocking',
  run: async (step) =>
    step.input.length > 2000
      ? { action: 'halt', response: 'That message is too long for me — could you shorten it?' }
      : { action: 'continue' },
};

const title: PostHook<Ctx> = {
  name: 'title',
  mode: 'async',
  run: async (step, fullText) => {
    const t = await step.llm({
      prompt: `Reply with a 3-word title for this assistant reply, nothing else:\n${fullText}`,
      maxOutputTokens: 20,
    });
    console.log(`\x1b[2m   [title: ${t.trim()}]\x1b[0m`);
  },
};

const agent = createAgent<Ctx>({
  provider: createAnthropicProvider(),
  model,
  maxOutputTokens: 1024,
  system: ({ userId }) =>
    `You are a terse, friendly assistant for user ${userId}. Use tools when relevant.`,
  tools: [getTime],
  preHooks: [guard],
  postHooks: [title],
  lock: createInMemoryLock(),
  log: silentLogger,
});

const rl = createInterface({ input: process.stdin, output: process.stdout });
console.log(`echo-bot ready (model: ${model}). Ctrl+C or empty line to exit.\n`);

let n = 0;
while (true) {
  const line = await rl.question('\x1b[36myou>\x1b[0m ');
  if (line.trim() === '') break;

  process.stdout.write('\x1b[33mbot>\x1b[0m ');
  for await (const ev of agent.stream({
    conversationId: 'repl',
    text: line,
    ctx: { userId: 'demo' },
    externalMessageId: `repl-${n++}`,
  })) {
    switch (ev.type) {
      case 'text_delta':
        process.stdout.write(ev.text);
        break;
      case 'tool_start':
        process.stdout.write(`\n\x1b[2m   [tool ${ev.name} ${JSON.stringify(ev.input)}]\x1b[0m\n`);
        break;
      case 'tool_emit':
        process.stdout.write(`\x1b[2m   [${ev.text}]\x1b[0m\n`);
        break;
      case 'done':
        process.stdout.write(ev.interrupted ? '\n\x1b[31m[interrupted]\x1b[0m\n\n' : '\n\n');
        break;
      case 'error':
        process.stdout.write(`\n\x1b[31m[error: ${ev.message}]\x1b[0m\n\n`);
        break;
      default:
        break;
    }
  }
}
rl.close();
