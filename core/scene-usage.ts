import type { RequestLore } from './request-lore.js';
import type { ContextBudget } from './context-budget.js';
import type { TokenizerProfileId } from './tokenizer-profiles.js';

/** Small invocation-time identity receipt; never a historical prompt reconstruction. */
export type ContextReceipt = {
  version: 1;
  model: { modelId: string; title: string; presetId?: string };
  prompt: { id: string; revision: number; title: string } | null;
  /** Selected attachment, not proof that every persona field was transmitted. */
  persona: { id: string; revision: number; title: string | null; name: string | null } | null;
  summary: {
    status: 'included' | 'absent' | 'unverified';
    coveredSources: number;
  } | null;
};

export type SceneUsageDetail = {
  cache: {
    readTokens: number | null;
    writeTokens: number | null;
    write5mTokens?: number | null;
    write1hTokens?: number | null;
  } | null;
  lore: RequestLore | null;
};

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
  attemptId?: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Codex reports the complete internal turn, not a single request's input occupancy. */
  inputScope?: 'request' | 'turn';
  context: RequestContext | null;
  receipt?: ContextReceipt | null;
};

export type LastSceneLoreDetail = {
  sourceRevision: string | null;
  attemptId: string | null;
  lore: RequestLore | null;
};
