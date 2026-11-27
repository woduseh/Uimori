import type { Usage } from './types.js';
import type { ContextBudget } from './context-budget.js';

export type ContextCheckpointRef = { id: string; revision: number; hash: string };
export type ContextBase = {
  scopeKey: string;
  activeRevision: number;
  notesRevision: number;
  checkpoint: ContextCheckpointRef | null;
};

export type ContextPlan = {
  version: 1;
  status: 'pending' | 'ready' | 'failed';
  budget: ContextBudget;
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
export const CONTEXT_JOB_SCENE_DELETED = 'CONTEXT_JOB_SCENE_DELETED';
export const CONTEXT_JOB_CANCELLED = 'CANCELLED';
export const CONTEXT_JOB_INTERRUPTED = 'CONTEXT_JOB_INTERRUPTED';
export const CONTEXT_ERROR_CODES = [
  CONTEXT_JOB_CANCELLED,
  CONTEXT_JOB_SCENE_DELETED,
  CONTEXT_JOB_INTERRUPTED,
  'CONTEXT_CANCELLED',
  'CONNECTION_NOT_AUTHORIZED',
  'CONTEXT_ATTEMPT_START_FAILED',
  'CONTEXT_ATTEMPT_FINISH_FAILED',
  'CONTEXT_ATTEMPT_MISSING',
  'CONTEXT_BUDGET_MISMATCH',
  'CONTEXT_CHECKPOINT_INVALID',
  'CONTEXT_COMPACTION_CALL_LIMIT',
  'CONTEXT_COMPACTION_EMPTY',
  'CONTEXT_COMPACTION_EOF',
  'CONTEXT_COMPACTION_FAILED',
  'CONTEXT_COMPACTION_PARTIAL',
  'CONTEXT_COMPACTION_PROVIDER_ERROR',
  'CONTEXT_COMPACTION_REFUSED',
  'CONTEXT_COMPACTION_TIMEOUT',
  'CONTEXT_COMPACTION_UNEXPECTED_TOOLS',
  'CONTEXT_DEPENDENCIES_CHANGED',
  'CONTEXT_FIXED_INPUT_TOO_LARGE',
  'CONTEXT_INPUT_MISSING',
  'CONTEXT_JOB_NOT_RUNNING',
  'CONTEXT_LOGICAL_PAIR_MISSING',
  'CONTEXT_PLAN_REQUIRED',
  'CONTEXT_PROGRESS_SAVE_FAILED',
  'CONTEXT_SOURCE_HASH_MISMATCH',
  'CONTEXT_SOURCE_MISMATCH',
  'CONTEXT_SUMMARY_MODEL_DISABLED',
  'CONTEXT_SUMMARY_TARGET_TOO_SMALL',
  'CONTEXT_SUMMARY_TOO_LARGE',
  'CONTEXT_TOOL_COMPACTION_CALL_LIMIT',
  'CONTEXT_TOOL_COMPACTION_EOF',
  'CONTEXT_TOOL_COMPACTION_FAILED',
  'CONTEXT_TOOL_COMPACTION_FIXED_INPUT_TOO_LARGE',
  'CONTEXT_TOOL_COMPACTION_NO_PROGRESS',
  'CONTEXT_TOOL_RESULTS_TOO_LARGE',
] as const;
export type ContextErrorCode = (typeof CONTEXT_ERROR_CODES)[number];
const contextErrorCodes: ReadonlySet<string> = new Set(CONTEXT_ERROR_CODES);
export const isContextErrorCode = (value: string): value is ContextErrorCode =>
  contextErrorCodes.has(value);
export const MODEL_REQUIRED_PATTERN = /^MODEL_REQUIRED:([a-z]+)$/u;
export type ContextJob = {
  priorities?: string;
  id: string;
  chatId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  snapshot: import('./types.js').RunSnapshot | null;
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
  jobs: Omit<ContextJob, 'snapshot'>[];
  usable: boolean;
  invalidReason: 'CONTEXT_INPUTS_CHANGED' | null;
};
