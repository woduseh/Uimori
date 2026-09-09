import type { Usage } from './types.js';

export type ContextCheckpointRef = { id: string; revision: number; hash: string };
export type ContextBase = {
  scopeKey: string;
  activeRevision: number;
  notesRevision: number;
  checkpoint: ContextCheckpointRef | null;
};

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
  checkpoint?: ContextCheckpointRef;
};

export type ContextCheckpoint = ContextCheckpointRef & {
  scopeKey: string;
  chatId: string | null;
  origin: 'automatic' | 'manual' | 'edit' | 'model';
  plan: ContextPlan;
  createdAt: string;
  activated: boolean;
};
export type ContextJob = {
  id: string;
  chatId: string;
  branchId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  snapshot: import('./types.js').RunSnapshot;
  checkpoint: ContextCheckpointRef | null;
  error: string | null;
  noop: boolean;
  createdAt: string;
  updatedAt: string;
};
export type ContextDetail = {
  scopeKey: string;
  activeRevision: number;
  notesRevision: number;
  headRevision: string | null;
  checkpoint: ContextCheckpoint | null;
  checkpoints: ContextCheckpoint[];
  jobs: Omit<ContextJob, 'snapshot'>[];
  usable: boolean;
  invalidReason: string | null;
};
