import type { RequestLore } from './request-lore.js';
import type { ContextBudget } from './context-budget.js';
import type { TokenizerProfileId } from './tokenizer-profiles.js';

/** App-transmitted input estimate and the input limit frozen for that invocation. */
export type RequestContext = {
  estimatedInputTokens: number;
  inputTokenLimit: number;
  /** Optional on older receipts; describes the captured local estimate, not billed usage. */
  estimator?: ContextBudget['estimator'];
  tokenizer?: TokenizerProfileId;
  tokenizerFallback?: boolean;
};

/** The last writing invocation for a scene, not cumulative run accounting. */
export type SceneUsageReceipt = {
  inputTokens: number | null;
  outputTokens: number | null;
  /** Codex reports the complete internal turn, not a single request's input occupancy. */
  inputScope?: 'request' | 'turn';
  context: RequestContext | null;
};

export type LastSceneLoreDetail = {
  sourceRevision: string | null;
  attemptId: string | null;
  lore: RequestLore | null;
};
