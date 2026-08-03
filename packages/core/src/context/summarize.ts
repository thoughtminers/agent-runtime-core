import type { TierTwoSummarizer } from '../agent.js';
import type { Turn } from '../types/turns.js';

/**
 * Tier-2 context fallback: invoked ONLY when tier-1 (declarative replay
 * compaction + whole-block packing) still had to drop history. The dropped
 * turns are summarized into a single ephemeral user turn prepended to the
 * packed window. Opt-in: pass to AgentConfig.summarizer.
 */
export const createDefaultSummarizer = <Ctx = unknown>(opts?: {
  model?: string;
  maxOutputTokens?: number;
}): TierTwoSummarizer<Ctx> => {
  return async (overflowTurns, step) => {
    const transcript = overflowTurns
      .map((t) => {
        switch (t.role) {
          case 'user':
            return `User: ${typeof t.content === 'string' ? t.content : JSON.stringify(t.content)}`;
          case 'assistant':
            return `Assistant: ${t.content}${t.toolCalls ? ` [called: ${t.toolCalls.map((c) => c.name).join(', ')}]` : ''}`;
          case 'tool_result':
            return `Tool result: ${typeof t.content === 'string' ? t.content : JSON.stringify(t.content)}`;
          default:
            return '';
        }
      })
      .filter(Boolean)
      .join('\n');

    const summary = await step.llm({
      prompt:
        'Summarize this earlier portion of a conversation in a compact paragraph. ' +
        'Preserve decisions, facts, names, and unresolved questions. ' +
        'Output ONLY the summary text.\n\n---\n' +
        transcript,
      ...(opts?.model !== undefined ? { model: opts.model } : {}),
      maxOutputTokens: opts?.maxOutputTokens ?? 512,
    });

    return {
      role: 'user',
      content: `[Summary of earlier conversation: ${summary}]`,
    } satisfies Turn;
  };
};
