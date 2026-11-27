import { isDeepStrictEqual } from 'node:util';
import {
  HELPER_REVERTED_CHANGES_LIMIT,
  type HelperChange,
  type HelperChangeDomain,
  type HelperRevertedChange,
  type HelperRollbackReason,
  type HelperRollbackStatus,
  type HelperRollbackTouch,
  type HelperRollbackUnit,
  type HelperRollbackView,
  type HelperTaskSnapshot,
} from '../core/helper.js';
import type { AuthorNote } from '../core/notes.js';
import {
  editableResource,
  type ResourceKind,
  type ResourceModel,
} from '../core/resource-editing.js';
import {
  authoredView,
  captureHelperTarget,
  contentPackageSettings,
  helperChatLoreOverride,
  helperResourceHash,
  helperStateHash,
  helperTargetHash,
  type ChatLoreBaseline,
  type HelperChangeTarget,
  type NoteState,
  type OutlineState,
} from './helper-changes.js';
import { ChatOverridesStore } from './chat-overrides.js';
import type { HelperWorkspace } from './helper-workspace.js';
import { AppError } from './app-errors.js';
import { HttpError } from './request-validation.js';
import { readResource, saveResource } from './resource-service.js';
import { latestTranslation } from './source-editing.js';
import type { Store } from './store.js';

type Row = {
  domain: HelperChangeDomain;
  target_id: string;
  chat_id: string | null;
  source_id: string | null;
  baseline: string | null;
  entries: string;
  text_removed: 'deleted' | 'expired' | null;
  result: string | null;
  foreign_edit: number;
  rolled_back_at: string | null;
};
type Unit = { unit: string; domain: HelperChangeDomain; rows: Row[] };
type Assessment = { status: HelperRollbackStatus; reason?: HelperRollbackReason };
type Effects = {
  sceneUpdated?: (sourceId: string) => void;
  chatChanged?: (chatId: string) => void;
};
type Notice = NonNullable<HelperRollbackUnit['notices']>[number];

const ROLLBACK_AUTHOR = '도우미 변경 되돌리기';

const field = (row: Pick<Row, 'target_id'>) =>
  row.target_id.slice(row.target_id.lastIndexOf(':') + 1);
const parsed = (row: Row): unknown => (row.baseline === null ? null : JSON.parse(row.baseline));
const entriesOf = (row: Pick<Row, 'entries'>) => JSON.parse(row.entries) as HelperChange[];
function resourceKey(row: Pick<Row, 'target_id'>): { kind: ResourceKind; id: string } {
  const at = row.target_id.indexOf(':');
  return { kind: row.target_id.slice(0, at) as ResourceKind, id: row.target_id.slice(at + 1) };
}

function unitKey(row: Pick<Row, 'domain' | 'target_id' | 'source_id'>) {
  if (row.domain === 'scene')
    return field(row) === 'title' ? `scene-title:${row.source_id}` : `scene:${row.source_id}`;
  return `${row.domain}:${row.target_id}`;
}

function readUnits(store: Store, taskId: string): Unit[] {
  const units = new Map<string, Unit>();
  for (const row of store.db
    .prepare(
      'SELECT domain,target_id,chat_id,source_id,baseline,entries,text_removed,result,foreign_edit,rolled_back_at FROM helper_changes WHERE task_id=? ORDER BY position'
    )
    .all(taskId) as Row[]) {
    const key = unitKey(row);
    const unit = units.get(key) ?? { unit: key, domain: row.domain, rows: [] };
    unit.rows.push(row);
    units.set(key, unit);
  }
  return [...units.values()];
}

function target(row: Row): HelperChangeTarget | null {
  if (row.domain === 'scene')
    return {
      domain: 'scene',
      chatId: row.chat_id!,
      sourceId: row.source_id!,
      field: field(row) as 'original' | 'translation',
    };
  if (row.domain === 'outline' || row.domain === 'notes')
    return { domain: row.domain, chatId: row.chat_id! };
  return null;
}

