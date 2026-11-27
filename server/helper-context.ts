import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ContextCheckpointRef, ContextPlan } from '../core/context-plan.js';
import {
  HELPER_COMPACTION_INPUT_RATIO,
  type HelperCompactionFailure,
  type HelperCompactionOutcome,
  type HelperCompactionState,
  type HelperContextCompactionSummary,
  type HelperContextSummaryView,
  type HelperScope,
  type HelperSummaryChange,
  type HelperTask,
  type HelperTaskSnapshot,
} from '../core/helper.js';
import type { ModelSnapshot } from '../core/product.js';
import type { Usage } from '../core/types.js';
import { contextBudgetForModel, estimateContextTokens } from '../core/context-budget.js';
import { pruneContextHistory } from './context-retention.js';
import { checkpointHash } from './context-store.js';
import { AppError } from './app-errors.js';
import { HttpError, fields, record } from './request-validation.js';
import type { Store } from './store.js';
import { helperMessageAttachments } from './helper-attachments.js';

type Row = Record<string, any>;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const refs = (history: HelperTaskSnapshot['history']) =>
  history.map((message) => ({
    revision: message.id,
    hash: hash([
      message.role,
      message.text,
      ...(message.images?.length || message.files?.length
        ? [message.images ?? [], message.files ?? []]
        : []),
    ]),
  }));

const CONTEXT_SECTIONS = ['summary', 'notes', 'storyGuide'] as const;
export function readHelperChatContext(store: Store, chatId: string, value: unknown = {}) {
  const args = record(value);
  fields(args, ['sections', 'includeCompacted']);
  if (
    args.sections !== undefined &&
    (!Array.isArray(args.sections) ||
      !args.sections.length ||
      args.sections.some((section) => !CONTEXT_SECTIONS.includes(section)))
  )
    throw new HttpError(400, `Invalid sections: use ${CONTEXT_SECTIONS.join(', ')}`);
  if (args.includeCompacted !== undefined && typeof args.includeCompacted !== 'boolean')
    throw new HttpError(400, 'Invalid includeCompacted');
  const sections = new Set<string>(args.sections ?? CONTEXT_SECTIONS);
  const current = store.context.current(chatId),
    checkpoint = current.checkpoint;
  const { revision, config } = store.storyGuide.get(chatId);
  return {
    ...(sections.has('storyGuide') ? { storyGuide: { revision, config } } : {}),
    scopeKey: current.scopeKey,
    activeRevision: current.activeRevision,
    notesRevision: current.notesRevision,
    headRevision: current.headRevision,
    ...(sections.has('summary')
      ? {
          checkpoint: checkpoint
            ? {
                id: checkpoint.id,
                revision: checkpoint.revision,
                hash: checkpoint.hash,
                origin: checkpoint.origin,
                plan: {
                  summary: checkpoint.plan.summary,
                  dependencyKey: checkpoint.plan.dependencyKey,
                  compactedScenes: checkpoint.plan.compacted.length,
                  ...(args.includeCompacted === true
                    ? { compacted: checkpoint.plan.compacted }
                    : {}),
                  recentSourceRevisions: checkpoint.plan.recentSourceRevisions,
                },
              }
            : null,
          usable: current.usable,
          invalidReason: current.invalidReason,
        }
      : {}),
    ...(sections.has('notes')
      ? {
          notes: store.story.notes.entries({
            chatId,
            history: store.history(current.headRevision),
          }),
        }
      : {}),
  };
}

