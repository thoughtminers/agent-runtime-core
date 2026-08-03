import { randomUUID } from 'node:crypto';
import { computeBudget } from './context/budget.js';
import { replayTranscript } from './context/replay.js';
import { generate } from './generate.js';
import {
  applyStreamableTransforms,
  fireAsyncPostHooks,
  makeFrozenStep,
  planPostHooks,
  runPreHooks,
  runTerminalPostHooks,
  type StepFactory,
} from './hooks.js';
import { noopLock } from './lock/memory.js';
import { runLoop, toToolSpecs } from './loop.js';
import { createInMemoryStore } from './store/memory.js';
import type { AgentEvent } from './types/events.js';
import type {
  HookLlmRequest,
  LazyContext,
  Logger,
  PostHook,
  PreHook,
  StepContext,
} from './types/hooks.js';
import type { Lock } from './types/lock.js';
import type { Provider } from './types/provider.js';
import type { ConversationStore } from './types/store.js';
import type { AnyTool } from './types/tools.js';
import type { Turn } from './types/turns.js';
import { consoleLogger, isAbortError, throwIfAborted } from './util.js';

/**
 * Tier-2 context overflow seam: invoked when tier-1 (declarative replay
 * compaction + whole-turn packing) still can't fit. See context/summarize.ts.
 */
export type TierTwoSummarizer<Ctx = unknown> = (
  overflowTurns: Turn[],
  step: StepContext<Ctx>
) => Promise<Turn>;

export interface AgentConfig<Ctx = unknown> {
  provider: Provider;
  model: string;
  /** Default 4096. */
  maxOutputTokens?: number;
  system: string | ((ctx: Ctx) => string | Promise<string>);
  tools?: AnyTool<Ctx>[];
  preHooks?: PreHook<Ctx>[];
  postHooks?: PostHook<Ctx>[];
  /** Default: createInMemoryStore(). */
  store?: ConversationStore;
  /** Default: noopLock (no serialization). Use createInMemoryLock() or a distributed adapter. */
  lock?: Lock;
  /** Default 10. */
  maxTurns?: number;
  /** Fraction of the context window held back from the budget. Default 0.10. */
  safetyMargin?: number;
  summarizer?: TierTwoSummarizer<Ctx>;
  log?: Logger;
  /** Injectable clock — keeps compaction deterministic in tests. */
  now?: () => number;
  newId?: () => string;
}

export interface InboundMessage<Ctx = unknown> {
  conversationId: string;
  text: string;
  ctx: Ctx;
  /** Transport message id — idempotency key (duplicates short-circuit). */
  externalMessageId?: string;
  /** Combined with the lease's supersede signal via AbortSignal.any. */
  signal?: AbortSignal;
}

export interface AgentResult {
  response: string;
  interrupted: boolean;
  halted: boolean;
  turns: number;
  events: AgentEvent[];
}

export interface Agent<Ctx = unknown> {
  /** The primitive: the full run as an event stream. */
  stream(msg: InboundMessage<Ctx>): AsyncIterable<AgentEvent>;
  /** handle() = collect(stream()). */
  handle(msg: InboundMessage<Ctx>): Promise<AgentResult>;
}

/**
 * Well-known state key: blocking pre-hooks may push strings here
 * (enrichment — URL summaries, attachment digests, ...). They are injected
 * into the model context as an EPHEMERAL user turn, never persisted.
 */
export const CONTEXT_NOTES_KEY = 'contextNotes';

/**
 * Insert the ephemeral context-notes turn (pre-hook enrichment) immediately
 * BEFORE the current user message — injected into the wire, never persisted.
 */
const injectContextNotes = (turns: Turn[], state: Record<string, unknown>): Turn[] => {
  const notes = state[CONTEXT_NOTES_KEY];
  if (!Array.isArray(notes) || notes.length === 0) return turns;
  const noteTurn: Turn = { role: 'user', content: `[Context]\n${notes.join('\n')}` };
  const last = turns.at(-1);
  if (last && last.role === 'user') {
    return [...turns.slice(0, -1), noteTurn, last];
  }
  return [...turns, noteTurn];
};

