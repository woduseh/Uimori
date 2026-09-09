import type { ModelSnapshot } from './product.js';
import type { RunSnapshot, Usage } from './types.js';
import type { ContextCheckpointRef } from './context-plan.js';

export type HelperScope =
  | { kind: 'chat'; chatId: string; branchId: string }
  | { kind: 'library'; workId: string };
export type HelperConversation = {
  id: string;
  scope: HelperScope;
  revision: number;
  persona: string;
  limits: HelperLimits;
  createdAt: string;
};
export type HelperStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
export type HelperLimits = { totalCalls: number; helperCalls: number; artifacts: number };
export type HelperGrant = {
  id: string;
  requestId: string;
  target: string;
  actions: string[];
  provenance: 'direct-user-request' | 'delegation';
};
export type HelperEditor = { draftId: string; revision: number; title: string; kind: string };
export type HelperSelection = { sourceId: string; sourceHash: string; text: string };
export type HelperTaskSnapshot = {
  retryOf?: string;
  requestGroupId?: string;
  scope: HelperScope;
  model: ModelSnapshot;
  contextModel?: ModelSnapshot;
  writing?: RunSnapshot;
  editor?: HelperEditor;
  selection?: HelperSelection;
  history: { id: string; role: 'user' | 'assistant'; text: string }[];
  context?: { activeRevision: number; checkpoint: ContextCheckpointRef | null };
  persona: string;
  grants: HelperGrant[];
  limits: HelperLimits;
};
export type HelperTask = {
  id: string;
  conversationId: string;
  request: string;
  status: HelperStatus;
  generation: number;
  error: string | null;
  usage: Usage;
  /** Queue time. `startedAt` is null until the worker claims the task. */
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  snapshot: HelperTaskSnapshot;
};
export type HelperMessage = {
  requestOrder?: number;
  requestGroupId?: string;
  latestTaskId?: string;
  id: string;
  conversationId: string;
  taskId: string;
  role: 'user' | 'assistant';
  text: string;
  artifacts: { id: string; revision: number }[];
  createdAt: string;
};
export type HelperArtifact = {
  id: string;
  revision: number;
  origin: 'model' | 'edit';
  conversationId: string;
  taskId: string;
  request: string;
  text: string;
  snapshot: RunSnapshot;
  usage: Usage;
  createdAt: string;
};
export type HelperEvent = {
  seq: number;
  conversationId: string;
  taskId: string | null;
  kind: string;
  data: unknown;
};