export function helperHistory(store: Store, conversationId: string): HelperTaskSnapshot['history'] {
  return store.db
    .prepare(
      `WITH visible AS (
        SELECT s.id,s.role,COALESCE(c.text,s.text) AS text,0 AS phase,s.ordinal AS position
        FROM helper_seed_messages s LEFT JOIN helper_message_changes c ON c.message_id=s.id
        WHERE s.conversation_id=? AND COALESCE(c.deleted,0)=0
        UNION ALL
        SELECT m.id,m.role,COALESCE(c.text,m.text) AS text,1 AS phase,
          (SELECT root.rowid FROM helper_tasks root WHERE root.id=COALESCE(json_extract(t.snapshot,'$.requestGroupId'),t.id)) AS position
        FROM helper_messages m JOIN helper_tasks t ON t.id=m.task_id
        LEFT JOIN helper_message_changes c ON c.message_id=m.id
        WHERE m.conversation_id=? AND COALESCE(c.deleted,0)=0 AND NOT EXISTS (SELECT 1 FROM helper_tasks next WHERE next.conversation_id=t.conversation_id AND json_extract(next.snapshot,'$.retryOf')=t.id)
      ) SELECT id,role,text FROM visible ORDER BY phase,position,CASE role WHEN 'user' THEN 0 ELSE 1 END`
    )
    .all(conversationId, conversationId)
    .map((row) => ({
      id: String(row.id),
      role: row.role as 'user' | 'assistant',
      text: String(row.text),
      ...helperMessageAttachments(store.db, String(row.id)),
    }));
}

export function helperHistoryForContext(
  store: Store,
  history: HelperTaskSnapshot['history'],
  context: Pick<NonNullable<HelperTaskSnapshot['context']>, 'checkpoint'>
) {
  const plan = context.checkpoint ? store.context.checkpoint(context.checkpoint).plan : undefined;
  return {
    history: plan ? history.slice(plan.compacted.length) : history,
    summary: plan?.summary ?? '',
  };
}
export function helperContext(
  store: Store,
  conversationId: string,
  history: HelperTaskSnapshot['history']
) {
  const row = store.db
    .prepare('SELECT * FROM context_heads WHERE scope_key=?')
    .get(`helper:${conversationId}`) as Row | undefined;
  const checkpoint = row?.checkpoint_id
    ? (store.db
        .prepare('SELECT id,revision,hash FROM context_checkpoints WHERE id=?')
        .get(row.checkpoint_id) as ContextCheckpointRef)
    : null;
  if (checkpoint) {
    const plan = store.context.checkpoint(checkpoint).plan;
    if (
      !isDeepStrictEqual(plan.compacted, refs(history.slice(0, plan.compacted.length))) ||
      !isDeepStrictEqual(
        plan.recentSourceRevisions,
        history
          .slice(plan.compacted.length, plan.compacted.length + plan.recentSourceRevisions.length)
          .map((message) => message.id)
      )
    )
      throw new AppError(409, 'HELPER_CONTEXT_DEPENDENCY_CHANGED');
  }
  return { activeRevision: Number(row?.revision ?? 0), checkpoint };
}

function lastManualCompaction(
  store: Store,
  conversationId: string
): HelperCompactionOutcome | null {
  const row = store.db
    .prepare(
      `SELECT e.kind,e.data FROM helper_events e
       WHERE e.conversation_id=? AND e.task_id IS NULL
         AND e.kind IN ('context.compaction','context.compaction.edited','context.compaction.failed')
         AND NOT EXISTS (SELECT 1 FROM helper_events later WHERE later.conversation_id=e.conversation_id
           AND later.seq>e.seq AND (later.task_id IS NOT NULL OR later.kind='messages.changed'))
       ORDER BY e.seq DESC LIMIT 1`
    )
    .get(conversationId) as Row | undefined;
  if (!row) return null;
  const data = JSON.parse(String(row.data)) as Record<string, unknown>;
  if (typeof data.finishedAt !== 'string') return null;
  return row.kind !== 'context.compaction.failed'
    ? {
        status: 'completed',
        finishedAt: data.finishedAt,
        compactedMessages: Number(data.compactedMessages),
        beforeTokens: Number(data.beforeTokens),
        afterTokens: Number(data.afterTokens),
        ...(row.kind === 'context.compaction.edited'
          ? { origin: data.origin === 'reset' ? ('reset' as const) : ('edit' as const) }
          : {}),
      }
    : {
        status: 'failed',
        finishedAt: data.finishedAt,
        code: data.code as HelperCompactionFailure,
      };
}

