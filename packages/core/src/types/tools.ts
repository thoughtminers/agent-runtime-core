import type { LazyContext, StepContext } from './hooks.js';
import type { JSONSchema } from './turns.js';

/**
 * How a tool's persisted result is rendered into the replayed context.
 * Resolved by tool NAME at replay time — pure data, so tuning a TTL is a
 * constant change applied retroactively to all history, no migration.
 *  - keep: verbatim forever
 *  - ttl:  verbatim until createdAt + ttlMs, then a small "stale" stub
 *  - drop: verbatim only inside the still-in-flight run; a marker afterwards
 */
export type CompactionPolicy = { mode: 'keep' } | { mode: 'ttl'; ttlMs: number } | { mode: 'drop' };

export interface ToolOutcome {
  /** JSON-serialized into the tool_result the model sees. */
  result: unknown;
  /** Optional user-facing text, surfaced as a `tool_emit` AgentEvent. */
  emit?: string;
}

interface ToolShared {
  name: string;
  description: string;
  /** RAW JSON Schema — schema libraries are a consumer concern, not core's. */
  inputSchema: JSONSchema;
  /** Default: { mode: 'keep' } */
  compaction?: CompactionPolicy;
}

export interface Tool<Ctx = unknown> extends ToolShared {
  lazyload?: false;
  execute(input: unknown, step: StepContext<Ctx>): Promise<ToolOutcome>;
}

/**
 * Lazyload tool: a { lazy: true } stub is persisted instead of the verbatim
 * result, and execute() is re-run at replay time to splice fresh data in.
 * CONTRACT: execute MUST be pure/side-effect-free — the reduced LazyContext
 * (no state, no store, no llm) enforces this as far as types can.
 */
export interface LazyTool<Ctx = unknown> extends ToolShared {
  lazyload: true;
  execute(input: unknown, step: LazyContext<Ctx>): Promise<ToolOutcome>;
}

export type AnyTool<Ctx = unknown> = Tool<Ctx> | LazyTool<Ctx>;
