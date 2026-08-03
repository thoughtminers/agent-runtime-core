import type { StopReason, Usage } from './provider.js';

/**
 * The agent's outward stream. `agent.stream()` yields these;
 * `agent.handle()` collects them.
 */
export type AgentEvent =
  | { type: 'run_start'; runId: string; conversationId: string }
  | { type: 'hook_start'; phase: 'pre' | 'post'; hook: string }
  | {
      type: 'hook_end';
      phase: 'pre' | 'post';
      hook: string;
      action?: 'continue' | 'halt' | 'replace';
    }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; id: string; name: string; input: unknown }
  | { type: 'tool_emit'; id: string; text: string }
  | { type: 'tool_end'; id: string; name: string; error?: string }
  | { type: 'turn_end'; turn: number; stopReason: StopReason; usage?: Usage }
  | { type: 'done'; response: string; interrupted: boolean; halted: boolean; turns: number }
  | { type: 'error'; message: string };