export function readHelperContextState(
  store: Store,
  conversationId: string,
  running: HelperCompactionState['running'] = null
): HelperContextCompactionSummary {
  const compaction = { running, last: lastManualCompaction(store, conversationId) };
  const { history, revision, checkpoint } = activeHelperCheckpoint(store, conversationId);
  const compactedMessages = checkpoint
    ? Math.min(history.length, checkpoint.plan.compacted.length)
    : 0;
  return {
    compactedMessages,
    uncompactedMessages: Math.max(0, history.length - compactedMessages),
    totalMessages: history.length,
    checkpointRevision: revision,
    summaryChars: checkpoint?.plan.summary?.length ?? 0,
    compaction,
  };
}

export function helperRequestContext(store: Store, conversationId: string, retryOf?: string) {
  const history = helperHistory(store, conversationId);
  const context = helperContext(store, conversationId, history);
  if (!retryOf) return { history, context, invalidatesCheckpoint: false };
  const replaced = new Set(
    store.db
      .prepare('SELECT id FROM helper_messages WHERE conversation_id=? AND task_id=?')
      .all(conversationId, retryOf)
      .map((row) => String(row.id))
  );
  const plan = context.checkpoint ? store.context.checkpoint(context.checkpoint).plan : undefined;
  const invalidatesCheckpoint =
    !!plan &&
    (plan.compacted.some((message) => replaced.has(message.revision)) ||
      plan.recentSourceRevisions.some((messageId) => replaced.has(messageId)));
  return {
    history: history.filter((message) => !replaced.has(message.id)),
    context: invalidatesCheckpoint
      ? { activeRevision: context.activeRevision + 1, checkpoint: null }
      : context,
    invalidatesCheckpoint,
  };
}
export function publishHelperContext(
  store: Store,
  task: HelperTask,
  summary: string,
  usage: Usage,
  estimatedInputTokens: number,
  base: NonNullable<HelperTaskSnapshot['context']>,
  retainedHistory: HelperTaskSnapshot['history'] = []
) {
  return store.transaction(() => {
    if (
      store.db.prepare('SELECT status FROM helper_tasks WHERE id=?').get(task.id)?.status !==
      'running'
    )
      throw new AppError(409, 'HELPER_TASK_NO_LONGER_ACTIVE');
    const all = helperHistory(store, task.conversationId);
    const user = store.db
      .prepare("SELECT id FROM helper_messages WHERE task_id=? AND role='user'")
      .get(task.id) as Row;
    const prefix = all.slice(0, all.findIndex((message) => message.id === user.id) + 1);
    if (!isDeepStrictEqual(prefix.slice(0, -1), task.snapshot.history))
      throw new AppError(409, 'HELPER_CONTEXT_DEPENDENCY_CHANGED');
    const compactedCount = prefix.length - 1 - retainedHistory.length;
    if (compactedCount < 0 || !isDeepStrictEqual(prefix.slice(compactedCount, -1), retainedHistory))
      throw new AppError(409, 'HELPER_CONTEXT_DEPENDENCY_CHANGED');
    const scopeKey = `helper:${task.conversationId}`,
      revision = base.activeRevision + 1;
    const plan: ContextPlan = {
      version: 1,
      status: 'ready',
      budget: contextBudgetForModel(task.snapshot.model),
      dependencyKey: scopeKey,
      estimatedInputTokens,
      compacted: refs(prefix.slice(0, compactedCount)),
      recentSourceRevisions: prefix.slice(compactedCount).map((message) => message.id),
      summary,
      summaryCalls: usage.modelCalls,
      usage,
      error: null,
    };
    const current = helperContext(store, task.conversationId, all);
    const activated =
      current.activeRevision === base.activeRevision &&
      isDeepStrictEqual(current.checkpoint, base.checkpoint);
    const checkpoint = storeHelperCheckpoint(
      store,
      task.conversationId,
      task.snapshot.scope,
      revision,
      'automatic',
      plan,
      activated
    );
    return { activeRevision: activated ? revision : base.activeRevision, checkpoint, activated };
  });
}