export const createAgent = <Ctx = unknown>(config: AgentConfig<Ctx>): Agent<Ctx> => {
  const store = config.store ?? createInMemoryStore();
  const lock = config.lock ?? noopLock;
  const log = config.log ?? consoleLogger;
  const newId = config.newId ?? randomUUID;
  const now = config.now ?? Date.now;
  const maxOutputTokens = config.maxOutputTokens ?? 4096;
  const maxTurns = config.maxTurns ?? 10;

  async function* stream(msg: InboundMessage<Ctx>): AsyncGenerator<AgentEvent, void> {
    const runId = newId();
    yield { type: 'run_start', runId, conversationId: msg.conversationId };

    // Idempotency: a duplicate delivery short-circuits without touching the model.
    if (
      msg.externalMessageId !== undefined &&
      (await store.seen(msg.conversationId, msg.externalMessageId))
    ) {
      yield { type: 'done', response: '', interrupted: false, halted: true, turns: 0 };
      return;
    }

    // Persist the inbound message BEFORE claiming the lock, so a run that
    // supersedes this one still answers it (fuller-context contract).
    await store.appendMessage({
      conversationId: msg.conversationId,
      role: 'user',
      content: msg.text,
      externalMessageId: msg.externalMessageId ?? null,
    });
    await store.appendTrace({
      conversationId: msg.conversationId,
      runId,
      role: 'user',
      content: msg.text,
      toolCalls: null,
      model: null,
      usage: null,
      latencyMs: null,
    });

    const lease = await lock.claim(msg.conversationId);
    const signal = msg.signal ? AbortSignal.any([lease.signal, msg.signal]) : lease.signal;

    /** Text actually delivered to the consumer so far (post-transform). */
    let delivered = '';
    let turnsSeen = 0;

    try {
      throwIfAborted(signal);

      const system =
        typeof config.system === 'function' ? await config.system(msg.ctx) : config.system;

      const state: Record<string, unknown> = {};

      const llmForModel =
        (hookModel?: string) =>
        async (req: HookLlmRequest): Promise<string> => {
          const result = await generate(
            config.provider,
            {
              model: req.model ?? hookModel ?? config.model,
              maxOutputTokens: req.maxOutputTokens ?? 1024,
              ...(req.system !== undefined ? { system: req.system } : {}),
              turns: [{ role: 'user', content: req.prompt }],
            },
            { signal }
          );
          return result.text;
        };

      const liveStep = (model?: string): StepContext<Ctx> => ({
        conversationId: msg.conversationId,
        runId,
        input: msg.text,
        state,
        ctx: msg.ctx,
        llm: llmForModel(model),
        store,
        signal,
        log,
      });
      const steps: StepFactory<Ctx> = {
        live: liveStep,
        frozen: (model) => makeFrozenStep(liveStep(model)),
      };

      // ── Pre-hooks ─────────────────────────────────────────────────────────
      const preGen = runPreHooks(config.preHooks ?? [], steps, log);
      let preResult;
      while (true) {
        const n = await preGen.next();
        if (n.done) {
          preResult = n.value;
          break;
        }
        yield n.value;
      }
      if (preResult.action !== 'continue') {
        const response = preResult.response;
        await store.appendMessage({
          conversationId: msg.conversationId,
          role: 'assistant',
          content: response,
          externalMessageId: null,
        });
        // Keep the trace complete: the canned reply is part of what the model
        // must see on the next run.
        await store.appendTrace({
          conversationId: msg.conversationId,
          runId,
          role: 'assistant',
          content: response,
          toolCalls: null,
          model: null,
          usage: null,
          latencyMs: null,
        });
        yield { type: 'text_delta', text: response };
        yield { type: 'done', response, interrupted: false, halted: true, turns: 0 };
        return;
      }

      // ── Context assembly: replay the trace with compaction + packing ─────
      const history = await store.loadHistory(msg.conversationId);
      const tools = config.tools ?? [];
      const budget = computeBudget({
        contextWindow: config.provider.contextWindow(config.model),
        system,
        maxOutputTokens,
        toolSpecs: toToolSpecs(tools as AnyTool<never>[]),
        safetyMargin: config.safetyMargin ?? 0.1,
      });
      const lazyCtx: LazyContext<Ctx> = {
        conversationId: msg.conversationId,
        ctx: msg.ctx,
        signal,
        log,
      };
      const packed = await replayTranscript({
        trace: history.trace,
        tools,
        now: now(),
        currentRunId: runId,
        lazyCtx,
        budget,
      });
      let initialTurns = packed.turns;
      if (packed.dropped.length > 0 && config.summarizer) {
        // Tier-2: summarize what tier-1 packing had to drop.
        const summaryTurn = await config.summarizer(packed.dropped, liveStep());
        initialTurns = [summaryTurn, ...initialTurns];
      }
      initialTurns = injectContextNotes(initialTurns, state);

      // ── The loop (with streamable transforms / buffer mode at this seam) ──
      const plan = planPostHooks(config.postHooks ?? []);
      let bufferedText = '';

      const loopGen = runLoop<Ctx>({
        provider: config.provider,
        model: config.model,
        maxOutputTokens,
        system,
        initialTurns,
        tools: config.tools ?? [],
        maxTurns,
        signal,
        now,
        makeStep: () => liveStep(),
        persistAssistantTrace: async (row) => {
          await store.appendTrace({
            conversationId: msg.conversationId,
            runId,
            role: 'assistant',
            content: row.content,
            toolCalls: row.toolCalls,
            model: config.model,
            usage: row.usage,
            latencyMs: row.latencyMs,
          });
        },
      });

      let loopResult;
      while (true) {
        const n = await loopGen.next();
        if (n.done) {
          loopResult = n.value;
          break;
        }
        const ev = n.value;
        if (ev.type === 'turn_end') turnsSeen++;
        if (ev.type === 'text_delta') {
          const transformed = await applyStreamableTransforms(ev.text, plan, steps);
          if (transformed.length === 0) continue;
          if (plan.bufferMode) {
            bufferedText += transformed;
          } else {
            delivered += transformed;
            yield { type: 'text_delta', text: transformed };
          }
        } else {
          yield ev;
        }
      }

      // ── Terminal post-hooks (buffer mode only, by construction) ──────────
      let finalText = plan.bufferMode ? bufferedText : delivered;
      let halted = false;
      const termGen = runTerminalPostHooks(finalText, plan, steps);
      while (true) {
        const n = await termGen.next();
        if (n.done) {
          finalText = n.value.text;
          halted = n.value.halted;
          break;
        }
        yield n.value;
      }

      if (plan.bufferMode && finalText.length > 0) {
        delivered = finalText;
        yield { type: 'text_delta', text: finalText };
      }

      // ── Persist the user-facing reply ────────────────────────────────────
      if (finalText.length > 0) {
        await store.appendMessage({
          conversationId: msg.conversationId,
          role: 'assistant',
          content: finalText,
          externalMessageId: null,
        });
      }

      // ── Async post-hooks (fire-and-forget, final text known) ─────────────
      for (const hook of plan.async) {
        yield { type: 'hook_start', phase: 'post', hook: hook.name };
      }
      fireAsyncPostHooks(finalText, plan, steps, log);

      yield {
        type: 'done',
        response: finalText,
        interrupted: false,
        halted,
        turns: loopResult.turns,
      };
    } catch (err) {
      if (isAbortError(err)) {
        if (delivered.length > 0) {
          // History must match what the user actually saw: persist the partial.
          await store.appendMessage({
            conversationId: msg.conversationId,
            role: 'assistant',
            content: delivered,
            externalMessageId: null,
            interrupted: true,
          });
          // Mirror it into the trace unless the loop already persisted an
          // assistant row for this run (e.g. abort during tool execution).
          const h = await store.loadHistory(msg.conversationId);
          const hasAssistantRow = h.trace.some((t) => t.runId === runId && t.role === 'assistant');
          if (!hasAssistantRow) {
            await store.appendTrace({
              conversationId: msg.conversationId,
              runId,
              role: 'assistant',
              content: delivered,
              toolCalls: null,
              model: config.model,
              usage: null,
              latencyMs: null,
            });
          }
        }
        await store.markRunInterrupted(runId);
        yield {
          type: 'done',
          response: delivered,
          interrupted: true,
          halted: false,
          turns: turnsSeen,
        };
      } else {
        yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
        throw err;
      }
    } finally {
      await lease.release();
    }
  }

  const handle = async (msg: InboundMessage<Ctx>): Promise<AgentResult> => {
    const events: AgentEvent[] = [];
    let result: AgentResult | null = null;
    for await (const ev of stream(msg)) {
      events.push(ev);
      if (ev.type === 'done') {
        result = {
          response: ev.response,
          interrupted: ev.interrupted,
          halted: ev.halted,
          turns: ev.turns,
          events,
        };
      }
    }
    if (!result) throw new Error('agent stream ended without a done event');
    return result;
  };

  return { stream, handle };
};
