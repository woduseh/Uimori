import { createHash } from 'node:crypto';
import type {
  HelperConfirmation,
  HelperConfirmationReason,
  HelperConfirmedCall,
  HelperDeclinedCall,
  HelperTask,
} from '../core/helper.js';
import { helperConfirmationTrait } from './helper-confirmation-traits.js';
import { helperResourceOperation } from './helper-resource-tools.js';
import type { HelperWorkspace } from './helper-workspace.js';
import { fontCatalog } from './fonts.js';
import { modelInUse } from './helper-model-usage.js';
import { AppError } from './app-errors.js';
import { HttpError } from './request-validation.js';
import type { Store } from './store.js';
import { readPalette } from './themes.js';

type Requirement = Pick<
  HelperConfirmation,
  'operation' | 'reason' | 'chatId' | 'targets' | 'count'
>;
type Target = HelperConfirmation['targets'][number];
type Recorded = Omit<HelperConfirmation, 'grantedBy' | 'grantable'> & {
  arguments?: Record<string, unknown>;
};

function titled(kind: string, id: unknown, title: () => string | undefined): Target[] {
  if (typeof id !== 'string') return [];
  try {
    const name = title();
    return [{ kind, id, ...(name ? { title: name } : {}) }];
  } catch (error) {
    if (error instanceof HttpError) return [{ kind, id }];
    throw error;
  }
}

function confirmationTargets(
  store: Store,
  name: string,
  args: Record<string, unknown>,
  chatId: string | null
): Target[] {
  const chat: Target[] = chatId ? [{ kind: 'chat', id: chatId }] : [];
  if (name === 'scene.translate' && typeof args.sourceId === 'string')
    return [{ kind: 'scene', id: args.sourceId }];
  if (name === 'illustration.generate' && Array.isArray(args.moments)) {
    const scenes = [
      ...new Set(
        args.moments.flatMap((moment) =>
          moment && typeof moment === 'object' && typeof moment.sourceId === 'string'
            ? [moment.sourceId as string]
            : []
        )
      ),
    ];
    return scenes.length ? scenes.map((id) => ({ kind: 'scene', id })) : chat;
  }
  if (name === 'model.delete')
    return titled(
      'model',
      args.modelId,
      () => store.product.stored<{ title: string }>('model', String(args.modelId)).title
    );
  if (name === 'font.delete')
    return titled(
      'font',
      args.id,
      () => fontCatalog(store).fonts.find((font) => font.id === args.id)?.title
    );
  if (name === 'chat.delete')
    return titled('chat', args.chatId, () => store.chat(String(args.chatId)).title);
  if (name === 'prompt.combination.delete')
    return titled(
      'prompt-combination',
      args.id,
      () => store.product.stored<{ title: string }>('prompt-combination', String(args.id)).title
    );
  if (name === 'palette.delete')
    return titled('palette', args.id, () => readPalette(store, String(args.id)).title);
  if (name === 'task.retry') return [];
  return chat;
}

function retriesPaidGeneration(store: Store, args: Record<string, unknown>) {
  if (args.kind === 'run' || args.kind === 'illustration') return true;
  if (args.kind !== 'job' || typeof args.id !== 'string') return false;
  const job = store.db.prepare('SELECT kind FROM jobs WHERE id=?').get(args.id);
  return job?.kind === 'translation' || job?.kind === 'image';
}

function requirement(
  store: Store,
  task: Pick<HelperTask, 'snapshot'>,
  name: string,
  args: Record<string, unknown>
): Requirement | null {
  const chatId = task.snapshot.scope.kind === 'chat' ? task.snapshot.scope.chatId : null;
  const needs = (
    reason: HelperConfirmationReason,
    targets: Requirement['targets'],
    count?: number
  ): Requirement => ({
    operation: name,
    reason,
    chatId,
    targets,
    ...(count === undefined ? {} : { count }),
  });
  if (name === 'resource.delete') {
    const operation = helperResourceOperation(name, args);
    if (!operation || operation.readOnly) return null;
    const targets = (operation.targets ?? (operation.target ? [operation.target] : [])).flatMap(
      (target) => (target.id ? [{ kind: target.kind, id: target.id }] : [])
    );
    return needs('delete', targets);
  }
  const confirmation = helperConfirmationTrait(name);
  if (!confirmation) return null;
  if (
    name === 'model.delete' &&
    typeof args.modelId === 'string' &&
    modelInUse(store, args.modelId)
  )
    return null;
  if (name === 'chat.delete' && args.chatId === chatId) return null;
  if (confirmation === 'paid' && !task.snapshot.confirmPaidGeneration) return null;
  if (name === 'task.retry' && !retriesPaidGeneration(store, args)) return null;
  return needs(
    confirmation,
    confirmationTargets(store, name, args, chatId),
    name === 'illustration.generate' && Array.isArray(args.moments)
      ? args.moments.length
      : undefined
  );
}

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, item]) => item !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, item]) => [key, canonical(item)])
        )
      : value;

function confirmationId(
  conversationId: string,
  chatId: string | null,
  name: string,
  args: unknown
) {
  return createHash('sha256')
    .update(JSON.stringify(canonical({ conversationId, chatId, name, args })))
    .digest('hex');
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
  const required = requirement(store, task, name, args);
  if (!required) return null;
  const id = confirmationId(task.conversationId, required.chatId, name, args);
  return store.transaction(() => {
    const receipts = uses(store, task.id, id);
    if (
      task.snapshot.confirmations?.some((call) => call.id === id && call.arguments) &&
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
      error: `CONFIRMATION_REQUIRED: ${required.reason === 'paid' ? 'Paid generation' : 'A deletion that cannot be undone'} needs the owner's confirmation. Nothing was changed.`,
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

function latestTaskConfirmations(store: Store, conversationId: string) {
  const latest = store.db
    .prepare('SELECT id FROM helper_tasks WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1')
    .get(conversationId)?.id;
  const read = store.db.prepare(
    `SELECT data FROM helper_events WHERE task_id=? AND kind='confirmation.required' AND json_extract(data,'$.id')=?`
  );
  return (id: string) => {
    const row = read.get(latest ?? '', id);
    return row ? (JSON.parse(String(row.data)) as Recorded) : undefined;
  };
}

export function resolveHelperDeclines(
  store: Store,
  conversationId: string,
  ids: readonly string[]
): HelperDeclinedCall[] {
  if (!ids.length) return [];
  const recorded = latestTaskConfirmations(store, conversationId);
  return ids.flatMap((id) => {
    const held = recorded(id);
    if (!held) return [];
    const { operation, reason, chatId, targets, count } = held;
    return [{ id, operation, reason, chatId, targets, ...(count === undefined ? {} : { count }) }];
  });
}

export function resolveHelperConfirmations(
  store: Store,
  conversationId: string,
  ids: readonly string[]
): HelperConfirmedCall[] {
  if (!ids.length) return [];
  const read = latestTaskConfirmations(store, conversationId);
  return ids.map((id) => {
    const recorded = read(id);
    if (!recorded?.arguments) throw new AppError(409, 'HELPER_CONFIRMATION_UNAVAILABLE');
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
      const { arguments: args, ...recorded } = JSON.parse(String(row.data)) as Recorded;
      const grantedBy = granted.get(task.conversation_id, task.rowid, recorded.id)?.id;
      return {
        ...recorded,
        grantedBy: grantedBy === undefined ? null : String(grantedBy),
        grantable: grantedBy === undefined && latest === taskId && args !== undefined,
      };
    });
}
