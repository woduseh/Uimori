import { isDeepStrictEqual } from 'node:util';
import type { HelperTask, HelperTaskResultTarget } from '../core/helper.js';
import { editableResource, type ResourceKind } from '../core/resource-editing.js';
import type { HelperWorkspace } from './helper-workspace.js';
import { HelperResourceBatchError, helperResourceBatchItems } from './helper-resource-batch.js';
import { invokeResourceTool } from './helper-resource-tools.js';
import { HttpError } from './request-validation.js';
import { readResource } from './resource-service.js';
import type { Store } from './store.js';
import { recordHelperTaskResult } from './helper-task-results.js';
import { recordHelperResourceChange } from './helper-changes.js';

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
  const before = targets.flatMap((item, itemIndex) => {
    if (!item.id) return [];
    try {
      return [{ kind: item.kind, id: item.id, saved: readResource(store, item.kind, item.id) }];
    } catch (error) {
      if (name === 'resource.patchMany' && error instanceof HttpError)
        throw new HelperResourceBatchError(
          itemIndex,
          item.kind === 'content' || item.kind === 'prompt-preset' || item.kind === 'theme'
            ? item.kind
            : undefined,
          item.id,
          error
        );
      throw error;
    }
  });
  const result = invokeResourceTool(store, name, args);
  const resources: HelperTaskResultTarget[] = [];
  for (const existing of before) {
    if (name === 'resource.delete') {
      resources.push({
        kind: existing.kind,
        id: existing.id,
        revision: existing.saved.revision,
        title: 'title' in existing.saved ? existing.saved.title : '공통 프롬프트',
      });
      recordHelperResourceChange(store, task, existing.kind, existing.id, existing.saved, null);
      continue;
    }
    const saved = readResource(store, existing.kind, existing.id);
    recordHelperResourceChange(store, task, existing.kind, existing.id, existing.saved, saved);
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
  if ((name === 'resource.clone' || name === 'resource.save') && !before.length) {
    const created = result as { id?: string };
    const kind = targets[0]?.kind;
    if (kind && created.id) {
      const saved = readResource(store, kind, created.id);
      recordHelperResourceChange(store, task, kind, created.id, null, saved);
      resources.push({
        kind,
        id: created.id,
        revision: saved.revision,
        title: 'title' in saved ? saved.title : '공통 프롬프트',
      });
    }
  }
  recordHelperTaskResult(workspace, task, {
    receiptId,
    operation: name,
    requestedTargets: targets.length,
    targets: resources,
  });
  if (name !== 'resource.patchMany' || resources.length)
    resourceUpdated(
      workspace,
      task.conversationId,
      task.id,
      targets.map((item) => item.kind)
    );
  return result;
}
