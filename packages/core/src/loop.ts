import { collectStreaming } from './generate.js';
import type { AgentEvent } from './types/events.js';
import type { StepContext } from './types/hooks.js';
import type { Provider, StopReason, ToolSpec, Usage } from './types/provider.js';
import type { ToolCallEntry } from './types/store.js';
import type { AnyTool } from './types/tools.js';
import type { Turn } from './types/turns.js';
import { isAbortError, throwIfAborted } from './util.js';

const FINAL_TURN_NOTE =
  '[You have reached your final response turn. Provide your best answer now ' +
  'using what you already know. Do not call any more tools.]';

export interface LoopResult {
  /** Raw (untransformed) assistant text accumulated across turns. */
  responseRaw: string;
  /** Number of provider calls made. */
  turns: number;
  stopReason: StopReason;
}

export interface LoopDeps<Ctx> {
  provider: Provider;
  model: string;
  maxOutputTokens: number;
  system: string;
  /** Context assembled by the agent (history replay + current input). */
  initialTurns: Turn[];
  tools: AnyTool<Ctx>[];
  maxTurns: number;
  signal: AbortSignal;
  now: () => number;
  makeStep: () => StepContext<Ctx>;
  /** Persist one assistant trace row (called after that turn's tools ran). */
  persistAssistantTrace: (row: {
    content: string | null;
    toolCalls: ToolCallEntry[] | null;
    usage: Usage | null;
    latencyMs: number;
  }) => Promise<void>;
}

export const toToolSpecs = (tools: AnyTool<never>[]): ToolSpec[] =>
  tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));

/**
 * The agent loop: provider ↔ tools until the model stops calling tools or the
 * turn cap is reached. Yields AgentEvents (deltas are RAW — the agent applies
 * streamable post-hook transforms and buffering at its own boundary) and
 * returns the LoopResult.
 *
 * Contracts implemented here:
 *  - final-turn injection: on the last allowed turn (only if we actually
 *    looped), a wrap-up note is added and toolChoice is forced to 'none';
 *  - unknown tool → synthetic is_error tool_result (loop continues);
 *  - a tool throwing a non-abort error → is_error tool_result (model reacts);
 *  - parallel tool calls are answered as consecutive tool_result turns, which
 *    renderers MUST group into one user-side message;
 *  - each assistant turn is persisted (with executed tool results embedded)
 *    before the next provider call — an abort loses at most the turn in flight;
 *  - lazyload tools persist a { lazy: true } stub instead of the result.
 */
export async function* runLoop<Ctx>(deps: LoopDeps<Ctx>): AsyncGenerator<AgentEvent, LoopResult> {
  const turns: Turn[] = [...deps.initialTurns];
  const toolSpecs = toToolSpecs(deps.tools as AnyTool<never>[]);
  const toolsByName = new Map(deps.tools.map((t) => [t.name, t]));

  let responseRaw = '';
  let turnCount = 0;
  let stopReason: StopReason = 'other';

  for (let turn = 0; turn < deps.maxTurns; turn++) {
    throwIfAborted(deps.signal);
    const isFinal = turn === deps.maxTurns - 1 && turn > 0;

    const requestTurns = isFinal
      ? [...turns, { role: 'user', content: FINAL_TURN_NOTE } satisfies Turn]
      : turns;

    const startedAt = deps.now();
    const collector = collectStreaming(
      deps.provider.stream(
        {
          model: deps.model,
          maxOutputTokens: deps.maxOutputTokens,
          system: deps.system,
          turns: requestTurns,
          ...(toolSpecs.length > 0
            ? { tools: toolSpecs, toolChoice: isFinal ? ('none' as const) : ('auto' as const) }
            : {}),
        },
        { signal: deps.signal }
      )
    );

    // Stream deltas out live while collecting the turn.
    let emittedThisTurn = false;
    let collected;
    while (true) {
      const next = await collector.next();
      if (next.done) {
        collected = next.value;
        break;
      }
      const ev = next.value;
      if (ev.type === 'text_delta' && ev.text.length > 0) {
        if (!emittedThisTurn && responseRaw.length > 0) {
          // Separator between this turn's narration and the previous turn's,
          // emitted as a delta so stream and final response agree byte-for-byte.
          yield { type: 'text_delta', text: '\n\n' };
          responseRaw += '\n\n';
        }
        emittedThisTurn = true;
        yield { type: 'text_delta', text: ev.text };
        responseRaw += ev.text;
      }
    }
    turnCount++;
    stopReason = collected.stopReason;
    yield {
      type: 'turn_end',
      turn,
      stopReason: collected.stopReason,
      ...(collected.usage ? { usage: collected.usage } : {}),
    };

    const assistantTurn: Turn = {
      role: 'assistant',
      content: collected.text,
      ...(collected.toolCalls.length > 0 ? { toolCalls: collected.toolCalls } : {}),
    };
    turns.push(assistantTurn);

    if (collected.stopReason !== 'tool_use' || collected.toolCalls.length === 0) {
      await deps.persistAssistantTrace({
        content: collected.text || null,
        toolCalls: null,
        usage: collected.usage ?? null,
        latencyMs: deps.now() - startedAt,
      });
      break;
    }

    // Execute every requested tool (sequentially), answer ALL of them.
    const entries: ToolCallEntry[] = [];
    for (const call of collected.toolCalls) {
      yield { type: 'tool_start', id: call.id, name: call.name, input: call.input };
      const tool = toolsByName.get(call.name);

      if (!tool) {
        const error = `Unknown tool: ${call.name}`;
        entries.push({ id: call.id, name: call.name, input: call.input, result: null, error });
        turns.push({ role: 'tool_result', toolUseId: call.id, content: error, isError: true });
        yield { type: 'tool_end', id: call.id, name: call.name, error };
        continue;
      }

      try {
        // Inside the try: an abort landing between the yield above and here
        // still persists this turn's trace via the catch below.
        throwIfAborted(deps.signal);
        const step = deps.makeStep();
        // LazyContext is a structural subset of StepContext, so `step`
        // satisfies both execute signatures.
        const outcome = await tool.execute(call.input, step);
        entries.push({
          id: call.id,
          name: call.name,
          input: call.input,
          result: tool.lazyload ? { lazy: true } : outcome.result,
          error: null,
        });
        turns.push({
          role: 'tool_result',
          toolUseId: call.id,
          content: JSON.stringify(outcome.result ?? null),
        });
        if (outcome.emit) yield { type: 'tool_emit', id: call.id, text: outcome.emit };
        yield { type: 'tool_end', id: call.id, name: call.name };
      } catch (err) {
        if (isAbortError(err)) {
          // Persist what we have for this turn before propagating the abort.
          entries.push({
            id: call.id,
            name: call.name,
            input: call.input,
            result: null,
            error: 'aborted',
          });
          await deps.persistAssistantTrace({
            content: collected.text || null,
            toolCalls: entries,
            usage: collected.usage ?? null,
            latencyMs: deps.now() - startedAt,
          });
          throw err;
        }
        const error = err instanceof Error ? err.message : String(err);
        entries.push({ id: call.id, name: call.name, input: call.input, result: null, error });
        turns.push({
          role: 'tool_result',
          toolUseId: call.id,
          content: JSON.stringify({ error }),
          isError: true,
        });
        yield { type: 'tool_end', id: call.id, name: call.name, error };
      }
    }

    await deps.persistAssistantTrace({
      content: collected.text || null,
      toolCalls: entries,
      usage: collected.usage ?? null,
      latencyMs: deps.now() - startedAt,
    });
  }

  return { responseRaw, turns: turnCount, stopReason };
}
