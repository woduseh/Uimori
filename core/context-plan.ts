import type { Usage } from './types.js';

/** A transmit projection. Original ancestry and logical messages stay immutable. */
export type ContextPlan = {
  version: 1;
  status: 'pending' | 'ready' | 'failed';
  budget: { inputTokenLimit: number; estimator: 'o200k_base-v1' };
  dependencyKey: string;
  estimatedInputTokens: number | null;
  compacted: { revision: string; hash: string; viewHash?: string }[];
  recentSourceRevisions: string[];
  summary: string | null;
  summaryCalls: number;
  usage: Usage;
  error: string | null;
};
