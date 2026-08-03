import type { LazyContext } from '../types/hooks.js';
import type { ToolCallEntry, TraceRecord } from '../types/store.js';
import type { AnyTool } from '../types/tools.js';
import type { Turn } from '../types/turns.js';
import { estimateTurnTokens } from './budget.js';

/**
 * The replay pipeline: turn the append-only trace back into model context.
 * Three passes:
 *   1. expandAndCompact — one trace row → 1..N turns, applying each tool
 *      call's CompactionPolicy (resolved by NAME — pure data, retroactive).
 *   2. rehydrate        — re-run side-effect-free lazyload tools whose result
 *      survived compaction verbatim, splicing fresh values in.
 *   3. packByBudget     — include whole RUN blocks newest→oldest until the
 *      budget is exhausted, then restore chronological order.
 *
 * Passes 1 and 3 are pure (`now` is injected → deterministic tests);
 * pass 2 executes lazy tools only.
 */

interface PreparedTurn {
  turn: Turn;
  /** Present iff a lazyload stub survived verbatim → re-execute at replay. */
  rehydration?: { name: string; input: unknown };
}

export interface RunBlock {
  runId: string;
  turns: PreparedTurn[];
}

const isLazyStub = (result: unknown): boolean =>
  typeof result === 'object' &&
  result !== null &&
  (result as Record<string, unknown>)['lazy'] === true;

const compactEntry = (
  entry: ToolCallEntry,
  tool: AnyTool<never> | undefined,
  rowCreatedAt: Date,
  now: number,
  isInFlightRun: boolean
): { content: string; isError: boolean; survivedVerbatim: boolean } => {
  // Executor errors always surface verbatim so the model can react — never
  // rehydrated, never compacted away.
  if (entry.error != null) {
    return {
      content: JSON.stringify({ error: entry.error }),
      isError: true,
      survivedVerbatim: false,
    };
  }
  // Unknown tool name (registry changed since the row was written): stub.
  if (!tool) {
    return {
      content: JSON.stringify({ compacted: true, note: 'unknown tool' }),
      isError: false,
      survivedVerbatim: false,
    };
  }

  const policy = tool.compaction ?? { mode: 'keep' };
  const verbatim = (): { content: string; isError: boolean; survivedVerbatim: boolean } => ({
    content: JSON.stringify(entry.result ?? null),
    isError: false,
    survivedVerbatim: true,
  });

  if (policy.mode === 'keep') return verbatim();
  if (policy.mode === 'drop') {
    if (isInFlightRun) return verbatim();
    return {
      content: JSON.stringify({ dropped: true }),
      isError: false,
      survivedVerbatim: false,
    };
  }
  // ttl
  const expired = now > rowCreatedAt.getTime() + policy.ttlMs;
  if (expired) {
    return {
      content: JSON.stringify({ compacted: true, note: 'stale result omitted' }),
      isError: false,
      survivedVerbatim: false,
    };
  }
  return verbatim();
};

/** Pass 1: trace rows → run blocks with compaction applied. Pure. */
export const expandAndCompact = <Ctx>(
  trace: TraceRecord[],
  tools: AnyTool<Ctx>[],
  now: number,
  currentRunId?: string
): RunBlock[] => {
  const toolsByName = new Map<string, AnyTool<Ctx>>(tools.map((t) => [t.name, t]));
  const blocks: RunBlock[] = [];
  let current: RunBlock | null = null;

  for (const row of trace) {
    if (!current || current.runId !== row.runId) {
      current = { runId: row.runId, turns: [] };
      blocks.push(current);
    }

    if (row.role === 'user') {
      current.turns.push({ turn: { role: 'user', content: row.content ?? '' } });
      continue;
    }

    // assistant row
    const entries = row.toolCalls ?? [];
    if (entries.length === 0) {
      current.turns.push({ turn: { role: 'assistant', content: row.content ?? '' } });
      continue;
    }

    current.turns.push({
      turn: {
        role: 'assistant',
        content: row.content ?? '',
        toolCalls: entries.map((e) => ({ id: e.id, name: e.name, input: e.input })),
      },
    });
    for (const entry of entries) {
      const tool = toolsByName.get(entry.name);
      const { content, isError, survivedVerbatim } = compactEntry(
        entry,
        tool as AnyTool<never> | undefined,
        row.createdAt,
        now,
        currentRunId !== undefined && row.runId === currentRunId
      );
      const wantsRehydration =
        tool?.lazyload === true && survivedVerbatim && isLazyStub(entry.result);
      current.turns.push({
        turn: {
          role: 'tool_result',
          toolUseId: entry.id,
          content: wantsRehydration
            ? JSON.stringify({ compacted: true, note: 'lazy result unavailable' })
            : content,
          ...(isError ? { isError: true } : {}),
        },
        ...(wantsRehydration ? { rehydration: { name: entry.name, input: entry.input } } : {}),
      });
    }
  }

  return blocks;
};

