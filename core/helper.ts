import type { EditorContext } from './resource-editing.js';
import type { ModelSnapshot } from './product.js';
import type { RunSnapshot, Usage } from './types.js';
import type { ContextCheckpointRef } from './context-plan.js';

export const DEFAULT_HELPER_TASK_TIMEOUT_MINUTES = 60;
export const MAX_HELPER_TASK_TIMEOUT_MINUTES = Math.floor(2_147_483_647 / 60_000);

export type HelperScope = { kind: 'chat'; chatId: string } | { kind: 'library'; workId: string };
export type HelperConversation = {
  id: string;
  scope: HelperScope;
  title: string;
  revision: number;
  historyRevision?: number;
  persona: string;
  limits: HelperLimits;
  createdAt: string;
  updatedAt: string;
  projectId?: string | null;
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
  chatTitle?: string;
  activity: { running: number; queued: number };
  latestEventSeq: number;
  latestActivityEventSeq: number;
  readActivityEventSeq: number;
  lastTaskStatus?: HelperStatus;
  lastActivityAt: string;
};
export type HelperStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
export type HelperLimits = { totalCalls: number; helperCalls: number };
export const HELPER_TASK_LIMITS: Readonly<HelperLimits> = { totalCalls: 128, helperCalls: 64 };
export const HELPER_TOOL_CALL_LIMIT = 256;
export const HELPER_COMPACTION_INPUT_RATIO = 0.85;
export const HELPER_TOOL_CALL_GRACE = 16;
export type HelperInstruction = {
  id: number;
  requestKey: string;
  text: string;
  status: 'pending' | 'delivered' | 'unconfirmed' | 'not-delivered';
};
export type HelperEditor = EditorContext & {
  source?: 'saved' | 'unsaved';
};
export type HelperSelection = { sourceId: string; sourceHash: string; text: string };
export type HelperResourceRef = {
  kind: 'content' | 'prompt-preset';
  id: string;
  revision: number;
  title: string;
};
export type HelperMode = 'apply' | 'plan';
export type HelperConfirmationReason = 'delete' | 'bulk' | 'paid';
export type HelperConfirmation = {
  id: string;
  taskId: string;
  operation: string;
  reason: HelperConfirmationReason;
  chatId: string | null;
  targets: { kind: string; id: string }[];
  grantedBy: string | null;
  grantable: boolean;
};
export type HelperConfirmedCall = {
  id: string;
  operation: string;
  chatId: string | null;
  arguments?: Record<string, unknown>;
};
export type HelperTaskSnapshot = {
  mode?: 'plan';
  confirmations?: HelperConfirmedCall[];
  confirmPaidGeneration?: true;
  images?: import('./request-images.js').RequestImage[];
  files?: import('./request-files.js').RequestFile[];
  invalidatedBySceneDeletion?: true;
  summaryLength?: import('./summary-length.js').SummaryLengthSettings;
  taskTimeoutMinutes?: number;
  retryOf?: string;
  requestFingerprint?: string;
  outlineTarget?: import('./outline.js').OutlineTarget;
  requestGroupId?: string;
  scope: HelperScope;
  model: ModelSnapshot;
  contextModel?: ModelSnapshot;
  writing?: RunSnapshot;
  editor?: HelperEditor;
  selection?: HelperSelection;
  outline?: import('./outline.js').OutlineHelperContext;
  history: {
    id: string;
    role: 'user' | 'assistant';
    text: string;
    images?: import('./request-images.js').RequestImage[];
    files?: import('./request-files.js').RequestFile[];
  }[];
  context?: { activeRevision: number; checkpoint: ContextCheckpointRef | null };
  persona: string;
  limits: HelperLimits;
};
export type HelperTask = {
  id: string;
  conversationId: string;
  request: string;
  mode: HelperMode;
  status: HelperStatus;
  generation: number;
  error: string | null;
  usage: Usage;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  snapshot: HelperTaskSnapshot;
  completedEffects?: { count: number; labels: string[] };
  instructions?: HelperInstruction[];
};
export type HelperMessage = {
  images?: import('./request-images.js').RequestImage[];
  files?: import('./request-files.js').RequestFile[];
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
  kind:
    | import('./resource-editing.js').ResourceKind
    | 'settings'
    | 'illustration'
    | 'chat'
    | 'translation'
    | 'scene';
  id: string;
  chatId?: string;
  title: string;
  revision: number;
  setting?: string;
  before?: string | number | boolean | null;
  after?: string | number | boolean | null;
  beforeLabel?: string | null;
  afterLabel?: string | null;
};
export type HelperTaskResult = {
  eventSeq: number;
  receiptId: string;
  operation: string;
  requestedTargets: number;
  changedTargets: number;
  targets: HelperTaskResultTarget[];
};
export type HelperChangeDomain =
  | 'resource'
  | 'scene'
  | 'outline'
  | 'notes'
  | 'settings'
  | 'chat-lore';
