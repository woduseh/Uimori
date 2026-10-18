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
export type HelperConversationSummary = HelperConversation & {
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
