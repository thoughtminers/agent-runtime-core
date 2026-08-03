// ── Types ────────────────────────────────────────────────────────────────
export type { AgentEvent } from './types/events.js';
export type {
  HookLlmRequest,
  LazyContext,
  Logger,
  PostHook,
  PreHook,
  StepContext,
  StepResult,
} from './types/hooks.js';
export type { Lease, Lock } from './types/lock.js';
export type {
  CollectedTurn,
  GenerateRequest,
  Provider,
  ProviderEvent,
  StopReason,
  ToolSpec,
  Usage,
} from './types/provider.js';
export type {
  ConversationHistory,
  ConversationStore,
  MessageRecord,
  NewMessage,
  NewTrace,
  ToolCallEntry,
  TraceRecord,
} from './types/store.js';
export type { AnyTool, CompactionPolicy, LazyTool, Tool, ToolOutcome } from './types/tools.js';
export type { ContentPart, JSONSchema, ToolCall, Turn } from './types/turns.js';

// ── Agent ────────────────────────────────────────────────────────────────
export {
  CONTEXT_NOTES_KEY,
  createAgent,
  type Agent,
  type AgentConfig,
  type AgentResult,
  type InboundMessage,
  type TierTwoSummarizer,
} from './agent.js';

// ── Building blocks ──────────────────────────────────────────────────────
export { computeBudget, estimateTokens, estimateTurnTokens } from './context/budget.js';
export {
  expandAndCompact,
  packByBudget,
  rehydrate,
  replayTranscript,
  type PackedContext,
  type ReplayOptions,
  type RunBlock,
} from './context/replay.js';
export { createDefaultSummarizer } from './context/summarize.js';
export { collect, collectStreaming, generate } from './generate.js';
export { createInMemoryLock, noopLock } from './lock/memory.js';
export { runLoop, toToolSpecs, type LoopDeps, type LoopResult } from './loop.js';
export {
  createMockProvider,
  mockTextTurn,
  mockToolTurn,
  type MockProvider,
  type MockProviderOptions,
} from './provider/mock.js';
export { runStoreConformance } from './store/conformance.js';
export { createInMemoryStore } from './store/memory.js';
export {
  consoleLogger,
  isAbortError,
  newAbortError,
  silentLogger,
  throwIfAborted,
} from './util.js';