const loreBaseline = (row: Row) => parsed(row) as ChatLoreBaseline;

function currentHash(store: Store, row: Row) {
  if (row.domain === 'resource') {
    const { kind, id } = resourceKey(row);
    return helperResourceHash(kind, readResource(store, kind, id));
  }
  if (row.domain === 'chat-lore')
    return helperStateHash(
      helperChatLoreOverride(
        new ChatOverridesStore(store).current(row.chat_id!, loreBaseline(row).selector)
      )
    );
  return helperTargetHash(target(row)!, captureHelperTarget(store, target(row)!).value);
}

function leftAsRecorded(store: Store, row: Row) {
  if (currentHash(store, row) === row.result) return true;
  if (row.domain !== 'resource' || resourceKey(row).kind !== 'content') return false;
  const current = editableResource('content', readResource(store, 'content', resourceKey(row).id));
  return (
    helperStateHash(authoredView('content', current)) === row.result &&
    isDeepStrictEqual(contentPackageSettings(current), contentPackageSettings(parsed(row)))
  );
}

function covered(unit: Unit) {
  return (
    unit.domain === 'resource' ||
    unit.domain === 'outline' ||
    unit.domain === 'notes' ||
    unit.domain === 'chat-lore' ||
    unit.unit.startsWith('scene:')
  );
}

function assess(store: Store, unit: Unit): Assessment {
  if (!covered(unit)) return { status: 'not-covered', reason: 'other-domain' };
  const removed = unit.rows.find((row) => row.text_removed);
  if (removed) return { status: 'text-removed', reason: removed.text_removed! };
  if (unit.rows.every((row) => row.rolled_back_at)) return { status: 'restored' };
  if (unit.domain === 'resource' && unit.rows[0]!.baseline === 'null')
    return {
      status: 'not-covered',
      reason: entriesOf(unit.rows[0]!).some((entry) => entry.action === 'delete')
        ? 'deleted'
        : 'created',
    };
  if (unit.rows.some((row) => row.result === null))
    return { status: 'not-covered', reason: 'recorded-before-rollback' };
  if (unit.rows.some((row) => row.foreign_edit))
    return { status: 'changed-since', reason: 'changed-during-task' };
  if (unit.rows.some((row) => !leftAsRecorded(store, row)))
    return { status: 'changed-since', reason: 'changed-after-task' };
  if (unit.domain === 'scene') {
    const original = unit.rows.find((row) => field(row) === 'original');
    const translation = unit.rows.find((row) => field(row) === 'translation');
    const sourceId = unit.rows[0]!.source_id!;
    const sourceKept = !original || parsed(original) === store.source(sourceId).text;
    if (
      translation &&
      parsed(translation) === null &&
      sourceKept &&
      captureHelperTarget(store, target(translation)!).value !== null
    )
      return { status: 'not-covered', reason: 'created' };
  }
  return { status: 'restorable' };
}

function touches(unit: Unit): HelperRollbackTouch | null {
  const row = unit.rows[0]!;
  if (unit.domain === 'resource') return { domain: 'resource', ...resourceKey(row) };
  if (unit.unit.startsWith('scene:'))
    return {
      domain: 'scene',
      chatId: row.chat_id!,
      sourceId: row.source_id!,
      fields: unit.rows.map((item) => field(item) as 'original' | 'translation'),
    };
  if (unit.domain === 'outline' || unit.domain === 'notes')
    return { domain: unit.domain, chatId: row.chat_id! };
  return null;
}

function unitTitle(
  store: Store,
  entries: readonly HelperChange[],
  row: Pick<Row, 'chat_id' | 'target_id'>
) {
  let title = entries[0]?.title;
  if (!title && row.chat_id) {
    try {
      title = store.chat(row.chat_id).title;
    } catch {}
  }
  return title ?? row.target_id;
}

