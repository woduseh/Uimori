import { createHash } from 'node:crypto';
import { removeDeletedContinuityScenes } from './illustration-continuity.js';
import { readerRunDismissalKey } from './run-reader-state.js';
import type { FastifyInstance } from 'fastify';
import type { Store } from './store.js';
import type { RunSnapshot } from '../core/types.js';
import { CONTEXT_JOB_SCENE_DELETED } from '../core/context-plan.js';
import type { SceneDeletionImpact, SceneDeletionResult } from '../core/scene-deletion.js';
import type { MessageChanges } from '../core/message-changes.js';
import { fields, HttpError, number, record, text } from './request-validation.js';
import { assertChatIdleForDeletion } from './chat-deletion.js';
import { readImportReceipt, saveImportReceipt } from './import-operations.js';
import { settleSnapshot } from './execution-snapshot.js';
import { detachAttemptUsage } from './usage-accounting.js';
import { imageDataHashes, pruneUnusedData } from './unused-data.js';
import { readChatVariables } from './chat-variables.js';
import { disposeNativeRisuChatSessions } from './risu-native-lua-session.js';
import { forgetHelperSceneChanges } from './helper-changes.js';
import {
  forgetHelperConfirmationTargets,
  redactHelperArgumentPreviews,
} from './helper-argument-retention.js';
import { AppError } from './app-errors.js';

