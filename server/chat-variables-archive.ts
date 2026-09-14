import { isDeepStrictEqual } from 'node:util';
import { validateChatVariableState, type ChatVariableState } from '../core/chat-variables.js';
import { behaviorPayloadHash } from './package-behavior-store.js';
import { validateChatVariableCommand } from './chat-variables.js';
import {
  archiveRejector,
  HttpError,
  text,
  type ArchiveReject,
  type ArchiveRow as Row,
} from './request-validation.js';
import type { Store } from './store.js';

const invalid: ArchiveReject = archiveRejector('Invalid chat variables archive');

/** A selected source owns its historical state; later branch edits are never copied. */
export function restoreChatVariablesAtSource(
  store: Store,
  chatId: string,
  branchId: string,
  sourceId: string | null
) {
  store.product.branch(chatId, branchId);
  if (sourceId && store.source(sourceId).chatId !== chatId) invalid('source ownership');
  const row = sourceId
    ? (store.db.prepare('SELECT body FROM chat_variable_outputs WHERE source_id=?').get(sourceId) as
        | Row
        | undefined)
    : undefined;
  const state = validateChatVariableState(row ? JSON.parse(row.body) : { revision: 0, values: {} });
  store.db
    .prepare(
      'INSERT INTO chat_variable_states(chat_id,branch_id,revision,values_json) VALUES(?,?,?,?)'
    )
    .run(chatId, branchId, state.revision, JSON.stringify(state.values));
}

export function copyChatVariableFork(
  store: Store,
  chatId: string,
  branchId: string,
  sourceIds: Map<string, string>,
  selectedSourceId: string
) {
  for (const [oldId, newId] of sourceIds) {
    const row = store.db
      .prepare('SELECT body FROM chat_variable_outputs WHERE source_id=?')
      .get(oldId) as Row | undefined;
    if (row)
      store.db
        .prepare('INSERT INTO chat_variable_outputs(source_id,body) VALUES(?,?)')
        .run(newId, row.body);
  }
  restoreChatVariablesAtSource(store, chatId, branchId, selectedSourceId);
}

/** Candidates inherit the original reservation, including edits made after its parent source. */
export function restoreCandidateChatVariables(
  store: Store,
  chatId: string,
  branchId: string,
  saved: ChatVariableState | undefined
) {
  if (!store.db.isTransaction) throw new Error('CHAT_VARIABLE_TRANSACTION_REQUIRED');
  store.product.branch(chatId, branchId);
  if (
    store.db
      .prepare('SELECT 1 FROM chat_variable_journal WHERE chat_id=? AND branch_id=? LIMIT 1')
      .get(chatId, branchId)
  )
    throw new HttpError(409, 'CHAT_VARIABLE_CANDIDATE_BRANCH_ALREADY_WRITTEN');
  const state = validateChatVariableState(saved ?? { revision: 0, values: {} });
  store.db
    .prepare(`INSERT INTO chat_variable_states(chat_id,branch_id,revision,values_json)
    VALUES(?,?,?,?) ON CONFLICT(chat_id,branch_id) DO UPDATE
    SET revision=excluded.revision,values_json=excluded.values_json`)
    .run(chatId, branchId, state.revision, JSON.stringify(state.values));
}

/** Validate data only: restoring an archive never executes authored code or variable writes. */
export function validateChatVariablesArchive(store: Store) {
  const rows = (table: string) => store.db.prepare(`SELECT * FROM ${table}`).all() as Row[];
  const branch = (chatId: unknown, branchId: unknown) => {
    text(chatId, 'variables chat', 100);
    text(branchId, 'variables branch', 100);
    const owner = store.db
      .prepare('SELECT chat_id FROM branches WHERE id=?')
      .get(String(branchId)) as Row | undefined;
    if (owner?.chat_id !== chatId) invalid('branch ownership');
  };
  const key = (row: Row) => JSON.stringify([row.chat_id, row.branch_id]);
  const states = new Map<string, ChatVariableState>();
  for (const row of rows('chat_variable_states')) {
    branch(row.chat_id, row.branch_id);
    states.set(
      key(row),
      validateChatVariableState({ revision: row.revision, values: JSON.parse(row.values_json) })
    );
  }
  const revisions = new Map<string, Set<number>>();
  for (const row of rows('chat_variable_journal')) {
    branch(row.chat_id, row.branch_id);
    const current = states.get(key(row));
    if (!current) invalid('journal state missing');
    const payload = validateChatVariableCommand(JSON.parse(row.payload));
    if (
      payload.expectedSourceHash !== null &&
      !store.db
        .prepare(`SELECT 1 FROM sources s WHERE s.chat_id=? AND
        (s.hash=? OR EXISTS(SELECT 1 FROM source_edits e WHERE e.source_id=s.id AND e.hash=?)) LIMIT 1`)
        .get(row.chat_id, payload.expectedSourceHash, payload.expectedSourceHash)
    )
      invalid('journal source ownership');
    if (
      payload.idempotencyKey !== row.request_key ||
      behaviorPayloadHash(payload) !== row.payload_hash
    )
      invalid('journal payload');
    const result = validateChatVariableState(JSON.parse(row.result));
    if (
      result.revision !== payload.expectedRevision + 1 ||
      !isDeepStrictEqual(result.values, payload.values) ||
      result.revision > current!.revision ||
      (result.revision === current!.revision && !isDeepStrictEqual(result, current))
    )
      invalid('journal result');
    const seen = revisions.get(key(row)) ?? new Set<number>();
    if (seen.has(result.revision)) invalid('duplicate journal revision');
    seen.add(result.revision);
    revisions.set(key(row), seen);
    if (typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at)))
      invalid('journal time');
  }
  for (const row of rows('chat_variable_outputs')) {
    text(row.source_id, 'variables source', 100);
    if (!store.db.prepare('SELECT 1 FROM sources WHERE id=?').get(row.source_id))
      invalid('checkpoint source missing');
    validateChatVariableState(JSON.parse(row.body));
  }
}
