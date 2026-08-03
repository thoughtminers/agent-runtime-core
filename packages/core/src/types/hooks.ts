import type { ConversationStore } from './store.js';

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

/** A one-shot generation available to hooks and tools, at their OWN model. */
export interface HookLlmRequest {
  prompt: string;
  system?: string;
  /** Defaults to the hook's declared model, else the agent model. */
  model?: string;
  maxOutputTokens?: number;
}

/**
 * Capabilities handed to every hook and tool. `Ctx` is the opaque
 * caller-supplied identity/context — the harness never inspects it.
 */
export interface StepContext<Ctx = unknown> {
  conversationId: string;
  runId: string;
  /** The inbound user message text. */
  input: string;
  /**
   * Mutable loop state for blocking steps (enrichment written here is visible
   * to the loop); async steps receive a frozen structuredClone snapshot.
   */
  state: Record<string, unknown>;
  ctx: Ctx;
  llm(req: HookLlmRequest): Promise<string>;
  store: ConversationStore;
  signal: AbortSignal;
  log: Logger;
}

/**
 * Reduced context for lazyload tools re-run at replay time. No `state`, no
 * `store`, no `llm` — as close to type-enforced purity as TypeScript gets.
 */
export type LazyContext<Ctx = unknown> = Pick<
  StepContext<Ctx>,
  'conversationId' | 'ctx' | 'signal' | 'log'
>;

export type StepResult =
  | { action: 'continue' }
  | { action: 'halt'; response: string }
  | { action: 'replace'; response: string };

/**
 * Pre-hooks run before the loop, in declaration order.
 * The `mode` discriminant selects the run signature: an async hook returns
 * Promise<void>, so "an async hook that halts" is a compile error.
 */
export type PreHook<Ctx = unknown> =
  | {
      name: string;
      mode: 'blocking';
      model?: string;
      run(step: StepContext<Ctx>): Promise<StepResult>;
    }
  | {
      name: string;
      mode: 'async';
      model?: string;
      /** Fire-and-forget; frozen state; errors swallowed + logged. */
      run(step: Readonly<StepContext<Ctx>>): Promise<void>;
    };

/**
 * Post-hooks run after the loop. Orthogonal axes:
 *   mode:     blocking | async
 *   delivery: streamable (delta transformer) | terminal (needs full text)
 * The union below is exactly the legal set:
 *  - streamable is only meaningful as a blocking transformer on the live stream
 *  - a blocking terminal hook forces BUFFER MODE (no deltas reach the consumer
 *    until every terminal hook has run)
 *  - async is inherently terminal (full-text snapshot, void return)
 */
export type PostHook<Ctx = unknown> =
  | {
      name: string;
      mode: 'blocking';
      delivery: 'streamable';
      model?: string;
      /** Runs on the live stream; returns the (possibly rewritten) delta. */
      transform(delta: string, step: StepContext<Ctx>): string | Promise<string>;
    }
  | {
      name: string;
      mode: 'blocking';
      delivery: 'terminal';
      model?: string;
      run(step: StepContext<Ctx>, fullText: string): Promise<StepResult>;
    }
  | {
      name: string;
      mode: 'async';
      model?: string;
      run(step: Readonly<StepContext<Ctx>>, fullText: string): Promise<void>;
    };
