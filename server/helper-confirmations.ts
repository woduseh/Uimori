import type {
  HelperConfirmation,
  HelperConfirmationReason,
  HelperConfirmedCall,
  HelperTask,
} from '../core/helper.js';
import { helperStateHash } from './helper-changes.js';
import { helperResourceOperation } from './helper-resource-tools.js';
import type { HelperWorkspace } from './helper-workspace.js';
import { HttpError } from './request-validation.js';
import type { Store } from './store.js';

export const HELPER_BULK_CONFIRMATION_RESOURCES = 3;

type Requirement = Pick<HelperConfirmation, 'operation' | 'reason' | 'chatId' | 'targets'>;
type Recorded = Omit<HelperConfirmation, 'grantedBy' | 'grantable'> & {
  arguments: Record<string, unknown>;
};

function requirement(
  task: Pick<HelperTask, 'snapshot'>,
  name: string,
  args: Record<string, unknown>
): Requirement | null {
  const chatId = task.snapshot.scope.kind === 'chat' ? task.snapshot.scope.chatId : null;
  const needs = (reason: HelperConfirmationReason, targets: Requirement['targets']) => ({
    operation: name,
    reason,
    chatId,
    targets,
  });
  if (name === 'resource.delete' || name === 'resource.patchMany') {
    const operation = helperResourceOperation(name, args);
    if (!operation || operation.readOnly) return null;
    const targets = (operation.targets ?? (operation.target ? [operation.target] : [])).flatMap(
      (target) => (target.id ? [{ kind: target.kind, id: target.id }] : [])
    );
    if (name === 'resource.delete') return needs('delete', targets);
    const distinct = new Set(targets.map((target) => `${target.kind}:${target.id}`));
    return distinct.size >= HELPER_BULK_CONFIRMATION_RESOURCES ? needs('bulk', targets) : null;
  }
  if (
    (name === 'scene.request' || name === 'scene.translate') &&
    task.snapshot.confirmPaidGeneration
  )
    return needs(
      'paid',
      name === 'scene.translate' && typeof args.sourceId === 'string'
        ? [{ kind: 'scene', id: args.sourceId }]
        : chatId
          ? [{ kind: 'chat', id: chatId }]
          : []
    );
  return null;
}

function confirmationId(
  conversationId: string,
  chatId: string | null,
  name: string,
  args: unknown
) {
  return helperStateHash({ conversationId, chatId, name, args });
}

function uses(store: Store, taskId: string, id: string) {
  return store.db
    .prepare(
      `SELECT json_extract(data,'$.receiptId') AS receipt FROM helper_events
       WHERE task_id=? AND kind='confirmation.used' AND json_extract(data,'$.id')=?`
    )
    .all(taskId, id)
    .map((row) => String(row.receipt));
}

export function helperConfirmationGate(
  store: Store,
  workspace: HelperWorkspace,
  task: Pick<HelperTask, 'id' | 'conversationId' | 'snapshot'>,
  name: string,
  args: Record<string, unknown>,
  receiptId: string
): Record<string, unknown> | null {
  const required = requirement(task, name, args);
  if (!required) return null;
  const id = confirmationId(task.conversationId, required.chatId, name, args);
  return store.transaction(() => {
    const receipts = uses(store, task.id, id);
    if (
      task.snapshot.confirmations?.some((call) => call.id === id) &&
      receipts.every((receipt) => receipt === receiptId)
    ) {
      if (!receipts.length)
        workspace.event(task.conversationId, task.id, 'confirmation.used', { id, receiptId });
      return null;
    }
    const recorded: Recorded = { id, taskId: task.id, ...required, arguments: args };
    if (
      !store.db
        .prepare(
          `SELECT 1 FROM helper_events WHERE task_id=? AND kind='confirmation.required' AND json_extract(data,'$.id')=?`
        )
        .get(task.id, id)
    )
      workspace.event(task.conversationId, task.id, 'confirmation.required', recorded);
    return {
      error: `CONFIRMATION_REQUIRED: ${required.reason === 'paid' ? 'Paid generation' : required.reason === 'delete' ? 'Deleting a resource' : 'Changing this many resources at once'} needs the owner's confirmation. Nothing was changed.`,
      code: 'CONFIRMATION_REQUIRED',
      recoverable: false,
      retryMode: 'never',
      outcome: 'unchanged',
      confirmation: { id, ...required },
      nextAction:
        'Do not call this operation again in this task. Finish your reply by saying what needs confirmation and why. If the owner confirms, the next request carries the confirmation, and the same call with the same arguments then runs once.',
    };
  });
}

export function resolveHelperConfirmations(
  store: Store,
  conversationId: string,
  ids: readonly string[]
): HelperConfirmedCall[] {
  if (!ids.length) return [];
  const latest = store.db
    .prepare('SELECT id FROM helper_tasks WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1')
    .get(conversationId)?.id;
  return ids.map((id) => {
    const row = store.db
      .prepare(
        `SELECT data FROM helper_events WHERE task_id=? AND kind='confirmation.required' AND json_extract(data,'$.id')=?`
      )
      .get(latest ?? '', id);
    if (!row) throw new HttpError(409, 'CONFIRMATION_UNAVAILABLE');
    const recorded = JSON.parse(String(row.data)) as Recorded;
    return {
      id,
      operation: recorded.operation,
      chatId: recorded.chatId,
      arguments: recorded.arguments,
    };
  });
}

export function readHelperConfirmations(store: Store, taskId: string): HelperConfirmation[] {
  const task = store.db
    .prepare('SELECT rowid, conversation_id FROM helper_tasks WHERE id=?')
    .get(taskId);
  if (!task) return [];
  const latest = store.db
    .prepare('SELECT id FROM helper_tasks WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1')
    .get(task.conversation_id)?.id;
  const granted = store.db.prepare(
    `SELECT t.id FROM helper_tasks t, json_each(t.snapshot,'$.confirmations') item
     WHERE t.conversation_id=? AND t.rowid>? AND json_extract(item.value,'$.id')=?
     ORDER BY t.rowid LIMIT 1`
  );
  return store.db
    .prepare(
      "SELECT data FROM helper_events WHERE task_id=? AND kind='confirmation.required' ORDER BY seq"
    )
    .all(taskId)
    .map((row) => {
      const { arguments: _arguments, ...recorded } = JSON.parse(String(row.data)) as Recorded;
      const grantedBy = granted.get(task.conversation_id, task.rowid, recorded.id)?.id;
      return {
        ...recorded,
        grantedBy: grantedBy === undefined ? null : String(grantedBy),
        grantable: grantedBy === undefined && latest === taskId,
      };
    });
}
