import type { EditorContext } from './resource-editing.js';
import type { ModelSnapshot } from './product.js';
import type { RunSnapshot, Usage } from './types.js';
import type { ContextCheckpointRef } from './context-plan.js';

export type HelperScope = { kind: 'chat'; chatId: string } | { kind: 'library'; workId: string };
export type HelperConversation = {
  id: string;
  scope: HelperScope;
  title: string;
  revision: number;
  /** Latest transcript mutation event; settings and task updates do not advance it. */
  historyRevision?: number;
  persona: string;
  limits: HelperLimits;
  createdAt: string;
  updatedAt: string;
};
export type HelperConversationDeletion = {
  request: { expectedRevision: number; expectedEventSequence: number };
  activeTasks: number;
  unsettledAttempts: number;
  workerActive: boolean;
  canDelete: boolean;
  description: string;
};
export type HelperProject = { id: string; title: string; revision: number };
export type HelperConversationSummary = HelperConversation & {
  projectId: string | null;
  /** Present for chat conversations in the app-wide history. Scope remains unchanged. */
  chatTitle?: string;
  activity: { running: number; queued: number };
  latestEventSeq: number;
};
export type HelperStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
export type HelperLimits = { totalCalls: number; helperCalls: number };
/** Host-visible model calls per newly admitted task; native internal requests are unobservable. */
export const HELPER_TASK_LIMITS: Readonly<HelperLimits> = { totalCalls: 128, helperCalls: 64 };
/** Tool callbacks are observable even when a native agent owns its internal model loop. */
export const HELPER_TOOL_CALL_LIMIT = 256;
export type HelperInstruction = {
  id: number;
  requestKey: string;
  text: string;
  status: 'pending' | 'delivered' | 'unconfirmed' | 'not-delivered';
};
export type HelperEditor = EditorContext & {
  /** Saved references are resolved once at admission; device drafts remain analysis input. */
  source?: 'saved' | 'unsaved';
};
export type HelperSelection = { sourceId: string; sourceHash: string; text: string };
/** One explicitly targeted saved library item, not a persistent conversation scope. */
export type HelperResourceRef = {
  kind: 'content' | 'prompt-preset';
  id: string;
  revision: number;
  title: string;
};
export type HelperTaskSnapshot = {
  invalidatedBySceneDeletion?: true;
  /** Frozen when this task is queued. */
  summaryLength?: import('./summary-length.js').SummaryLengthSettings;
  retryOf?: string;
  /** Kept after input cleanup so an admission retry cannot silently change its input. */
  requestFingerprint?: string;
  /** Small selection receipt; not a copy of the plan text. */
  outlineTarget?: import('./outline.js').OutlineTarget;
  requestGroupId?: string;
  scope: HelperScope;
  model: ModelSnapshot;
  contextModel?: ModelSnapshot;
  writing?: RunSnapshot;
  editor?: HelperEditor;
  selection?: HelperSelection;
  outline?: import('./outline.js').OutlineHelperContext;
  history: { id: string; role: 'user' | 'assistant'; text: string }[];
  context?: { activeRevision: number; checkpoint: ContextCheckpointRef | null };
  persona: string;
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
  /** Successful durable writes remain visible even if the explanation fails afterward. */
  completedEffects?: { count: number; labels: string[] };
  instructions?: HelperInstruction[];
};
export type HelperMessage = {
  /** Task outcome travels with paged messages, independently of the task-history window. */
  taskStatus?: HelperStatus;
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
export type HelperMessageMutation = {
  conversation: HelperConversation;
  updatedMessage?: { id: string; text: string };
  deletedMessageIds?: string[];
};
export type HelperArtifact = {
  id: string;
  revision: number;
  origin: 'model' | 'edit';
  conversationId: string;
  taskId: string;
  request: string;
  text: string;
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
export type HelperTaskResultTarget = {
  kind: import('./resource-editing.js').ResourceKind | 'settings';
  id: string;
  title: string;
  revision: number;
  setting?: string;
  /** Only allowlisted settings values, never resource bodies or arbitrary operation arguments. */
  before?: string | number | boolean | null;
  after?: string | number | boolean | null;
  /** Selection titles captured with the commit; later renames do not rewrite history. */
  beforeLabel?: string | null;
  afterLabel?: string | null;
};
/** Compact outcome committed in the same transaction as its durable operation receipt. */
export type HelperTaskResult = {
  eventSeq: number;
  receiptId: string;
  operation: string;
  requestedTargets: number;
  changedTargets: number;
  /** Empty targets with changedTargets=0 confirm an observed no-op. */
  targets: HelperTaskResultTarget[];
};
export type HelperTaskAttemptUsage = {
  id: string;
  purpose: string;
  status: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  /** Native turns may hide internal requests; missing provider reports remain unknown. */
  internalModelCalls: number | null;
};
export type HelperTaskResultsView = {
  taskId: string;
  status: HelperStatus;
  results: HelperTaskResult[];
  /** Receipts without compact outcomes, including old and currently unsupported operations. */
  unrecordedOperations: number;
  usage: {
    attempts: HelperTaskAttemptUsage[];
    toolExecutions: number;
    /** Last recorded local estimate, not the native agent's current context utilization. */
    latestInputEstimate: number | null;
    /** Input budget recorded with that estimate; older tasks may have no known limit. */
    latestInputLimit?: number | null;
  };
};
export type HelperResourceEditResource = {
  kind: import('./resource-editing.js').ResourceKind;
  id: string;
  revision: number;
  title: string;
};
export type HelperResourceEdit = HelperResourceEditResource & {
  editSeq: number;
  taskId: string;
  /** A grouped receipt contains only changed resources; old single-resource events omit this. */
  resources?: HelperResourceEditResource[];
  canUndo: boolean;
  reason?: string;
  undone?: boolean;
};

export function helperResourceEditResources(
  edit: HelperResourceEdit
): readonly HelperResourceEditResource[] {
  return edit.resources?.length ? edit.resources : [edit];
}
