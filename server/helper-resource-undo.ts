import { isDeepStrictEqual } from 'node:util';
import type { HelperResourceEdit, HelperTask } from '../core/helper.js';
import { editableResource, type ResourceKind } from '../core/resource-editing.js';
import type { HelperWorkspace } from './helper-workspace.js';
import { invokeResourceTool } from './helper-resource-tools.js';
import { HttpError } from './request-validation.js';
import { readResource, undoResource } from './resource-service.js';
import type { Store } from './store.js';

type EditRecord = Pick<HelperResourceEdit, 'kind' | 'id' | 'revision' | 'title'> & {
  receiptId: string;
};

function resourceUpdated(
  workspace: HelperWorkspace,
  conversationId: string,
  taskId: string,
  kind?: ResourceKind
) {
  workspace.event(conversationId, taskId, 'resource.updated');
  if (kind === 'theme' || kind === 'illustration-preset')
    workspace.event(conversationId, taskId, `${kind}.updated`);
}

/** Runs inside the operation receipt transaction; only compact provenance survives cleanup. */
export function applyHelperResourceMutation(
  store: Store,
  workspace: HelperWorkspace,
  task: Pick<HelperTask, 'id' | 'conversationId'>,
  receiptId: string,
  name: string,
  args: Record<string, unknown>,
  target: { kind: ResourceKind; id: string | null } | null
): unknown {
  const existing =
    target?.id && ['resource.save', 'resource.patch', 'image.update-metadata'].includes(name)
      ? { kind: target.kind, id: target.id }
      : null;
  const before = existing ? readResource(store, existing.kind, existing.id) : null;
  const result = invokeResourceTool(store, name, args);
  if (existing && before) {
    const saved = readResource(store, existing.kind, existing.id);
    if (
      saved.revision !== before.revision &&
      !isDeepStrictEqual(
        editableResource(existing.kind, before),
        editableResource(existing.kind, saved)
      )
    ) {
      const edit: EditRecord = {
        ...existing,
        revision: saved.revision,
        title: 'title' in saved ? saved.title : '공통 프롬프트',
        receiptId,
      };
      workspace.event(task.conversationId, task.id, 'resource.edited', edit);
    }
  }
  resourceUpdated(workspace, task.conversationId, task.id, target?.kind);
  return result;
}

function undoneEdit(store: Store, conversationId: string, editSeq: number) {
  const row = store.db
    .prepare(
      `SELECT data FROM helper_events WHERE conversation_id=? AND kind='resource.edit.undone'
       AND json_extract(data,'$.editSeq')=? ORDER BY seq DESC LIMIT 1`
    )
    .get(conversationId, editSeq);
  return row ? (JSON.parse(String(row.data)) as HelperResourceEdit) : null;
}

/** Select the latest edit before checking availability, never an older recoverable edit. */
export function lastHelperResourceEdit(
  store: Store,
  workspace: HelperWorkspace,
  conversationId: string
): HelperResourceEdit | null {
  workspace.conversation(conversationId);
  const row = store.db
    .prepare(
      `SELECT seq,task_id,data FROM helper_events
       WHERE conversation_id=? AND kind='resource.edited' ORDER BY seq DESC LIMIT 1`
    )
    .get(conversationId);
  if (!row) return null;
  const { receiptId, ...record } = JSON.parse(String(row.data)) as EditRecord;
  const edit: HelperResourceEdit = {
    ...record,
    editSeq: Number(row.seq),
    taskId: String(row.task_id),
    canUndo: false,
  };
  if (
    !store.db
      .prepare('SELECT 1 FROM helper_operations WHERE id=? AND task_id=?')
      .get(receiptId, edit.taskId)
  )
    return { ...edit, reason: '저장 기록을 확인할 수 없어 되돌릴 수 없어요.' };
  const undone = undoneEdit(store, conversationId, edit.editSeq);
  if (undone) return undone;
  if (
    store.db
      .prepare(
        "SELECT 1 FROM helper_tasks WHERE conversation_id=? AND status IN ('queued','running') LIMIT 1"
      )
      .get(conversationId)
  )
    return { ...edit, reason: '도우미 작업이 끝나면 되돌릴 수 있어요.' };
  try {
    store.product.assertAvailable(edit.kind, edit.id);
    const saved = readResource(store, edit.kind, edit.id);
    const undo = store.db
      .prepare('SELECT saved_revision FROM resource_undo WHERE kind=? AND id=?')
      .get(edit.kind, edit.id);
    if (saved.revision !== edit.revision || undo?.saved_revision !== edit.revision)
      return { ...edit, reason: '최근 수정 이후 자료가 변경되어 되돌릴 수 없어요.' };
  } catch (error) {
    if (!(error instanceof HttpError) || error.statusCode !== 404) throw error;
    return { ...edit, reason: '자료를 찾을 수 없어 되돌릴 수 없어요.' };
  }
  return { ...edit, canUndo: true };
}

export function undoHelperResourceEdit(
  store: Store,
  workspace: HelperWorkspace,
  conversationId: string,
  editSeq: number
): HelperResourceEdit {
  return store.transaction(() => {
    workspace.conversation(conversationId);
    // A repeated request confirms its committed result, even after a later resource edit.
    const prior = undoneEdit(store, conversationId, editSeq);
    if (prior) return prior;
    const edit = lastHelperResourceEdit(store, workspace, conversationId);
    if (!edit || edit.editSeq !== editSeq)
      throw new HttpError(409, '최근 수정이 바뀌었어요. 다시 확인해 주세요.');
    if (!edit.canUndo) throw new HttpError(409, edit.reason!);
    undoResource(store, edit.kind, edit.id, edit.revision);
    const result = {
      ...edit,
      canUndo: false,
      undone: true,
      reason: '이미 되돌린 수정이에요.',
    };
    workspace.event(conversationId, edit.taskId, 'resource.edit.undone', result);
    resourceUpdated(workspace, conversationId, edit.taskId, edit.kind);
    return result;
  });
}
