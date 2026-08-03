/**
 * Compile-time assertions (checked by `tsc -p tsconfig.typetest.json`).
 * Every @ts-expect-error line FAILS the build if the illegal state ever
 * becomes representable.
 */
import type { LazyTool, PostHook, PreHook, Tool } from '../dist/index.js';

// ── Lazyload purity: LazyContext exposes no state, no store, no llm ────────
export const lazyToolCannotTouchState: LazyTool = {
  name: 'lazy',
  description: 'd',
  inputSchema: {},
  lazyload: true,
  execute: async (_input, step) => {
    // @ts-expect-error — lazy tools have no mutable loop state
    step.state;
    // @ts-expect-error — lazy tools cannot write to the store
    step.store;
    // @ts-expect-error — lazy tools cannot call the LLM
    step.llm;
    return { result: step.conversationId }; // ctx/signal/log/conversationId are fine
  },
};

// ── A regular tool DOES get the full StepContext ──────────────────────────
export const fullTool: Tool = {
  name: 'full',
  description: 'd',
  inputSchema: {},
  execute: async (_input, step) => {
    step.state['x'] = 1;
    void step.store;
    void step.llm;
    return { result: null };
  },
};

// ── Post-hook axes: async+streamable is not a legal combination ───────────
export const asyncStreamable: PostHook = {
  name: 'x',
  mode: 'async',
  // @ts-expect-error — an async hook cannot declare a streamable delivery
  delivery: 'streamable',
  transform: (d: string) => d,
};

// ── A blocking pre-hook MUST return a StepResult ──────────────────────────
// @ts-expect-error — Promise<void> is not assignable to Promise<StepResult>
export const blockingMustReturn: PreHook = {
  name: 'x',
  mode: 'blocking',
  run: async () => {},
};

// ── Blocking terminal post-hooks receive the full text ────────────────────
export const terminalHook: PostHook = {
  name: 'x',
  mode: 'blocking',
  delivery: 'terminal',
  run: async (_step, fullText) => {
    const _check: string = fullText;
    return { action: 'continue' };
  },
};

// NOTE on "an async hook cannot halt": TypeScript's void-assignability rule
// means a function returning Promise<StepResult> is still assignable to a
// Promise<void> slot, so that specific misuse cannot be a compile error.
// The guarantee is behavioral instead: the harness IGNORES an async hook's
// return value entirely (see hooks.ts fireAsyncStep) — an async "halt" is a
// no-op by construction, verified at runtime in hooks.test.ts.