function describe(store: Store, unit: Unit, assessment: Assessment): HelperRollbackUnit {
  const entries = unit.rows.flatMap(entriesOf);
  return {
    unit: unit.unit,
    domain: unit.domain,
    title: unitTitle(store, entries, unit.rows[0]!),
    changeTargetIds: [...new Set(entries.map((entry) => entry.targetId))],
    status: assessment.status,
    ...(assessment.reason ? { reason: assessment.reason } : {}),
    touches: covered(unit) ? touches(unit) : null,
  };
}

function activeTask(store: Store, conversationId: string) {
  return !!store.db
    .prepare(
      "SELECT 1 FROM helper_tasks WHERE conversation_id=? AND status IN ('queued','running') LIMIT 1"
    )
    .get(conversationId);
}

export function helperRollbackView(
  store: Store,
  workspace: HelperWorkspace,
  taskId: string
): HelperRollbackView {
  const task = workspace.taskState(taskId);
  return {
    taskId,
    blocked: activeTask(store, task.conversationId) ? 'task-active' : null,
    units: readUnits(store, taskId).flatMap((unit) => {
      const assessment = assessSafely(store, unit);
      return silent(store, unit, assessment) ? [] : [describe(store, unit, assessment)];
    }),
  };
}

function assessSafely(store: Store, unit: Unit): Assessment {
  try {
    return assess(store, unit);
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 404)
      return { status: 'text-removed', reason: 'deleted' };
    throw error;
  }
}

function silent(store: Store, unit: Unit, assessment: Assessment) {
  return (
    unit.domain === 'scene' &&
    !unit.rows.some((row) => entriesOf(row).length) &&
    (assessment.status !== 'restorable' ||
      unit.rows.every(
        (row) => helperStateHash(parsed(row)) === helperStateHash(captureState(store, row))
      ))
  );
}

function captureState(store: Store, row: Row) {
  return captureHelperTarget(store, target(row)!).value;
}

function restoreScene(store: Store, unit: Unit, notices: Set<Notice>) {
  const sourceId = unit.rows[0]!.source_id!;
  const original = unit.rows.find((row) => field(row) === 'original');
  const translation = unit.rows.find((row) => field(row) === 'translation');
  let source = store.source(sourceId);
  const text = original ? parsed(original) : null;
  if (typeof text === 'string' && text !== source.text)
    source = store.editSource(sourceId, { text, expectedRevision: source.editRevision ?? 0 });
  if (!translation) return;
  const desired = parsed(translation);
  if (typeof desired !== 'string' || captureState(store, translation) === desired) return;
  store.editTranslation(sourceId, {
    text: desired,
    expectedRevision: latestTranslation(store, sourceId)?.revision ?? 0,
    expectedSourceHash: source.hash,
  });
  notices.add('translation-images-not-restored');
}

function restoreResource(store: Store, row: Row) {
  const { kind, id } = resourceKey(row);
  const saved = readResource(store, kind, id);
  saveResource(store, {
    kind,
    id,
    expectedRevision: saved.revision,
    model: parsed(row) as ResourceModel,
  });
}

