import {
  validateChatVariableState,
  validateChatVariableValues,
  type ChatVariableState,
} from '../core/chat-variables.js';
import { jsonPayloadHash } from './json-hash.js';
import { fields, HttpError, isSha256Hex, number, record, text } from './request-validation.js';
import type { Store } from './store.js';

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

/** Overrides only: reading an untouched chat does not materialize package defaults. */
export function readChatVariables(store: Store, chatId: string): ChatVariableState {
  store.chat(chatId);
  const row = store.db
    .prepare('SELECT revision,values_json FROM chat_variable_states WHERE chat_id=?')
    .get(chatId);
  return row
    ? validateChatVariableState({
        revision: row.revision,
        values: JSON.parse(String(row.values_json)),
      })
    : { revision: 0, values: {} };
}

export function chatVariablesPending(store: Store, chatId: string): boolean {
  return !!store.db
    .prepare("SELECT 1 FROM runs WHERE chat_id=? AND status IN ('queued','running') LIMIT 1")
    .get(chatId);
}

function applyChatVariablesInTransaction(
  store: Store,
  chatId: string,
  value: ChatVariableCommand,
  checkActivity: boolean
): ChatVariableState {
  if (!store.db.isTransaction) throw new Error('CHAT_VARIABLE_TRANSACTION_REQUIRED');
  const command = validateChatVariableCommand(value);
  const chat = store.chat(chatId);
  const payloadHash = jsonPayloadHash(command);
  const receipt = store.db
    .prepare('SELECT payload_hash FROM chat_variable_journal WHERE chat_id=? AND request_key=?')
    .get(chatId, command.idempotencyKey);
  if (receipt) {
    if (receipt.payload_hash !== payloadHash)
      throw new HttpError(409, 'CHAT_VARIABLE_IDEMPOTENCY_CONFLICT');
    return readChatVariables(store, chatId);
  }
  if (checkActivity && chatVariablesPending(store, chatId))
    throw new HttpError(409, 'CHAT_VARIABLE_CHAT_BUSY');
  const current = readChatVariables(store, chatId);
  if (current.revision !== command.expectedRevision)
    throw new HttpError(409, 'CHAT_VARIABLE_REVISION_CONFLICT');
  const source = chat.headRevision ? store.source(chat.headRevision) : null;
  if (source && source.chatId !== chatId) throw new HttpError(400, 'CHAT_VARIABLE_SOURCE_OWNER');
  if ((source?.hash ?? null) !== command.expectedSourceHash)
    throw new HttpError(409, 'CHAT_VARIABLE_SOURCE_CONFLICT');
  const result = { revision: current.revision + 1, values: command.values };
  store.db
    .prepare(
      'INSERT INTO chat_variable_states(chat_id,revision,values_json) VALUES(?,?,?) ON CONFLICT(chat_id) DO UPDATE SET revision=excluded.revision,values_json=excluded.values_json'
    )
    .run(chatId, result.revision, JSON.stringify(result.values));
  store.db
    .prepare(
      'INSERT INTO chat_variable_journal(chat_id,request_key,payload_hash,revision,created_at) VALUES(?,?,?,?,?)'
    )
    .run(chatId, command.idempotencyKey, payloadHash, result.revision, new Date().toISOString());
  store.event(chatId, 'chat.variables.changed', chatId);
  return result;
}

/** Explicit user writes own a transaction and cannot race a reserved Run or extension. */
export function writeChatVariables(
  store: Store,
  chatId: string,
  command: ChatVariableCommand
): ChatVariableState {
  return store.transaction(() => applyChatVariablesInTransaction(store, chatId, command, true));
}

/** Trusted host adoption joins its existing transaction, retaining CAS and replay receipts. */
export function writeChatVariablesInTransaction(
  store: Store,
  chatId: string,
  command: ChatVariableCommand
): ChatVariableState {
  return applyChatVariablesInTransaction(store, chatId, command, false);
}

/** Called only while committing a new source. Existing source checkpoints are immutable. */
export function checkpointChatVariablesInTransaction(
  store: Store,
  sourceId: string,
  chatId: string
): void {
  if (!store.db.isTransaction) throw new Error('CHAT_VARIABLE_TRANSACTION_REQUIRED');
  store.chat(chatId);
  const source = store.sourceOriginal(sourceId);
  if (source.chatId !== chatId || store.run(source.runId).chatId !== chatId)
    throw new HttpError(400, 'CHAT_VARIABLE_SOURCE_OWNER');
  if (store.db.prepare('SELECT 1 FROM chat_variable_outputs WHERE source_id=?').get(sourceId))
    return;
  const state = readChatVariables(store, chatId);
  if (state.revision === 0) return;
  store.db
    .prepare('INSERT INTO chat_variable_outputs(source_id,body) VALUES(?,?)')
    .run(sourceId, JSON.stringify(state));
}