function storeHelperCheckpoint(
  store: Store,
  conversationId: string,
  scope: HelperScope,
  revision: number,
  origin: 'automatic' | 'manual' | 'edit',
  plan: ContextPlan,
  activated: boolean
): ContextCheckpointRef {
  const scopeKey = `helper:${conversationId}`;
  const checkpoint = { id: randomUUID(), revision, hash: checkpointHash(scopeKey, revision, plan) };
  const chatId = scope.kind === 'chat' ? scope.chatId : null;
  store.db
    .prepare('INSERT INTO context_checkpoints VALUES(?,?,?,?,?,?,?,?,?)')
    .run(
      checkpoint.id,
      scopeKey,
      chatId,
      revision,
      checkpoint.hash,
      origin,
      JSON.stringify(plan),
      new Date().toISOString(),
      Number(activated)
    );
  if (activated)
    store.db
      .prepare(
        'INSERT INTO context_heads VALUES(?,?,?,?) ON CONFLICT(scope_key) DO UPDATE SET revision=excluded.revision,checkpoint_id=excluded.checkpoint_id'
      )
      .run(scopeKey, chatId, revision, checkpoint.id);
  return checkpoint;
}

function assertHelperContextIdle(store: Store, conversationId: string) {
  const busy = store.db
    .prepare(
      "SELECT 1 FROM helper_tasks WHERE conversation_id=? AND status IN ('queued','running') LIMIT 1"
    )
    .get(conversationId);
  if (busy) throw new AppError(409, 'HELPER_COMPACTION_BUSY');
}

const summaryTokenLimit = (model: ModelSnapshot) =>
  Math.floor(contextBudgetForModel(model).inputTokenLimit * HELPER_COMPACTION_INPUT_RATIO);

function activeHelperCheckpoint(store: Store, conversationId: string) {
  const history = helperHistory(store, conversationId);
  const row = store.db
    .prepare('SELECT revision,checkpoint_id FROM context_heads WHERE scope_key=?')
    .get(`helper:${conversationId}`) as Row | undefined;
  let checkpoint = null;
  if (row?.checkpoint_id)
    try {
      const current = helperContext(store, conversationId, history);
      if (current.checkpoint) checkpoint = store.context.checkpoint(current.checkpoint);
    } catch {}
  return {
    history,
    revision: Number(row?.revision ?? 0),
    checkpoint,
    headCheckpointId: row?.checkpoint_id ? String(row.checkpoint_id) : null,
  };
}

export function readHelperContextSummary(
  store: Store,
  conversationId: string,
  helperModel: ModelSnapshot | null,
  busy: boolean
): HelperContextSummaryView {
  const { history, revision, checkpoint } = activeHelperCheckpoint(store, conversationId);
  const summary = checkpoint?.plan.summary ?? null;
  const blockedReason = busy
    ? ('HELPER_COMPACTION_BUSY' as const)
    : helperModel
      ? null
      : ('MODEL_REQUIRED:helper' as const);
  return {
    checkpointRevision: revision,
    summary,
    origin: checkpoint?.origin ?? null,
    createdAt: checkpoint?.createdAt ?? null,
    compactedMessages: checkpoint ? Math.min(history.length, checkpoint.plan.compacted.length) : 0,
    totalMessages: history.length,
    summaryTokens:
      summary === null
        ? null
        : estimateContextTokens(
            summary,
            helperModel ? contextBudgetForModel(helperModel) : undefined
          ),
    budgetTokens: helperModel ? summaryTokenLimit(helperModel) : null,
    editable: summary !== null && blockedReason === null,
    blockedReason,
  };
}

export type HelperSummaryChangeEvent = {
  origin: HelperSummaryChange;
  beforeTokens: number;
  afterTokens: number;
  compactedMessages: number;
  checkpointRevision: number;
  finishedAt: string;
};

function summaryChange(
  store: Store,
  conversationId: string,
  origin: HelperSummaryChange,
  previousTokens: number,
  afterTokens: number,
  compactedMessages: number,
  checkpointRevision: number
): HelperSummaryChangeEvent {
  const visible = lastManualCompaction(store, conversationId);
  return {
    origin,
    beforeTokens: visible?.status === 'completed' ? visible.beforeTokens : previousTokens,
    afterTokens,
    compactedMessages,
    checkpointRevision,
    finishedAt: new Date().toISOString(),
  };
}

