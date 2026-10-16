import { isDeepStrictEqual } from 'node:util';
import {
  helperResourceEditResources,
  type HelperResourceEdit,
  type HelperResourceEditResource,
  type HelperTask,
} from '../core/helper.js';
import { editableResource, type ResourceKind } from '../core/resource-editing.js';
import type { HelperWorkspace } from './helper-workspace.js';
import { HelperResourceBatchError, helperResourceBatchItems } from './helper-resource-batch.js';
import { invokeResourceTool } from './helper-resource-tools.js';
import { HttpError } from './request-validation.js';
import { readResource, undoResource } from './resource-service.js';
import type { Store } from './store.js';

type EditRecord = HelperResourceEditResource & {
  receiptId: string;
  resources?: HelperResourceEditResource[];
};
type MutationTarget = { kind: ResourceKind; id: string | null };

function resourceUpdated(
  workspace: HelperWorkspace,
  conversationId: string,
  taskId: string,
  kinds: readonly ResourceKind[] = []
) {
  workspace.event(conversationId, taskId, 'resource.updated');
  for (const kind of new Set(kinds))
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
  target: MutationTarget | MutationTarget[] | null
): unknown {
  const targets: readonly MutationTarget[] =
    name === 'resource.patchMany'
      ? helperResourceBatchItems(args.items)
      : target === null
        ? []
        : Array.isArray(target)
          ? target
          : [target];
  const tracked = [
    'resource.save',
    'resource.patch',
    'resource.patchMany',
    'image.update-metadata',
  ].includes(name);
  const before = tracked
    ? targets.flatMap((item, itemIndex) => {
        if (!item.id) return [];
        try {
          return [{ kind: item.kind, id: item.id, saved: readResource(store, item.kind, item.id) }];
        } catch (error) {
          if (name === 'resource.patchMany' && error instanceof HttpError)
            throw new HelperResourceBatchError(
              itemIndex,
              item.kind === 'content' || item.kind === 'prompt-preset' ? item.kind : undefined,
              item.id,
              error
            );
          throw error;
        }
      })
    : [];
  const result = invokeResourceTool(store, name, args);
  const resources: HelperResourceEditResource[] = [];
  for (const existing of before) {
    const saved = readResource(store, existing.kind, existing.id);
    if (
      saved.revision !== existing.saved.revision &&
      !isDeepStrictEqual(
        editableResource(existing.kind, existing.saved),
        editableResource(existing.kind, saved)
      )
    ) {
      resources.push({
        kind: existing.kind,
        id: existing.id,
        revision: saved.revision,
        title: 'title' in saved ? saved.title : '공통 프롬프트',
      });
    }
  }
  if (resources.length) {
    const edit: EditRecord = {
      ...resources[0]!,
      receiptId,
      ...(resources.length > 1 ? { resources } : {}),
    };
    workspace.event(task.conversationId, task.id, 'resource.edited', edit);
  }
  if (name !== 'resource.patchMany' || resources.length)
    resourceUpdated(
      workspace,
      task.conversationId,
      task.id,
      targets.map((item) => item.kind)
    );
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
    for (const resource of helperResourceEditResources(edit)) {
      store.product.assertAvailable(resource.kind, resource.id);
      const saved = readResource(store, resource.kind, resource.id);
      const undo = store.db
        .prepare('SELECT saved_revision FROM resource_undo WHERE kind=? AND id=?')
        .get(resource.kind, resource.id);
      if (saved.revision !== resource.revision || undo?.saved_revision !== resource.revision)
        return { ...edit, reason: '최근 수정 이후 자료가 변경되어 되돌릴 수 없어요.' };
    }
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
    const resources = helperResourceEditResources(edit);
    for (const resource of resources)
      undoResource(store, resource.kind, resource.id, resource.revision);
    const result = {
      ...edit,
      canUndo: false,
      undone: true,
      reason: '이미 되돌린 수정이에요.',
    };
    workspace.event(conversationId, edit.taskId, 'resource.edit.undone', result);
    resourceUpdated(
      workspace,
      conversationId,
      edit.taskId,
      resources.map((resource) => resource.kind)
    );
    return result;
  });
}
