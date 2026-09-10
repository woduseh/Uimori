import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ContextCheckpointRef, ContextPlan } from '../core/context-plan.js';
import type { HelperTask, HelperTaskSnapshot } from '../core/helper.js';
import type { Usage } from '../core/types.js';
import { contextBudgetForModel } from '../core/context-budget.js';
import { checkpointHash } from './context-store.js';
import { HttpError } from './request-validation.js';
import type { Store } from './store.js';

type Row = Record<string, any>;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const refs = (history: HelperTaskSnapshot['history']) =>
  history.map((message) => ({ revision: message.id, hash: hash([message.role, message.text]) }));

/** Model reads need the active reference once, without the UI's checkpoint and job history. */
export function readHelperChatContext(store: Store, chatId: string, branchId: string) {
  const current = store.context.current(chatId, branchId),
    checkpoint = current.checkpoint;
  return {
    scopeKey: current.scopeKey,
    activeRevision: current.activeRevision,
    notesRevision: current.notesRevision,
    headRevision: current.headRevision,
    checkpoint: checkpoint
      ? {
          id: checkpoint.id,
          revision: checkpoint.revision,
          hash: checkpoint.hash,
          origin: checkpoint.origin,
          plan: {
            summary: checkpoint.plan.summary,
            dependencyKey: checkpoint.plan.dependencyKey,
            compacted: checkpoint.plan.compacted,
            recentSourceRevisions: checkpoint.plan.recentSourceRevisions,
          },
        }
      : null,
    usable: current.usable,
    invalidReason: current.invalidReason,
    notes: store.story.notes.entries({
      chatId,
      history: store.history(current.headRevision),
    }),
  };
}

