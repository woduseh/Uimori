import {
  type ContextBudget,
  DEFAULT_INPUT_TOKEN_LIMIT,
  estimateContextTokens,
} from '../core/context-budget.js';
import { countTextTokens } from '../core/text-tokens.js';

export type HelperReadFit = (result: unknown) => boolean;

export function fitsModelInput(value: unknown, budget: ContextBudget): boolean {
  return estimateContextTokens(value, budget) <= budget.inputTokenLimit;
}

export function tokenFit(tokens: number): HelperReadFit {
  return (result) => countTextTokens(JSON.stringify(result)) <= tokens;
}

export const DEFAULT_READ_FIT = tokenFit(DEFAULT_INPUT_TOKEN_LIMIT);