function restoreOutline(store: Store, row: Row, key: string) {
  const chatId = row.chat_id!;
  const baseline = parsed(row) as OutlineState;
  const wanted = new Map(baseline.map((node) => [node.id, node]));
  const apply = (step: string, operations: (revision: (id: string) => number) => unknown[]) => {
    const revisions = new Map(store.outline.nodes(chatId).map((node) => [node.id, node.revision]));
    const list = operations((id) => {
      const value = revisions.get(id)!;
      revisions.set(id, value + 1);
      return value;
    });
    return list.length
      ? store.outline.applyReceipt(
          chatId,
          { idempotencyKey: `${key}:${step}`, operations: list },
          'user'
        ).created
      : [];
  };
  const current = store.outline.nodes(chatId);
  const live = new Map(current.map((node) => [node.id, node]));
  const reshaped = current.filter((node) => {
    const old = wanted.get(node.id);
    return old && (old.parentId !== node.parentId || old.level !== node.level);
  });
  apply('detach', (revision) => [
    ...reshaped
      .filter((node) => node.parentId !== null)
      .map((node) => ({
        op: 'move',
        id: node.id,
        expectedRevision: revision(node.id),
        parentId: null,
        position: node.position,
      })),
    ...current
      .filter(
        (node) => !wanted.has(node.id) && (node.parentId === null || wanted.has(node.parentId))
      )
      .map((node) => ({ op: 'remove', id: node.id, expectedRevision: revision(node.id) })),
    ...reshaped
      .filter((node) => node.level !== wanted.get(node.id)!.level)
      .map((node) => ({
        op: 'update',
        id: node.id,
        expectedRevision: revision(node.id),
        level: wanted.get(node.id)!.level,
      })),
  ]);
  const ids = new Map<string, string>(baseline.map((node) => [node.id, node.id]));
  const created = apply('create', () =>
    baseline
      .filter((node) => !live.has(node.id))
      .map((node) => ({
        op: 'create',
        ref: node.id,
        ...(node.parentId === null
          ? {}
          : live.has(node.parentId)
            ? { parentId: node.parentId }
            : { parentRef: node.parentId }),
        level: node.level,
        title: node.title,
        intent: node.intent,
        position: node.position,
      }))
  );
  for (const node of created) ids.set(node.ref!, node.id);
  const restored = new Map(store.outline.nodes(chatId).map((node) => [node.id, node]));
  apply('edit', (revision) =>
    baseline.flatMap((node) => {
      const id = ids.get(node.id)!;
      const now = restored.get(id)!;
      const parentId = node.parentId === null ? null : ids.get(node.parentId)!;
      const operations: Record<string, unknown>[] = [];
      if (now.parentId !== parentId || now.position !== node.position)
        operations.push({
          op: 'move',
          id,
          expectedRevision: revision(id),
          parentId,
          position: node.position,
        });
      const relatedIds = node.relatedIds?.map((related) => ids.get(related) ?? related);
      const update: Record<string, unknown> = {};
      if (now.title !== node.title) update.title = node.title;
      if (now.intent !== node.intent) update.intent = node.intent;
      if (now.fixed !== node.fixed) update.fixed = node.fixed;
      if (relatedIds && !isDeepStrictEqual(now.relatedIds ?? [], relatedIds))
        update.relatedIds = relatedIds;
      if (Object.keys(update).length)
        operations.push({ op: 'update', id, expectedRevision: revision(id), ...update });
      return operations;
    })
  );
}

function restoreNotes(store: Store, row: Row, key: string) {
  const chatId = row.chat_id!;
  const baseline = parsed(row) as NoteState;
  const current = captureState(store, row) as NoteState;
  const before = new Map(baseline.map((note) => [note.id, note]));
  const replaces = new Map(
    store.db
      .prepare(
        'SELECT id,replaces_id FROM author_notes WHERE chat_id=? AND replaces_id IS NOT NULL'
      )
      .all(chatId)
      .map((item) => [String(item.id), String(item.replaces_id)])
  );
  const stored = store.db.prepare('SELECT entry FROM author_notes WHERE id=? AND chat_id=?');
  const restored = (note: NoteState[number]) => {
    const row = note.kind === 'imported-memory' ? stored.get(note.id, chatId) : undefined;
    const origin = row && (JSON.parse(String(row.entry)) as AuthorNote).origin;
    return { text: note.text, kind: note.kind, ...(origin ? { origin } : {}) };
  };
  let step = 0;
  const write = (body: Record<string, unknown>) =>
    store.story.notes.write(chatId, {
      ...body,
      author: ROLLBACK_AUTHOR,
      expectedRevision: store.story.notes.revision(chatId),
      expectedHeadRevision: store.chat(chatId).headRevision,
      idempotencyKey: `${key}:${step++}`,
    });
  const matched = new Set<string>();
  for (const note of current) {
    let origin: string | undefined = note.id;
    const seen = new Set<string>();
    while (origin && !before.has(origin) && !seen.has(origin)) {
      seen.add(origin);
      origin = replaces.get(origin);
    }
    const old = origin ? before.get(origin) : undefined;
    if (old && !matched.has(old.id)) {
      matched.add(old.id);
      if (old.text !== note.text || old.kind !== note.kind)
        write({ ...restored(old), replacesId: note.id });
    } else write({ retired: true, replacesId: note.id });
  }
  for (const note of baseline) if (!matched.has(note.id)) write(restored(note));
}