export type HelperChangeAnchor =
  | {
      domain: 'resource';
      kind: import('./resource-editing.js').ResourceKind;
      id: string;
      path: string | null;
      section: 'lore' | 'prompt' | 'terms' | 'field' | null;
      index: number | null;
    }
  | {
      domain: 'scene';
      chatId: string;
      sourceId: string;
      field: 'original' | 'translation' | 'title';
      paragraph: number | null;
    }
  | { domain: 'outline'; chatId: string; nodeId: string; field: 'title' | 'intent' | null }
  | { domain: 'notes'; chatId: string; noteId: string }
  | { domain: 'settings'; id: string; chatId: string | null; setting: string }
  | { domain: 'chat-lore'; chatId: string; overrideId: string };
export type HelperChangeListSection = 'lore' | 'prompt' | 'terms';
export type HelperChangeLocation =
  | { kind: 'scene'; scene: number | null; field: 'original' | 'translation' | 'title' }
  | { kind: 'resource-field'; path: string[] }
  | {
      kind: 'resource-list';
      path: string[];
      section: HelperChangeListSection;
      item: { name: string | null; type?: string; index: number } | null;
      field: string[];
    }
  | { kind: 'resource-more'; count: number }
  | { kind: 'outline'; level: string; title: string; field: 'title' | 'intent' | null }
  | { kind: 'note'; noteKind: string; text: string }
  | { kind: 'setting'; setting: string }
  | { kind: 'chat-lore' };
export type HelperChange = {
  domain: HelperChangeDomain;
  targetId: string;
  title: string;
  location: HelperChangeLocation | string | null;
  action: 'create' | 'update' | 'delete' | 'reorder';
  diff: import('./text-diff.js').TextDiff | null;
  anchor: HelperChangeAnchor | null;
  textRemoved?: 'deleted' | 'expired';
};
export type HelperRollbackTouch =
  | { domain: 'resource'; kind: import('./resource-editing.js').ResourceKind; id: string }
  | {
      domain: 'scene';
      chatId: string;
      sourceId: string;
      fields: ('original' | 'translation')[];
    }
  | { domain: 'outline'; chatId: string }
  | { domain: 'notes'; chatId: string };
export type HelperRollbackStatus =
  | 'restorable'
  | 'restored'
  | 'changed-since'
  | 'not-covered'
  | 'text-removed'
  | 'failed';
export type HelperRollbackReason =
  | 'changed-after-task'
  | 'changed-during-task'
  | 'created'
  | 'deleted'
  | 'expired'
  | 'other-domain'
  | 'recorded-before-rollback';
export type HelperRollbackUnit = {
  unit: string;
  domain: HelperChangeDomain;
  title: string;
  changeTargetIds: string[];
  status: HelperRollbackStatus;
  reason?: HelperRollbackReason;
  touches: HelperRollbackTouch | null;
  notices?: 'translation-images-not-restored'[];
  error?: string;
};
export type HelperRollbackView = {
  taskId: string;
  blocked: 'task-active' | null;
  units: HelperRollbackUnit[];
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
  internalModelCalls: number | null;
};
export type HelperTaskResultsView = {
  taskId: string;
  status: HelperStatus;
  results: HelperTaskResult[];
  changes: HelperChange[];
  confirmations: HelperConfirmation[];
  unrecordedOperations: number;
  usage: {
    attempts: HelperTaskAttemptUsage[];
    toolExecutions: number;
    latestInputTokens?: number | null;
    latestInputEstimate: number | null;
    knownInputEstimate?: number | null;
    unmeasuredFileCount?: number;
    latestInputLimit?: number | null;
    latestInputParts?: HelperInputParts | null;
    latestInputExecution?: 'provider-tool-loop' | 'codex-native' | null;
  };
};
export type HelperInputParts = {
  instructions: number | null;
  toolSchemas: number | null;
  history: number | null;
  source: number | null;
  toolResults: number | null;
};