function target(store: Store, chatId: string, sourceId: string) {
  const chat = store.chat(chatId),
    history = store.history(chat.headRevision);
  const index = history.findIndex((source) => source.revision === sourceId);
  if (index < 0 || store.sourceMetadata(sourceId).chatId !== chatId)
    throw new AppError(404, 'SCENE_DELETE_NOT_FOUND');
  return { chat, history, index };
}
function historyHash(history: ReturnType<Store['history']>) {
  return createHash('sha256')
    .update(
      JSON.stringify(
        history.map((source) => [
          source.revision,
          source.contentHash ?? createHash('sha256').update(source.text).digest('hex'),
          source.sceneContext?.revision ?? 0,
        ])
      )
    )
    .digest('hex');
}
export function sceneDeletionImpact(
  store: Store,
  chatId: string,
  sourceId: string
): SceneDeletionImpact {
  const { chat, history, index } = target(store, chatId, sourceId);
  assertChatIdleForDeletion(store, chatId);
  const notes = store.story.notes.entries({ chatId, history });
  const following = new Set(history.slice(index).map((source) => source.revision));
  return {
    sourceId,
    onlyCount: 1,
    followingCount: following.size,
    orphanNoteCount: {
      only: notes.filter((note) => note.atRevision === sourceId).length,
      following: notes.filter((note) => note.atRevision && following.has(note.atRevision)).length,
    },
    request: {
      expectedHeadRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      expectedSourceHash: store.sourceMetadata(sourceId).hash,
      expectedHistoryHash: historyHash(history),
      expectedVariablesRevision: readChatVariables(store, chatId).revision,
    },
  };
}
function refersToDeleted(value: unknown, ids: Set<string>): boolean {
  if (typeof value === 'string')
    return (
      ids.has(value) ||
      [...ids].some(
        (id) =>
          value === `source:${id}` || value === `request:${id}` || value.startsWith(`native:${id}:`)
      )
    );
  if (Array.isArray(value)) return value.some((item) => refersToDeleted(item, ids));
  return (
    !!value &&
    typeof value === 'object' &&
    Object.values(value).some((item) => refersToDeleted(item, ids))
  );
}
function cleanChanges(
  changes: MessageChanges | undefined,
  ids: Set<string>
): MessageChanges | undefined {
  if (!changes) return undefined;
  return {
    removed: changes.removed.filter((id) => !refersToDeleted(id, ids)),
    updated: changes.updated.filter(
      (change) =>
        !refersToDeleted(change.message.id, ids) && !ids.has(change.message.sourceRevision ?? '')
    ),
    ...(changes.order ? { order: changes.order.filter((id) => !refersToDeleted(id, ids)) } : {}),
  };
}
export function deleteScenes(
  store: Store,
  chatId: string,
  sourceId: string,
  input: unknown,
  afterDelete?: (chatId: string) => void
): SceneDeletionResult {
  const body = record(input);
  fields(body, [
    'scope',
    'expectedHeadRevision',
    'expectedSettingsRevision',
    'expectedSourceHash',
    'expectedHistoryHash',
    'expectedVariablesRevision',
    'idempotencyKey',
  ]);
  const scope = text(body.scope, 'scope', 10);
  if (scope !== 'only' && scope !== 'following')
    throw new HttpError(400, 'Invalid scene deletion scope');
  const expectedHead =
    body.expectedHeadRevision === null ? null : text(body.expectedHeadRevision, 'head', 100);
  const expectedSettings = number(body.expectedSettingsRevision, 'settings revision', 1);
  const expectedHash = text(body.expectedSourceHash, 'source hash', 64);
  const expectedHistoryHash = text(body.expectedHistoryHash, 'history hash', 64);
  const expectedVariablesRevision = number(body.expectedVariablesRevision, 'variables revision', 0);
  const requestKey = text(body.idempotencyKey, 'delete request', 100);
  const receiptKey = `transcript:scene-delete:${chatId}:${requestKey}`;
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        chatId,
        sourceId,
        scope,
        expectedHead,
        expectedSettings,
        expectedHash,
        expectedHistoryHash,
        expectedVariablesRevision,
      })
    )
    .digest('hex');
  let changed = false;
  const result = store.transaction(() => {
    const previous = readImportReceipt<SceneDeletionResult>(store, receiptKey, digest);
    if (previous) return previous;
    const { chat, history, index } = target(store, chatId, sourceId);
    if (
      chat.headRevision !== expectedHead ||
      chat.settingsRevision !== expectedSettings ||
      store.sourceMetadata(sourceId).hash !== expectedHash ||
      historyHash(history) !== expectedHistoryHash ||
      readChatVariables(store, chatId).revision !== expectedVariablesRevision
    )
      throw new AppError(409, 'REVISION_CONFLICT');
    assertChatIdleForDeletion(store, chatId);
    const removed = scope === 'only' ? [history[index]] : history.slice(index);
    const ids = new Set(removed.map((source) => source.revision));
    removeDeletedContinuityScenes(store, chatId, ids);
    const sources = store.db
      .prepare('SELECT id,run_id,parent_revision,text FROM sources WHERE chat_id=?')
      .all(chatId);
    const parents = new Map(
      sources.map((row) => [String(row.id), row.parent_revision as string | null])
    );
    const survivor = (id: string | null): string | null => {
      while (id && ids.has(id)) id = parents.get(id) ?? null;
      return id;
    };
    for (const id of ids) {
      if (
        store.db
          .prepare('SELECT 1 FROM sources WHERE chat_id!=? AND parent_revision=?')
          .get(chatId, id) ||
        store.db.prepare('SELECT 1 FROM chats WHERE id!=? AND head_revision=?').get(chatId, id) ||
        store.db
          .prepare('SELECT 1 FROM runs WHERE chat_id!=? AND parent_revision=?')
          .get(chatId, id)
      )
        throw new AppError(409, 'SCENE_DELETE_REFERENCED');
    }
    const runIds = new Set(
      sources.filter((row) => ids.has(String(row.id))).map((row) => String(row.run_id))
    );
    const dependsOnDeleted = (revision: string | null) => {
      while (revision) {
        if (ids.has(revision)) return true;
        revision = parents.get(revision) ?? null;
      }
      return false;
    };
    for (const source of sources) {
      if (ids.has(String(source.id)) || !dependsOnDeleted(source.parent_revision as string | null))
        continue;
      store.db.prepare('DELETE FROM execution_tool_diagnostics WHERE run_id=?').run(source.run_id);
      store.db
        .prepare(`DELETE FROM execution_tool_diagnostics WHERE job_id IN
        (SELECT id FROM jobs WHERE source_revision=?)`)
        .run(source.id);
      store.db
        .prepare(`DELETE FROM execution_tool_diagnostics WHERE illustration_job_id IN
        (SELECT id FROM illustration_jobs WHERE source_revision=?)`)
        .run(source.id);
    }
    const images = new Set<string>();
    const rememberImages = (value: unknown) => {
      for (const hash of imageDataHashes(value)) images.add(hash);
    };
    for (const row of sources) {
      if (ids.has(String(row.id))) rememberImages(row.text);
      else if (row.parent_revision && ids.has(String(row.parent_revision)))
        store.db
          .prepare('UPDATE sources SET parent_revision=? WHERE id=?')
          .run(survivor(String(row.parent_revision)), row.id);
    }
    const attemptIds = new Set<string>();
    for (const row of store.db
      .prepare('SELECT id,snapshot,status,parent_revision FROM runs WHERE chat_id=?')
      .all(chatId)) {
      const id = String(row.id),
        original = JSON.parse(String(row.snapshot)) as RunSnapshot;
      if (runIds.has(id)) {
        rememberImages(row.snapshot);
        continue;
      }
      if (!refersToDeleted(original, ids) && !ids.has(String(row.parent_revision))) continue;
      store.db.prepare('DELETE FROM execution_tool_diagnostics WHERE run_id=?').run(id);
      let snapshot =
        original.settled && row.status === 'completed' ? { ...original } : settleSnapshot(original);
      snapshot.parentRevision = survivor(snapshot.parentRevision);
      if (snapshot.replacement && ids.has(snapshot.replacement.sourceRevision))
        delete snapshot.replacement;
      const changes = cleanChanges(original.messageChanges, ids);
      if (changes) snapshot.messageChanges = changes;
      if (row.status !== 'completed') snapshot = { ...snapshot, invalidatedBySceneDeletion: true };
      store.db
        .prepare(
          "UPDATE runs SET parent_revision=?,snapshot=?,partial_text=CASE WHEN status='completed' THEN partial_text ELSE NULL END WHERE id=?"
        )
        .run(survivor(row.parent_revision as string | null), JSON.stringify(snapshot), id);
      if (row.status !== 'completed') {
        store.db.prepare('DELETE FROM model_inputs WHERE run_id=?').run(id);
        store.db.prepare('DELETE FROM tool_events WHERE run_id=?').run(id);
        store.db.prepare('UPDATE anthropic_batches SET result=NULL WHERE run_id=?').run(id);
        for (const attempt of store.db.prepare('SELECT id FROM attempts WHERE run_id=?').all(id))
          attemptIds.add(String(attempt.id));
      }
    }
    redactHelperArgumentPreviews(store.db, chatId, ids, '[arguments removed after scene deletion]');
    forgetHelperSceneChanges(store.db, ids);
    forgetHelperConfirmationTargets(
      store.db,
      [...ids].map((id) => ({ kind: 'scene', id }))
    );
    for (const task of store.db
      .prepare(
        'SELECT t.id,t.snapshot FROM helper_tasks t JOIN helper_conversations c ON c.id=t.conversation_id WHERE c.chat_id=?'
      )
      .all(chatId)) {
      const snapshot = JSON.parse(String(task.snapshot));
      if (!refersToDeleted(snapshot, ids)) continue;
      for (const key of ['writing', 'selection', 'editor', 'outline', 'contextModel', 'references'])
        delete snapshot[key];
      snapshot.history = [];
      snapshot.invalidatedBySceneDeletion = true;
      store.db
        .prepare('UPDATE helper_tasks SET snapshot=? WHERE id=?')
        .run(JSON.stringify(snapshot), task.id);
    }
    const headRevision = survivor(chat.headRevision);
    if (headRevision !== chat.headRevision) {
      const checkpoint = headRevision
        ? store.db
            .prepare('SELECT body FROM chat_variable_outputs WHERE source_id=?')
            .get(headRevision)
        : undefined;
      const values = checkpoint ? JSON.parse(String(checkpoint.body)).values : {};
      const revision = readChatVariables(store, chatId).revision + 1;
      store.db
        .prepare(
          'INSERT INTO chat_variable_states(chat_id,revision,values_json) VALUES(?,?,?) ON CONFLICT(chat_id) DO UPDATE SET revision=excluded.revision,values_json=excluded.values_json'
        )
        .run(chatId, revision, JSON.stringify(values));
    }
    store.db
      .prepare('UPDATE chats SET head_revision=?,settings_revision=settings_revision+1 WHERE id=?')
      .run(headRevision, chatId);
    store.db.prepare('UPDATE context_heads SET revision=revision+1 WHERE chat_id=?').run(chatId);
    store.db.prepare('DELETE FROM chat_lore_state WHERE chat_id=?').run(chatId);
    store.db
      .prepare(
        "UPDATE context_jobs SET snapshot=NULL,error=CASE WHEN status='completed' THEN error ELSE ? END WHERE chat_id=?"
      )
      .run(CONTEXT_JOB_SCENE_DELETED, chatId);
    for (const id of ids) {
      for (const row of store.db.prepare('SELECT text FROM source_edits WHERE source_id=?').all(id))
        rememberImages(row.text);
      const jobs = store.db.prepare('SELECT id,input FROM jobs WHERE source_revision=?').all(id);
      for (const job of jobs) {
        rememberImages(job.input);
        for (const row of store.db
          .prepare('SELECT result FROM job_results WHERE job_id=?')
          .all(job.id))
          rememberImages(row.result);
        for (const attempt of store.db
          .prepare('SELECT id FROM attempts WHERE job_id=?')
          .all(job.id))
          attemptIds.add(String(attempt.id));
        store.db.prepare('DELETE FROM job_results WHERE job_id=?').run(job.id);
      }
      for (const job of store.db
        .prepare('SELECT id,input,diagnostic FROM illustration_jobs WHERE source_revision=?')
        .all(id)) {
        rememberImages(job.input);
        const diagnostic = job.diagnostic ? JSON.parse(String(job.diagnostic)) : {};
        for (const attempt of diagnostic.attempts ?? [])
          if (
            typeof attempt === 'string' &&
            store.db
              .prepare("SELECT 1 FROM attempts WHERE id=? AND chat_id=? AND role='illustration'")
              .get(attempt, chatId)
          )
            attemptIds.add(attempt);
        for (const image of store.db
          .prepare('SELECT hash FROM illustration_images WHERE job_id=?')
          .all(job.id))
          images.add(String(image.hash));
        store.db.prepare('DELETE FROM illustration_images WHERE job_id=?').run(job.id);
        store.db.prepare('DELETE FROM illustration_jobs WHERE id=?').run(job.id);
      }
      store.db
        .prepare(
          'UPDATE outline_nodes SET command_id=NULL,revision=revision+1 WHERE command_id IN (SELECT id FROM scene_commands WHERE source_revision=?)'
        )
        .run(id);
      store.db.prepare('DELETE FROM scene_commands WHERE source_revision=?').run(id);
      store.db.prepare('DELETE FROM source_edits WHERE source_id=?').run(id);
      store.db.prepare('DELETE FROM chat_variable_outputs WHERE source_id=?').run(id);
      store.db
        .prepare('DELETE FROM app_metadata WHERE key IN (?,?)')
        .run(`source-title:${id}`, `illustration-presentation:${id}`);
    }
    for (const id of runIds) {
      store.db
        .prepare('DELETE FROM app_metadata WHERE key=?')
        .run(readerRunDismissalKey(chatId, id));
      store.db
        .prepare(
          'UPDATE outline_nodes SET command_id=NULL,revision=revision+1 WHERE command_id IN (SELECT id FROM scene_commands WHERE run_id=?)'
        )
        .run(id);
      store.db.prepare('DELETE FROM scene_commands WHERE run_id=?').run(id);
      for (const attempt of store.db.prepare('SELECT id FROM attempts WHERE run_id=?').all(id))
        attemptIds.add(String(attempt.id));
      for (const table of ['anthropic_batches', 'model_inputs', 'tool_events'])
        store.db.prepare(`DELETE FROM ${table} WHERE run_id=?`).run(id);
    }
    detachAttemptUsage(store.db, [...attemptIds]);
    for (const id of ids) {
      store.db.prepare('DELETE FROM push_outbox WHERE source_id=?').run(id);
      store.db.prepare('DELETE FROM jobs WHERE source_revision=?').run(id);
    }
    for (const source of [...removed].reverse())
      store.db.prepare('DELETE FROM sources WHERE id=?').run(source.revision);
    for (const id of runIds) store.db.prepare('DELETE FROM runs WHERE id=?').run(id);
    store.event(chatId, 'source.deleted', sourceId);
    store.event(chatId, 'context.updated', chatId);
    pruneUnusedData(store.db, images);
    const saved: SceneDeletionResult = {
      deleted: true,
      chatId,
      sourceIds: [...ids],
      headRevision,
      settingsRevision: chat.settingsRevision + 1,
    };
    saveImportReceipt(store, receiptKey, digest, saved);
    changed = true;
    return saved;
  });
  if (changed) {
    disposeNativeRisuChatSessions(chatId);
    afterDelete?.(chatId);
  }
  return result;
}
export function sceneDeletionRoutes(
  app: FastifyInstance,
  store: Store,
  publish: (chatId: string) => void
) {
  app.get<{ Params: { id: string; sourceId: string } }>(
    '/api/chats/:id/sources/:sourceId/deletion-impact',
    (request) => sceneDeletionImpact(store, request.params.id, request.params.sourceId)
  );
  app.delete<{ Params: { id: string; sourceId: string } }>(
    '/api/chats/:id/sources/:sourceId',
    (request) => {
      return deleteScenes(store, request.params.id, request.params.sourceId, request.body, publish);
    }
  );
}
