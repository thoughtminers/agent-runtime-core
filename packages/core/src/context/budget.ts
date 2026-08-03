import type { ToolSpec } from '../types/provider.js';
import type { Turn } from '../types/turns.js';

/**
 * chars/4 heuristic. Deliberately cheap: the 10% safety margin in the budget
 * is what makes this estimate safe. Providers may expose an accurate
 * countTokens; the harness never requires it.
 */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export const estimateTurnTokens = (turn: Turn): number => estimateTokens(JSON.stringify(turn));

export interface BudgetOptions {
  contextWindow: number;
  system: string;
  maxOutputTokens: number;
  toolSpecs: ToolSpec[];
  /** Fraction of the window held back as slack for the estimator. */
  safetyMargin: number;
}

/**
 * Token budget available to HISTORY:
 * window − system − output reservation − tool schemas − safety margin.
 */
export const computeBudget = (opts: BudgetOptions): number => {
  const margin = Math.floor(opts.contextWindow * opts.safetyMargin);
  const toolTokens = estimateTokens(JSON.stringify(opts.toolSpecs));
  const budget =
    opts.contextWindow - estimateTokens(opts.system) - opts.maxOutputTokens - toolTokens - margin;
  return Math.max(budget, 0);
};