/**
 * Pass 2: re-run each surviving lazyload tool and splice its fresh result in.
 * Failure keeps the "lazy result unavailable" stub — never throws.
 * (Expired/dropped calls lost their rehydration marker in pass 1 and are
 * never re-executed.)
 */
export const rehydrate = async <Ctx>(
  blocks: RunBlock[],
  tools: AnyTool<Ctx>[],
  lazyCtx: LazyContext<Ctx>
): Promise<void> => {
  const toolsByName = new Map<string, AnyTool<Ctx>>(tools.map((t) => [t.name, t]));
  for (const block of blocks) {
    for (const prepared of block.turns) {
      if (!prepared.rehydration) continue;
      const tool = toolsByName.get(prepared.rehydration.name);
      if (!tool || tool.lazyload !== true) continue;
      try {
        const outcome = await tool.execute(prepared.rehydration.input, lazyCtx);
        if (prepared.turn.role === 'tool_result') {
          prepared.turn.content = JSON.stringify(outcome.result ?? null);
        }
      } catch {
        // Keep the stub content already in place.
      }
    }
  }
};

const blockTokens = (block: RunBlock): number =>
  block.turns.reduce((sum, p) => sum + estimateTurnTokens(p.turn), 0);

export interface PackedContext {
  turns: Turn[];
  /** Chronological turns that did NOT fit — tier-2 summarizer input. */
  dropped: Turn[];
}

/**
 * Pass 3: include whole run blocks newest→oldest while they fit, then restore
 * chronological order. Whole-block granularity keeps every assistant toolCalls
 * turn paired with its tool_result turns (providers reject orphans).
 * The NEWEST block is always included, even over budget — dropping the current
 * user message would break the request (tier-2 summarization is the pressure
 * valve, provider-side limits the backstop).
 * The final window is advanced to start on a user turn.
 */
export const packByBudget = (blocks: RunBlock[], budget: number): PackedContext => {
  const selected: RunBlock[] = [];
  const droppedBlocks: RunBlock[] = [];
  let used = 0;
  let full = false;

  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    const cost = blockTokens(block);
    const isNewest = i === blocks.length - 1;
    if (!full && (isNewest || used + cost <= budget)) {
      selected.unshift(block);
      used += cost;
    } else {
      // First block that doesn't fit ends the window — no gaps allowed.
      full = true;
      droppedBlocks.unshift(block);
    }
  }

  let turns = selected.flatMap((b) => b.turns.map((p) => p.turn));
  // The window must start on a user turn.
  const firstUser = turns.findIndex((t) => t.role === 'user');
  if (firstUser > 0) turns = turns.slice(firstUser);
  else if (firstUser === -1) turns = [];

  return {
    turns,
    dropped: droppedBlocks.flatMap((b) => b.turns.map((p) => p.turn)),
  };
};

export interface ReplayOptions<Ctx> {
  trace: TraceRecord[];
  tools: AnyTool<Ctx>[];
  now: number;
  /** The in-flight run — its `drop`-policy tool results stay verbatim. */
  currentRunId?: string;
  lazyCtx: LazyContext<Ctx>;
  budget: number;
}

/** Full replay: expandAndCompact → rehydrate → packByBudget. */
export const replayTranscript = async <Ctx>(opts: ReplayOptions<Ctx>): Promise<PackedContext> => {
  const blocks = expandAndCompact(opts.trace, opts.tools, opts.now, opts.currentRunId);
  await rehydrate(blocks, opts.tools, opts.lazyCtx);
  return packByBudget(blocks, opts.budget);
};