export function helperHistory(store: Store, conversationId: string): HelperTaskSnapshot['history'] {
  return store.db
    .prepare(
      "SELECT m.id,m.role,m.text FROM helper_messages m JOIN helper_tasks t ON t.id=m.task_id WHERE m.conversation_id=? AND NOT EXISTS (SELECT 1 FROM helper_tasks next WHERE next.conversation_id=t.conversation_id AND json_extract(next.snapshot,'$.retryOf')=t.id) ORDER BY (SELECT root.rowid FROM helper_tasks root WHERE root.id=COALESCE(json_extract(t.snapshot,'$.requestGroupId'),t.id)),CASE m.role WHEN 'user' THEN 0 ELSE 1 END"
    )
    .all(conversationId)
    .map((row) => ({
      id: String(row.id),
      role: row.role as 'user' | 'assistant',
      text: String(row.text),
    }));
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
    if (!isDeepStrictEqual(plan.compacted, refs(history).slice(0, plan.compacted.length)))
      throw new HttpError(409, 'HELPER_CONTEXT_DEPENDENCY_CHANGED');
  }
  return { activeRevision: Number(row?.revision ?? 0), checkpoint };
}
export function publishHelperContext(
  store: Store,
  task: HelperTask,
  segment: number,
  summary: string,
  usage: Usage,
  estimatedInputTokens: number,
  base: NonNullable<HelperTaskSnapshot['context']>
) {
  return store.transaction(() => {
    if (
      store.db.prepare('SELECT status FROM helper_tasks WHERE id=?').get(task.id)?.status !==
      'running'
    )
      throw new HttpError(409, 'HELPER_TASK_NO_LONGER_ACTIVE');
    const all = helperHistory(store, task.conversationId);
    const user = store.db
      .prepare("SELECT id FROM helper_messages WHERE task_id=? AND role='user'")
      .get(task.id) as Row;
    const prefix = all.slice(0, all.findIndex((message) => message.id === user.id) + 1);
    if (!isDeepStrictEqual(prefix.slice(0, -1), task.snapshot.history))
      throw new HttpError(409, 'HELPER_CONTEXT_DEPENDENCY_CHANGED');
    const eventRows = store.db
      .prepare('SELECT seq,kind,data FROM helper_events WHERE task_id=? AND kind=? ORDER BY seq')
      .all(task.id, 'tool.finished') as Row[];
    const scopeKey = `helper:${task.conversationId}`,
      revision = base.activeRevision + 1;
    const plan: ContextPlan = {
      version: 1,
      status: 'ready',
      budget: contextBudgetForModel(task.snapshot.model),
      dependencyKey: scopeKey,
      estimatedInputTokens,
      compacted: refs(prefix),
      recentSourceRevisions: [],
      summary,
      summaryCalls: usage.modelCalls,
      usage,
      error: null,
    };
    const checkpoint = {
      id: randomUUID(),
      revision,
      hash: checkpointHash(scopeKey, revision, plan),
    };
    const current = helperContext(store, task.conversationId, all);
    const activated =
      current.activeRevision === base.activeRevision &&
      isDeepStrictEqual(current.checkpoint, base.checkpoint);
    const snapshot = {
      kind: 'helper',
      conversationId: task.conversationId,
      taskId: task.id,
      segment,
      messageRefs: plan.compacted,
      eventRefs: eventRows.map((row) => ({
        seq: row.seq,
        hash: hash([row.kind, JSON.parse(row.data)]),
      })),
      base,
    };
    const chatId = task.snapshot.scope.kind === 'chat' ? task.snapshot.scope.chatId : null;
    store.db
      .prepare('INSERT INTO context_checkpoints VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(
        checkpoint.id,
        scopeKey,
        chatId,
        revision,
        checkpoint.hash,
        'automatic',
        JSON.stringify(plan),
        JSON.stringify(snapshot),
        new Date().toISOString(),
        Number(activated)
      );
    if (activated)
      store.db
        .prepare(
          'INSERT INTO context_heads VALUES(?,?,?,?) ON CONFLICT(scope_key) DO UPDATE SET revision=excluded.revision,checkpoint_id=excluded.checkpoint_id'
        )
        .run(scopeKey, chatId, revision, checkpoint.id);
    return { activeRevision: activated ? revision : base.activeRevision, checkpoint, activated };
  });
}
export function validateHelperContexts(store: Store) {
  for (const row of store.db
    .prepare("SELECT * FROM context_checkpoints WHERE scope_key LIKE 'helper:%'")
    .all() as Row[]) {
    const snapshot = JSON.parse(row.snapshot),
      taskRow = store.db.prepare('SELECT * FROM helper_tasks WHERE id=?').get(snapshot.taskId) as
        | Row
        | undefined;
    const conversation = store.db
      .prepare('SELECT * FROM helper_conversations WHERE id=?')
      .get(snapshot.conversationId) as Row | undefined;
    const checkpoint = store.context.checkpoint({
      id: row.id,
      revision: row.revision,
      hash: row.hash,
    });
    if (
      snapshot.kind !== 'helper' ||
      !conversation ||
      !taskRow ||
      taskRow.conversation_id !== conversation.id ||
      row.scope_key !== `helper:${conversation.id}` ||
      row.chat_id !== conversation.chat_id ||
      !Number.isSafeInteger(snapshot.segment) ||
      snapshot.segment < 1 ||
      !['automatic', 'edit', 'manual'].includes(row.origin) ||
      ![0, 1].includes(row.activated)
    )
      throw new HttpError(400, 'Invalid helper checkpoint owner');
    const expected = refs(helperHistory(store, conversation.id)).slice(
      0,
      checkpoint.plan.compacted.length
    );
    if (
      !isDeepStrictEqual(expected, checkpoint.plan.compacted) ||
      !isDeepStrictEqual(expected, snapshot.messageRefs) ||
      checkpoint.plan.dependencyKey !== row.scope_key ||
      !checkpoint.plan.summary?.trim()
    )
      throw new HttpError(400, 'Invalid helper checkpoint messages');
    for (const event of snapshot.eventRefs) {
      const source = store.db
        .prepare('SELECT * FROM helper_events WHERE seq=? AND task_id=?')
        .get(event.seq, snapshot.taskId) as Row | undefined;
      if (!source || hash([source.kind, JSON.parse(source.data)]) !== event.hash)
        throw new HttpError(400, 'Invalid helper checkpoint event');
    }
    if (snapshot.base.checkpoint) store.context.checkpoint(snapshot.base.checkpoint);
  }
}
