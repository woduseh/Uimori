import {
  validateChatVariableState,
  validateChatVariableValues,
  type ChatVariableState,
} from '../core/chat-variables.js';
import { behaviorPayloadHash } from './package-behavior-store.js';
import { fields, HttpError, isSha256Hex, number, record, text } from './request-validation.js';
import type { Store } from './store.js';

export const chatVariableTables = [
  'chat_variable_states',
  'chat_variable_journal',
  'chat_variable_outputs',
] as const;

export type ChatVariableCommand = {
  expectedRevision: number;
  expectedSourceHash: string | null;
  idempotencyKey: string;
  values: Record<string, string>;
};

export function validateChatVariableCommand(value: unknown): ChatVariableCommand {
  const body = record(value);
  fields(body, ['expectedRevision', 'expectedSourceHash', 'idempotencyKey', 'values']);
  const expectedRevision = number(
    body.expectedRevision,
    'chat variable revision',
    0,
    Number.MAX_SAFE_INTEGER - 1
  );
  const expectedSourceHash =
    body.expectedSourceHash === null ? null : text(body.expectedSourceHash, 'source hash', 64);
  if (expectedSourceHash !== null && !isSha256Hex(expectedSourceHash))
    throw new HttpError(400, 'Invalid source hash');
  return {
    expectedRevision,
    expectedSourceHash,
    idempotencyKey: text(body.idempotencyKey, 'chat variable request key', 200),
    values: validateChatVariableValues(body.values),
  };
}

/** Overrides only: reading an untouched branch does not materialize package defaults. */
export function readChatVariables(
  store: Store,
  chatId: string,
  branchId: string
): ChatVariableState {
  store.product.branch(chatId, branchId);
  const row = store.db
    .prepare(
      'SELECT revision,values_json FROM chat_variable_states WHERE chat_id=? AND branch_id=?'
    )
    .get(chatId, branchId);
  return row
    ? validateChatVariableState({
        revision: row.revision,
        values: JSON.parse(String(row.values_json)),
      })
    : { revision: 0, values: {} };
}

export function chatVariablesPending(store: Store, chatId: string, branchId: string): boolean {
  return !!(
    store.db
      .prepare(
        "SELECT 1 FROM runs WHERE chat_id=? AND branch_id=? AND status IN ('queued','running','waiting_for_state') LIMIT 1"
      )
      .get(chatId, branchId) ||
    store.db
      .prepare(
        "SELECT 1 FROM package_extension_operations WHERE chat_id=? AND branch_id=? AND status IN ('queued','running') LIMIT 1"
      )
      .get(chatId, branchId)
  );
}

function applyChatVariablesInTransaction(
  store: Store,
  chatId: string,
  branchId: string,
  value: ChatVariableCommand,
  checkActivity: boolean
): ChatVariableState {
  if (!store.db.isTransaction) throw new Error('CHAT_VARIABLE_TRANSACTION_REQUIRED');
  const command = validateChatVariableCommand(value);
  const branch = store.product.branch(chatId, branchId);
  const payloadHash = behaviorPayloadHash(command);
  const receipt = store.db
    .prepare(
      'SELECT payload_hash,result FROM chat_variable_journal WHERE chat_id=? AND branch_id=? AND request_key=?'
    )
    .get(chatId, branchId, command.idempotencyKey);
  if (receipt) {
    if (receipt.payload_hash !== payloadHash)
      throw new HttpError(409, 'CHAT_VARIABLE_IDEMPOTENCY_CONFLICT');
    return validateChatVariableState(JSON.parse(String(receipt.result)));
  }
  if (checkActivity && chatVariablesPending(store, chatId, branchId))
    throw new HttpError(409, 'CHAT_VARIABLE_BRANCH_BUSY');
  const current = readChatVariables(store, chatId, branchId);
  if (current.revision !== command.expectedRevision)
    throw new HttpError(409, 'CHAT_VARIABLE_REVISION_CONFLICT');
  const source = branch.headRevision ? store.source(branch.headRevision) : null;
  if (source && source.chatId !== chatId) throw new HttpError(400, 'CHAT_VARIABLE_SOURCE_OWNER');
  if ((source?.hash ?? null) !== command.expectedSourceHash)
    throw new HttpError(409, 'CHAT_VARIABLE_SOURCE_CONFLICT');
  const result = { revision: current.revision + 1, values: command.values };
  store.db
    .prepare(
      'INSERT INTO chat_variable_states(chat_id,branch_id,revision,values_json) VALUES(?,?,?,?) ON CONFLICT(chat_id,branch_id) DO UPDATE SET revision=excluded.revision,values_json=excluded.values_json'
    )
    .run(chatId, branchId, result.revision, JSON.stringify(result.values));
  store.db
    .prepare(
      'INSERT INTO chat_variable_journal(chat_id,branch_id,request_key,payload_hash,payload,result,created_at) VALUES(?,?,?,?,?,?,?)'
    )
    .run(
      chatId,
      branchId,
      command.idempotencyKey,
      payloadHash,
      JSON.stringify(command),
      JSON.stringify(result),
      new Date().toISOString()
    );
  store.event(chatId, 'chat.variables.changed', branchId);
  return result;
}

/** Explicit user writes own a transaction and cannot race a reserved Run or extension. */
export function writeChatVariables(
  store: Store,
  chatId: string,
  branchId: string,
  command: ChatVariableCommand
): ChatVariableState {
  return store.transaction(() =>
    applyChatVariablesInTransaction(store, chatId, branchId, command, true)
  );
}

/** Trusted host adoption joins its existing transaction, retaining CAS and replay receipts. */
export function writeChatVariablesInTransaction(
  store: Store,
  chatId: string,
  branchId: string,
  command: ChatVariableCommand
): ChatVariableState {
  return applyChatVariablesInTransaction(store, chatId, branchId, command, false);
}

/** Called only while committing a new source. Existing source checkpoints are immutable. */
export function checkpointChatVariablesInTransaction(
  store: Store,
  sourceId: string,
  chatId: string,
  branchId: string
): void {
  if (!store.db.isTransaction) throw new Error('CHAT_VARIABLE_TRANSACTION_REQUIRED');
  store.product.branch(chatId, branchId);
  const source = store.sourceOriginal(sourceId);
  if (source.chatId !== chatId || store.run(source.runId).snapshot.branchId !== branchId)
    throw new HttpError(400, 'CHAT_VARIABLE_SOURCE_OWNER');
  if (store.db.prepare('SELECT 1 FROM chat_variable_outputs WHERE source_id=?').get(sourceId))
    return;
  const state = readChatVariables(store, chatId, branchId);
  if (state.revision === 0) return;
  store.db
    .prepare('INSERT INTO chat_variable_outputs(source_id,body) VALUES(?,?)')
    .run(sourceId, JSON.stringify(state));
}