function restoreChatLore(store: Store, row: Row, key: string, taskId: string) {
  const baseline = loreBaseline(row);
  new ChatOverridesStore(store).restore(
    row.chat_id!,
    baseline.selector,
    baseline.override,
    `rollback:${helperStateHash(key).slice(0, 32)}`,
    `rollback:${taskId}`
  );
}

const REVERTED_REQUEST_CHARS = 160;

export function helperRevertedChanges(
  store: Store,
  conversationId: string,
  retryOf?: string,
  inherited?: HelperTaskSnapshot['revertedChanges']
): HelperTaskSnapshot['revertedChanges'] {
  const boundary = store.db
    .prepare(
      "SELECT seq FROM helper_events WHERE conversation_id=? AND kind='task.queued' " +
        (retryOf ? 'AND task_id=? ' : '') +
        'ORDER BY seq DESC LIMIT 1'
    )
    .get(...(retryOf ? [conversationId, retryOf] : [conversationId])) as
    | { seq: number }
    | undefined;
  if (!boundary) return inherited;
  const restored = store.db
    .prepare(`
    SELECT e.task_id, json_extract(item.value,'$.unit') AS unit, MIN(e.seq) AS first_restore
    FROM helper_events e, json_each(e.data,'$.units') item
    WHERE e.conversation_id=? AND e.kind='task.rolled-back' AND json_extract(item.value,'$.status')='restored'
      AND e.task_id IN (SELECT task_id FROM helper_events WHERE conversation_id=? AND seq>? AND kind='task.rolled-back')
    GROUP BY e.task_id,unit HAVING MIN(e.seq)>? ORDER BY first_restore
  `)
    .all(conversationId, conversationId, boundary.seq, boundary.seq) as {
    task_id: string;
    unit: string;
    first_restore: number;
  }[];
  if (!restored.length) return inherited;
  const order = new Map(restored.map((row) => [row.task_id + '\n' + row.unit, row.first_restore]));
  const rows = store.db
    .prepare(`
    SELECT c.task_id,t.request,c.domain,c.target_id,c.chat_id,c.source_id,c.entries
    FROM helper_changes c JOIN helper_tasks t ON t.id=c.task_id
    WHERE c.task_id IN (SELECT value FROM json_each(?)) AND c.rolled_back_at IS NOT NULL
    ORDER BY c.position
  `)
    .all(JSON.stringify([...new Set(restored.map((row) => row.task_id))])) as (Pick<
    Row,
    'domain' | 'target_id' | 'chat_id' | 'source_id' | 'entries'
  > & { task_id: string; request: string })[];
  const changes = new Map<string, HelperRevertedChange>();
  for (const row of rows) {
    const key = `${row.task_id}\n${unitKey(row)}`;
    if (!order.has(key) || changes.has(key)) continue;
    const resource = row.domain === 'resource' ? resourceKey(row) : null;
    const request = Array.from(row.request);
    const change: HelperRevertedChange = {
      taskId: row.task_id,
      request:
        request.length > REVERTED_REQUEST_CHARS
          ? `${request.slice(0, REVERTED_REQUEST_CHARS).join('')}…`
          : row.request,
      domain: row.domain,
      ...(resource ? { kind: resource.kind } : {}),
      targetId: resource?.id ?? row.source_id ?? row.chat_id ?? row.target_id,
      title: unitTitle(store, entriesOf(row), row),
    };
    changes.set(key, change);
  }
  if (!changes.size) return inherited;
  const all = [
    ...(inherited?.changes ?? []),
    ...[...changes].sort(([a], [b]) => order.get(a)! - order.get(b)!).map(([, change]) => change),
  ];
  return {
    changes: all.slice(-HELPER_REVERTED_CHANGES_LIMIT),
    omitted: (inherited?.omitted ?? 0) + Math.max(0, all.length - HELPER_REVERTED_CHANGES_LIMIT),
  };
}