export function publishEditedHelperContext(
  store: Store,
  conversationId: string,
  scope: HelperScope,
  helperModel: ModelSnapshot,
  expectedRevision: number,
  summary: string
): HelperSummaryChangeEvent | null {
  return store.transaction(() => {
    assertHelperContextIdle(store, conversationId);
    const history = helperHistory(store, conversationId);
    const current = helperContext(store, conversationId, history);
    if (current.activeRevision !== expectedRevision || !current.checkpoint)
      throw new AppError(409, 'HELPER_CONTEXT_DEPENDENCY_CHANGED');
    const previous = store.context.checkpoint(current.checkpoint);
    if (previous.plan.summary === summary) return null;
    const budget = contextBudgetForModel(helperModel);
    const afterTokens = estimateContextTokens(summary, budget);
    if (afterTokens > summaryTokenLimit(helperModel))
      throw new AppError(400, 'HELPER_SUMMARY_TOO_LARGE');
    const revision = current.activeRevision + 1;
    storeHelperCheckpoint(
      store,
      conversationId,
      scope,
      revision,
      'edit',
      { ...previous.plan, summary, estimatedInputTokens: afterTokens },
      true
    );
    pruneContextHistory(store.db);
    return summaryChange(
      store,
      conversationId,
      'edit',
      estimateContextTokens(previous.plan.summary ?? '', budget),
      afterTokens,
      previous.plan.compacted.length,
      revision
    );
  });
}

export function resetHelperContext(
  store: Store,
  conversationId: string,
  helperModel: ModelSnapshot | null,
  expectedRevision: number
): HelperSummaryChangeEvent | null {
  return store.transaction(() => {
    assertHelperContextIdle(store, conversationId);
    const { history, revision, checkpoint, headCheckpointId } = activeHelperCheckpoint(
      store,
      conversationId
    );
    if (!headCheckpointId) return null;
    if (revision !== expectedRevision) throw new AppError(409, 'HELPER_CONTEXT_DEPENDENCY_CHANGED');
    store.db
      .prepare('UPDATE context_heads SET revision=revision+1,checkpoint_id=NULL WHERE scope_key=?')
      .run(`helper:${conversationId}`);
    pruneContextHistory(store.db);
    const budget = helperModel ? contextBudgetForModel(helperModel) : undefined;
    return summaryChange(
      store,
      conversationId,
      'reset',
      estimateContextTokens(checkpoint?.plan.summary ?? '', budget),
      estimateContextTokens(history.slice(0, checkpoint?.plan.compacted.length ?? 0), budget),
      0,
      revision + 1
    );
  });
}

export function publishManualHelperContext(
  store: Store,
  conversationId: string,
  scope: HelperScope,
  helperModel: ModelSnapshot,
  summary: string,
  usage: Usage,
  estimatedInputTokens: number,
  base: NonNullable<HelperTaskSnapshot['context']>,
  history: HelperTaskSnapshot['history']
) {
  return store.transaction(() => {
    assertHelperContextIdle(store, conversationId);
    const all = helperHistory(store, conversationId);
    if (!isDeepStrictEqual(all, history))
      throw new AppError(409, 'HELPER_CONTEXT_DEPENDENCY_CHANGED');
    const current = helperContext(store, conversationId, all);
    if (
      current.activeRevision !== base.activeRevision ||
      !isDeepStrictEqual(current.checkpoint, base.checkpoint)
    )
      throw new AppError(409, 'HELPER_CONTEXT_DEPENDENCY_CHANGED');
    const scopeKey = `helper:${conversationId}`;
    const revision = base.activeRevision + 1;
    const plan: ContextPlan = {
      version: 1,
      status: 'ready',
      budget: contextBudgetForModel(helperModel),
      dependencyKey: scopeKey,
      estimatedInputTokens,
      compacted: refs(all),
      recentSourceRevisions: [],
      summary,
      summaryCalls: usage.modelCalls,
      usage,
      error: null,
    };
    const checkpoint = storeHelperCheckpoint(
      store,
      conversationId,
      scope,
      revision,
      'manual',
      plan,
      true
    );
    pruneContextHistory(store.db);
    return { activeRevision: revision, checkpoint };
  });
}
