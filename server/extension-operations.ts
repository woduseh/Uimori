import { randomUUID } from 'node:crypto';
import type {
  ExtensionOperation,
  ExtensionOperationCommand,
  ExtensionOperationSnapshot,
  ExtensionOperationView,
} from '../core/extension-operation.js';
import type { ResolvedExtensionProgram } from '../core/extension-program.js';
import type { ProviderResult, WireRecord } from '../core/transport.js';
import type { Usage } from '../core/types.js';
import { behaviorPayloadHash } from './package-behavior-store.js';
import { HttpError } from './request-validation.js';
import type { Store } from './store.js';

export const EXTENSION_OPERATION_TABLES = [
  'package_extension_operations',
  'package_extension_operation_attempts',
] as const;
type Row = Record<string, any>;
const now = () => new Date().toISOString();
function fromRow(row: Row): ExtensionOperation {
  return {
    id: row.id,
    chatId: row.chat_id,
    branchId: row.branch_id,
    instanceId: row.attachment_instance_id,
    command: JSON.parse(row.command),
    snapshot: JSON.parse(row.snapshot),
    status: row.status,
    generation: row.generation,
    owner: row.owner,
    result: row.result === null ? null : JSON.parse(row.result),
    usage: row.usage === null ? null : JSON.parse(row.usage),
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
}
export function extensionOperation(store: Store, id: string): ExtensionOperation {
  const row = store.db.prepare('SELECT * FROM package_extension_operations WHERE id=?').get(id);
  if (!row) throw new HttpError(404, 'EXTENSION_OPERATION_NOT_FOUND');
  return fromRow(row);
}
export function findExtensionOperation(
  store: Store,
  chatId: string,
  branchId: string,
  instanceId: string,
  idempotencyKey: string
): ExtensionOperation | undefined {
  const row = store.db
    .prepare(
      'SELECT * FROM package_extension_operations WHERE chat_id=? AND branch_id=? AND attachment_instance_id=? AND request_key=?'
    )
    .get(chatId, branchId, instanceId, idempotencyKey);
  return row ? fromRow(row) : undefined;
}
export function createExtensionOperation(
  store: Store,
  command: ExtensionOperationCommand,
  snapshot: ExtensionOperationSnapshot
) {
  return store.transaction(() => {
    const scope = snapshot.scope,
      hash = behaviorPayloadHash(command);
    const previous = store.db
      .prepare(
        'SELECT * FROM package_extension_operations WHERE chat_id=? AND branch_id=? AND attachment_instance_id=? AND request_key=?'
      )
      .get(scope.chatId, scope.branchId, scope.attachmentInstanceId, command.idempotencyKey);
    if (previous) {
      if (previous.request_hash !== hash) throw new HttpError(409, 'BEHAVIOR_IDEMPOTENCY_CONFLICT');
      return { operation: fromRow(previous), reused: true };
    }
    if (
      store.db
        .prepare(
          "SELECT 1 FROM package_extension_operations WHERE chat_id=? AND branch_id=? AND attachment_instance_id=? AND status IN ('queued','running')"
        )
        .get(scope.chatId, scope.branchId, scope.attachmentInstanceId)
    )
      throw new HttpError(409, 'EXTENSION_OPERATION_ACTIVE');
    const id = randomUUID(),
      at = now();
    store.db
      .prepare(
        "INSERT INTO package_extension_operations(id,chat_id,branch_id,attachment_instance_id,request_key,request_hash,command,snapshot,status,generation,owner,result,usage,error,created_at,started_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'queued',0,NULL,NULL,NULL,NULL,?,NULL,?)"
      )
      .run(
        id,
        scope.chatId,
        scope.branchId,
        scope.attachmentInstanceId,
        command.idempotencyKey,
        hash,
        JSON.stringify(command),
        JSON.stringify(snapshot),
        at,
        at
      );
    store.event(scope.chatId, 'extension-operation.queued', id);
    return { operation: extensionOperation(store, id), reused: false };
  });
}
export function extensionOperationViews(
  store: Store,
  chatId: string,
  branchId?: string
): ExtensionOperationView[] {
  store.chat(chatId);
  const rows = store.db
    .prepare(`SELECT id,attachment_instance_id,status,usage,error,created_at,updated_at,result IS NOT NULL AS has_result,
    json_extract(command,'$.actionId') AS action_id,
    (SELECT json_extract(action.value,'$.label') FROM json_each(snapshot,'$.profile.packages') package,
      json_each(package.value,'$.behavior.actions') action WHERE json_extract(package.value,'$.id')=json_extract(snapshot,'$.scope.packageId')
      AND json_extract(package.value,'$.revision')=json_extract(snapshot,'$.scope.packageRevision') AND json_extract(action.value,'$.id')=json_extract(command,'$.actionId') LIMIT 1) AS title,
    (SELECT count(*) FROM package_extension_operation_attempts WHERE operation_id=recent.id) AS model_calls
    FROM (SELECT *,ROW_NUMBER() OVER(PARTITION BY branch_id,attachment_instance_id ORDER BY rowid DESC) AS position FROM package_extension_operations WHERE chat_id=?${branchId ? ' AND branch_id=?' : ''}) recent WHERE position<=20 ORDER BY created_at DESC`)
    .all(...(branchId ? [chatId, branchId] : [chatId]));
  return rows.map((row) => {
    return {
      id: String(row.id),
      instanceId: String(row.attachment_instance_id),
      actionId: String(row.action_id),
      title: String(row.title ?? row.action_id),
      status: row.status as ExtensionOperation['status'],
      usage:
        row.usage === null
          ? {
              modelCalls: Number(row.model_calls),
              inputTokens: null,
              outputTokens: null,
              costUsd: null,
            }
          : JSON.parse(String(row.usage)),
      error: row.error as string | null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      hasResult: !!row.has_result,
    };
  });
}
export function queuedExtensionOperations(store: Store): string[] {
  return store.db
    .prepare("SELECT id FROM package_extension_operations WHERE status='queued' ORDER BY rowid")
    .all()
    .map((row) => String(row.id));
}
export function claimExtensionOperation(
  store: Store,
  id: string,
  owner: string
): ExtensionOperation | null {
  return store.transaction(() => {
    const at = now();
    if (
      !store.db
        .prepare(
          "UPDATE package_extension_operations SET status='running',owner=?,generation=generation+1,started_at=?,updated_at=? WHERE id=? AND status='queued'"
        )
        .run(owner, at, at, id).changes
    )
      return null;
    const op = extensionOperation(store, id);
    store.event(op.chatId, 'extension-operation.running', id);
    return op;
  });
}
export function ownsExtensionOperation(store: Store, claimed: ExtensionOperation): boolean {
  return !!store.db
    .prepare(
      "SELECT 1 FROM package_extension_operations WHERE id=? AND owner=? AND generation=? AND status='running'"
    )
    .get(claimed.id, claimed.owner, claimed.generation);
}
export function finishExtensionOperationInTransaction(
  store: Store,
  claimed: ExtensionOperation,
  status: 'completed' | 'failed',
  result: ResolvedExtensionProgram | null,
  usage: Usage,
  error: string | null
): boolean {
  if (!store.db.isTransaction) throw new Error('EXTENSION_OPERATION_TRANSACTION_REQUIRED');
  if (!ownsExtensionOperation(store, claimed)) return false;
  store.db
    .prepare(
      'UPDATE package_extension_operations SET status=?,owner=NULL,result=?,usage=?,error=?,updated_at=? WHERE id=?'
    )
    .run(
      status,
      result === null ? null : JSON.stringify(result),
      JSON.stringify(usage),
      error,
      now(),
      claimed.id
    );
  store.event(claimed.chatId, `extension-operation.${status}`, claimed.id);
  return true;
}
export function cancelExtensionOperation(store: Store, id: string): ExtensionOperation {
  return store.transaction(() => {
    const op = extensionOperation(store, id);
    if (
      store.db
        .prepare(
          "UPDATE package_extension_operations SET status='cancelled',owner=NULL,generation=generation+1,error='EXTENSION_CANCELLED',updated_at=? WHERE id=? AND status IN ('queued','running')"
        )
        .run(now(), id).changes
    )
      store.event(op.chatId, 'extension-operation.cancelled', id);
    return extensionOperation(store, id);
  });
}
export function settleExtensionOperationUsage(store: Store, id: string, usage: Usage): void {
  store.transaction(() => {
    if (
      store.db
        .prepare(
          "UPDATE package_extension_operations SET usage=?,updated_at=? WHERE id=? AND usage IS NULL AND status IN ('completed','failed','cancelled','interrupted')"
        )
        .run(JSON.stringify(usage), now(), id).changes
    )
      store.event(extensionOperation(store, id).chatId, 'extension-operation.settled', id);
  });
}
export function startExtensionOperationAttempt(
  store: Store,
  claimed: ExtensionOperation,
  wire: WireRecord
): string {
  return store.transaction(() => {
    if (!ownsExtensionOperation(store, claimed))
      throw new HttpError(409, 'EXTENSION_OPERATION_NOT_ACTIVE');
    const count = Number(
      store.db
        .prepare(
          'SELECT count(*) AS n FROM package_extension_operation_attempts WHERE operation_id=?'
        )
        .get(claimed.id)!.n
    );
    const limit = extensionOperation(store, claimed.id).snapshot.settings.maxCalls;
    if (!Number.isSafeInteger(limit) || limit < 1 || count >= limit)
      throw new HttpError(409, 'MODEL_CALL_BUDGET_EXHAUSTED');
    const id = store.product.startAttempt(claimed.chatId, null, null, wire);
    store.db
      .prepare(
        'INSERT INTO package_extension_operation_attempts(operation_id,attempt_id,call_index) VALUES(?,?,?)'
      )
      .run(claimed.id, id, count);
    store.event(claimed.chatId, 'extension-operation.attempt-started', claimed.id);
    return id;
  });
}
export function finishExtensionOperationAttempt(
  store: Store,
  operationId: string,
  attemptId: string,
  result: ProviderResult
): void {
  store.transaction(() => {
    if (
      !store.db
        .prepare(
          'SELECT 1 FROM package_extension_operation_attempts WHERE operation_id=? AND attempt_id=?'
        )
        .get(operationId, attemptId)
    )
      throw new HttpError(409, 'EXTENSION_ATTEMPT_OWNER_MISMATCH');
    store.product.finishAttempt(attemptId, result);
  });
}
export function recoverExtensionOperations(store: Store): void {
  for (const row of store.db
    .prepare(
      "SELECT id,chat_id FROM package_extension_operations WHERE status IN ('queued','running')"
    )
    .all()) {
    store.db
      .prepare(
        "UPDATE package_extension_operations SET status='interrupted',owner=NULL,generation=generation+1,error='EXTENSION_INTERRUPTED',updated_at=? WHERE id=?"
      )
      .run(now(), row.id);
    store.event(String(row.chat_id), 'extension-operation.interrupted', String(row.id));
  }
}