export function rollBackHelperTask(
  store: Store,
  workspace: HelperWorkspace,
  taskId: string,
  unitKeyFilter: string | undefined,
  effects: Effects = {}
): HelperRollbackView {
  const restoredScenes = new Set<string>();
  const changedChats = new Set<string>();
  const view = store.transaction((): HelperRollbackView => {
    const task = workspace.taskState(taskId);
    if (activeTask(store, task.conversationId)) throw new AppError(409, 'HELPER_TASK_ACTIVE');
    const all = readUnits(store, taskId);
    const selected = unitKeyFilter ? all.filter((unit) => unit.unit === unitKeyFilter) : all;
    if (unitKeyFilter && !selected.length)
      throw new HttpError(404, 'HELPER_ROLLBACK_UNIT_NOT_FOUND');
    const resourceKinds = new Set<ResourceKind>();
    const units = selected.flatMap((unit): HelperRollbackUnit[] => {
      const assessment = assessSafely(store, unit);
      if (silent(store, unit, assessment)) return [];
      if (assessment.status !== 'restorable') return [describe(store, unit, assessment)];
      const notices = new Set<Notice>();
      try {
        store.transaction(() => {
          const key = `rollback:${taskId}:${unit.unit}`;
          if (unit.domain === 'resource') restoreResource(store, unit.rows[0]!);
          else if (unit.domain === 'outline') restoreOutline(store, unit.rows[0]!, key);
          else if (unit.domain === 'notes') restoreNotes(store, unit.rows[0]!, key);
          else if (unit.domain === 'chat-lore') restoreChatLore(store, unit.rows[0]!, key, taskId);
          else restoreScene(store, unit, notices);
          store.db
            .prepare(
              `UPDATE helper_changes SET rolled_back_at=? WHERE task_id=? AND domain=? AND target_id IN (SELECT value FROM json_each(?))`
            )
            .run(
              new Date().toISOString(),
              taskId,
              unit.domain,
              JSON.stringify(unit.rows.map((row) => row.target_id))
            );
        });
      } catch (error) {
        return [
          {
            ...describe(store, unit, { status: 'failed' }),
            error: error instanceof HttpError ? error.message : 'HELPER_ROLLBACK_FAILED',
          },
        ];
      }
      if (unit.domain === 'resource') resourceKinds.add(resourceKey(unit.rows[0]!).kind);
      if (unit.domain === 'scene') restoredScenes.add(unit.rows[0]!.source_id!);
      if (unit.domain === 'outline' || unit.domain === 'notes' || unit.domain === 'chat-lore')
        changedChats.add(unit.rows[0]!.chat_id!);
      return [
        {
          ...describe(store, unit, { status: 'restored' }),
          ...(notices.size ? { notices: [...notices] } : {}),
        },
      ];
    });
    if (resourceKinds.size) {
      workspace.event(task.conversationId, taskId, 'resource.updated');
      for (const kind of resourceKinds)
        if (kind === 'theme' || kind === 'illustration-preset')
          workspace.event(task.conversationId, taskId, `${kind}.updated`);
    }
    if (resourceKinds.size || restoredScenes.size || changedChats.size)
      workspace.event(task.conversationId, taskId, 'task.rolled-back', {
        units: units.map(({ unit, status }) => ({ unit, status })),
      });
    return { taskId, blocked: null, units };
  });
  for (const sourceId of restoredScenes) effects.sceneUpdated?.(sourceId);
  for (const chatId of changedChats) effects.chatChanged?.(chatId);
  return view;
}
