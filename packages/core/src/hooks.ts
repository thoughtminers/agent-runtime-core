import type { AgentEvent } from './types/events.js';
import type { Logger, PostHook, PreHook, StepContext, StepResult } from './types/hooks.js';
import { freezeState } from './util.js';

/**
 * Hook execution semantics:
 *  - blocking hooks run sequentially in declaration order and can steer the
 *    pipeline (halt / replace / continue + state enrichment);
 *  - async hooks are fire-and-forget: they get a frozen structuredClone
 *    snapshot of `state`, their result is ignored, and any error is swallowed
 *    and logged — an async hook can NEVER affect the run.
 */

export interface StepFactory<Ctx> {
  /** Build a live StepContext (blocking steps — shared mutable state). */
  live(model?: string): StepContext<Ctx>;
  /** Build a frozen-snapshot StepContext (async steps). */
  frozen(model?: string): Readonly<StepContext<Ctx>>;
}

export const makeFrozenStep = <Ctx>(live: StepContext<Ctx>): Readonly<StepContext<Ctx>> =>
  Object.freeze({ ...live, state: freezeState(live.state) });

export const fireAsyncStep = (name: string, log: Logger, run: () => Promise<void>): void => {
  run().catch((err) => {
    log.error(`async hook "${name}" failed (swallowed)`, err);
  });
};

/**
 * Run pre-hooks in order. Yields hook events; returns the first non-continue
 * StepResult (halting the pipeline) or { action: 'continue' }.
 */
export async function* runPreHooks<Ctx>(
  hooks: PreHook<Ctx>[],
  steps: StepFactory<Ctx>,
  log: Logger
): AsyncGenerator<AgentEvent, StepResult> {
  for (const hook of hooks) {
    yield { type: 'hook_start', phase: 'pre', hook: hook.name };
    if (hook.mode === 'blocking') {
      const result = await hook.run(steps.live(hook.model));
      yield { type: 'hook_end', phase: 'pre', hook: hook.name, action: result.action };
      if (result.action !== 'continue') return result;
    } else {
      // Fire-and-forget: no hook_end event (the run has moved on).
      const frozen = steps.frozen(hook.model);
      fireAsyncStep(hook.name, log, () => hook.run(frozen));
    }
  }
  return { action: 'continue' };
}

export interface PostHookPlan<Ctx> {
  /** True when any blocking terminal hook exists → deltas must be buffered. */
  bufferMode: boolean;
  streamable: Extract<PostHook<Ctx>, { delivery: 'streamable' }>[];
  terminal: Extract<PostHook<Ctx>, { mode: 'blocking'; delivery: 'terminal' }>[];
  async: Extract<PostHook<Ctx>, { mode: 'async' }>[];
}

export const planPostHooks = <Ctx>(hooks: PostHook<Ctx>[]): PostHookPlan<Ctx> => {
  const streamable: PostHookPlan<Ctx>['streamable'] = [];
  const terminal: PostHookPlan<Ctx>['terminal'] = [];
  const asyncHooks: PostHookPlan<Ctx>['async'] = [];
  for (const hook of hooks) {
    if (hook.mode === 'async') asyncHooks.push(hook);
    else if (hook.delivery === 'streamable') streamable.push(hook);
    else terminal.push(hook);
  }
  return { bufferMode: terminal.length > 0, streamable, terminal, async: asyncHooks };
};

/** Apply every streamable transform, in order, to one delta. */
export const applyStreamableTransforms = async <Ctx>(
  delta: string,
  plan: PostHookPlan<Ctx>,
  steps: StepFactory<Ctx>
): Promise<string> => {
  let out = delta;
  for (const hook of plan.streamable) {
    out = await hook.transform(out, steps.live(hook.model));
  }
  return out;
};

export interface TerminalOutcome {
  text: string;
  halted: boolean;
}

/**
 * Run blocking terminal post-hooks in order against the full text.
 *  - replace: swap the text, keep running remaining hooks
 *  - halt:    swap the text and STOP running further post-hooks
 */
export async function* runTerminalPostHooks<Ctx>(
  fullText: string,
  plan: PostHookPlan<Ctx>,
  steps: StepFactory<Ctx>
): AsyncGenerator<AgentEvent, TerminalOutcome> {
  let text = fullText;
  for (const hook of plan.terminal) {
    yield { type: 'hook_start', phase: 'post', hook: hook.name };
    const result = await hook.run(steps.live(hook.model), text);
    yield { type: 'hook_end', phase: 'post', hook: hook.name, action: result.action };
    if (result.action === 'replace') text = result.response;
    if (result.action === 'halt') return { text: result.response, halted: true };
  }
  return { text, halted: false };
}

/** Fire async post-hooks with the final text (fire-and-forget). */
export const fireAsyncPostHooks = <Ctx>(
  finalText: string,
  plan: PostHookPlan<Ctx>,
  steps: StepFactory<Ctx>,
  log: Logger
): void => {
  for (const hook of plan.async) {
    const frozen = steps.frozen(hook.model);
    fireAsyncStep(hook.name, log, () => hook.run(frozen, finalText));
  }
};
