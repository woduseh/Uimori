import type {
  HelperChange,
  HelperChangeDomain,
  HelperRollbackReason,
  HelperRollbackStatus,
  HelperRollbackTouch,
  HelperRollbackUnit,
  HelperRollbackView,
} from '../core/helper.js';
import type { ResourceKind, ResourceModel } from '../core/resource-editing.js';
import {
  captureHelperTarget,
  helperResourceHash,
  helperStateHash,
  type HelperChangeTarget,
  type NoteState,
  type OutlineState,
} from './helper-changes.js';
import type { HelperWorkspace } from './helper-workspace.js';
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
type Effects = { sceneUpdated?: (sourceId: string) => void };
type Notice = NonNullable<HelperRollbackUnit['notices']>[number];

const ROLLBACK_AUTHOR = '도우미 변경 되돌리기';

const field = (row: Row) => row.target_id.slice(row.target_id.lastIndexOf(':') + 1);
const parsed = (row: Row): unknown => (row.baseline === null ? null : JSON.parse(row.baseline));
const entriesOf = (row: Row) => JSON.parse(row.entries) as HelperChange[];
function resourceKey(row: Row): { kind: ResourceKind; id: string } {
  const at = row.target_id.indexOf(':');
  return { kind: row.target_id.slice(0, at) as ResourceKind, id: row.target_id.slice(at + 1) };
}

function unitKey(row: Row) {
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

function currentHash(store: Store, row: Row) {
  if (row.domain === 'resource') {
    const { kind, id } = resourceKey(row);
    return helperResourceHash(kind, readResource(store, kind, id));
  }
  return helperStateHash(captureHelperTarget(store, target(row)!).value);
}

function covered(unit: Unit) {
  return (
    unit.domain === 'resource' ||
    unit.domain === 'outline' ||
    unit.domain === 'notes' ||
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
  if (unit.rows.some((row) => currentHash(store, row) !== row.result))
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

function describe(store: Store, unit: Unit, assessment: Assessment): HelperRollbackUnit {
  const entries = unit.rows.flatMap(entriesOf);
  const chatId = unit.rows[0]!.chat_id;
  let title = entries[0]?.title;
  if (!title && chatId) {
    try {
      title = store.chat(chatId).title;
    } catch {}
  }
  return {
    unit: unit.unit,
    domain: unit.domain,
    title: title ?? unit.rows[0]!.target_id,
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
  const current = store.outline.nodes(chatId);
  const live = new Map(current.map((node) => [node.id, node]));
  const wanted = new Map(baseline.map((node) => [node.id, node]));
  const recreated = baseline.filter((node) => !live.has(node.id));
  const ids = new Map<string, string>(baseline.map((node) => [node.id, node.id]));
  if (recreated.length) {
    const result = store.outline.applyReceipt(
      chatId,
      {
        idempotencyKey: `${key}:create`,
        operations: recreated.map((node) => ({
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
        })),
      },
      'user'
    );
    for (const created of result.created) ids.set(created.ref!, created.id);
  }
  const revisions = new Map(current.map((node) => [node.id, node.revision]));
  for (const node of recreated) revisions.set(ids.get(node.id)!, 1);
  const operations: Record<string, unknown>[] = [];
  const revision = (id: string) => {
    const value = revisions.get(id)!;
    revisions.set(id, value + 1);
    return value;
  };
  for (const node of baseline) {
    const id = ids.get(node.id)!;
    const now = live.get(node.id);
    const parentId = node.parentId === null ? null : ids.get(node.parentId)!;
    if (now && (now.parentId !== parentId || now.position !== node.position))
      operations.push({
        op: 'move',
        id,
        expectedRevision: revision(id),
        parentId,
        position: node.position,
      });
    const relatedIds = node.relatedIds?.map((related) => ids.get(related) ?? related);
    const update: Record<string, unknown> = {};
    if (now && now.level !== node.level) update.level = node.level;
    if (now && now.title !== node.title) update.title = node.title;
    if (now && now.intent !== node.intent) update.intent = node.intent;
    if ((now?.fixed ?? false) !== node.fixed) update.fixed = node.fixed;
    if (relatedIds && JSON.stringify(now?.relatedIds ?? []) !== JSON.stringify(relatedIds))
      update.relatedIds = relatedIds;
    if (Object.keys(update).length)
      operations.push({ op: 'update', id, expectedRevision: revision(id), ...update });
  }
  for (const node of current)
    if (!wanted.has(node.id) && (node.parentId === null || wanted.has(node.parentId)))
      operations.push({ op: 'remove', id: node.id, expectedRevision: revision(node.id) });
  if (operations.length)
    store.outline.applyReceipt(chatId, { idempotencyKey: `${key}:edit`, operations }, 'user');
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
        write({ text: old.text, kind: old.kind, replacesId: note.id });
    } else write({ retired: true, replacesId: note.id });
  }
  for (const note of baseline)
    if (!matched.has(note.id)) write({ text: note.text, kind: note.kind });
}

export function rollBackHelperTask(
  store: Store,
  workspace: HelperWorkspace,
  taskId: string,
  unitKeyFilter: string | undefined,
  effects: Effects = {}
): HelperRollbackView {
  const restoredScenes = new Set<string>();
  const view = store.transaction((): HelperRollbackView => {
    const task = workspace.taskState(taskId);
    if (activeTask(store, task.conversationId)) throw new HttpError(409, 'HELPER_TASK_ACTIVE');
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
    workspace.event(task.conversationId, taskId, 'task.rolled-back', {
      units: units.map(({ unit, status }) => ({ unit, status })),
    });
    return { taskId, blocked: null, units };
  });
  for (const sourceId of restoredScenes) effects.sceneUpdated?.(sourceId);
  return view;
}
