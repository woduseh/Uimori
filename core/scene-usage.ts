import type { RequestLore } from './request-lore.js';

/** App-transmitted input estimate and the input limit frozen for that invocation. */
export type RequestContext = {
  estimatedInputTokens: number;
  inputTokenLimit: number;
};

/** The last writing invocation for a scene, not cumulative run accounting. */
export type SceneUsageReceipt = {
  inputTokens: number | null;
  outputTokens: number | null;
  context: RequestContext | null;
};

export type LastSceneLoreDetail = {
  sourceRevision: string | null;
  attemptId: string | null;
  lore: RequestLore | null;
};
