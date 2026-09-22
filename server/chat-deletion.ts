import { imageDataHashes, pruneUnusedData } from './unused-data.js';
import { HttpError, fields, record } from './request-validation.js';
import type { FastifyInstance } from 'fastify';
import type { Store } from './store.js';

type Row = Record<string, any>;
const chatTables = [
  'profiles',
  'chat_override_operations',
  'chat_lore_overrides',
  'chat_override_heads',
  'assets',
  'events',
  'chat_organization',
  'author_notes',
  'author_note_heads',
  'author_note_commands',
  'context_jobs',
  'context_commands',
  'context_heads',
  'context_checkpoints',
  'outline_batches',
  'outline_nodes',
  'scene_commands',
  'chat_variable_states',
  'chat_variable_journal',
  'illustration_images',
  'illustration_jobs',
  'illustration_references',
  'attempts',
  'jobs',
  'sources',
  'runs',
  'branches',
];

/** Describe the selected chat. Unrelated diagnostic events cannot invalidate its deletion. */
export function chatDeletionImpact(store: Store, chatId: string) {
  store.chat(chatId);
  return {
    request: {},
    description:
      '이 채팅의 원문·번역·메모·도우미와 작업 기록을 삭제해요. 독립 사본과 공통 자료는 유지돼요.',
  };
}

function assertIdle(store: Store, chatId: string) {
  if (
    store.db
      .prepare(
        "SELECT 1 FROM helper_tasks t JOIN helper_conversations c ON c.id=t.conversation_id WHERE c.chat_id=? AND t.status IN ('queued','running') LIMIT 1"
      )
      .get(chatId)
  )
    throw new HttpError(409, '진행 중인 도우미 작업을 취소하거나 완료한 뒤 삭제해 주세요.');
  for (const table of ['runs', 'jobs', 'context_jobs', 'illustration_jobs'])
    if (
      store.db
        .prepare(
          `SELECT 1 FROM ${table} WHERE chat_id=? AND status IN ('queued','running') LIMIT 1`
        )
        .get(chatId)
    )
      throw new HttpError(
        409,
        '진행 중인 생성 또는 보조 작업을 취소하거나 완료한 뒤 삭제해 주세요.'
      );
  if (
    store.db
      .prepare("SELECT 1 FROM attempts WHERE chat_id=? AND status='running' LIMIT 1")
      .get(chatId)
  )
    throw new HttpError(409, '공급자 요청이 아직 종료되지 않았어요. 요청 종료 후 삭제해 주세요.');
}

function removeIds(store: Store, table: string, column: string, ids: string[]) {
  const statement = store.db.prepare(`DELETE FROM ${table} WHERE ${column}=?`);
  for (const id of ids) statement.run(id);
}

function removeRunArtifacts(store: Store, runIds: string[], sourceIds: string[], jobIds: string[]) {
  for (const table of ['model_inputs', 'tool_events']) removeIds(store, table, 'run_id', runIds);
  for (const table of ['source_edits', 'chat_variable_outputs'])
    removeIds(store, table, 'source_id', sourceIds);
  for (const table of ['job_results']) removeIds(store, table, 'job_id', jobIds);
}

export function deleteChat(store: Store, chatId: string, value: unknown) {
  const body = record(value);
  fields(body, []);
  return store.transaction(() => {
    store.chat(chatId);
    assertIdle(store, chatId);
    const imageCandidates = new Set<string>();
    for (const sql of [
      'SELECT hash AS value FROM assets WHERE chat_id=?',
      'SELECT hash AS value FROM illustration_images WHERE chat_id=?',
      'SELECT text AS value FROM sources WHERE chat_id=?',
      'SELECT e.text AS value FROM source_edits e JOIN sources s ON s.id=e.source_id WHERE s.chat_id=?',
      'SELECT snapshot AS value FROM runs WHERE chat_id=?',
      'SELECT r.result AS value FROM job_results r JOIN jobs j ON j.id=r.job_id WHERE j.chat_id=?',
      'SELECT m.text AS value FROM helper_messages m JOIN helper_conversations c ON c.id=m.conversation_id WHERE c.chat_id=?',
      'SELECT a.text AS value FROM helper_artifacts a JOIN helper_conversations c ON c.id=a.conversation_id WHERE c.chat_id=?',
    ])
      for (const row of store.db.prepare(sql).iterate(chatId))
        for (const hash of imageDataHashes(row.value)) imageCandidates.add(hash);
    store.db.exec('PRAGMA defer_foreign_keys=ON');
    const ids = (table: string) =>
      (store.db.prepare(`SELECT id FROM ${table} WHERE chat_id=?`).all(chatId) as Row[]).map(
        (row) => String(row.id)
      );
    removeRunArtifacts(store, ids('runs'), ids('sources'), ids('jobs'));
    store.db
      .prepare(
        'DELETE FROM context_job_attempts WHERE job_id IN (SELECT id FROM context_jobs WHERE chat_id=?)'
      )
      .run(chatId);
    for (const table of chatTables)
      store.db.prepare(`DELETE FROM ${table} WHERE chat_id=?`).run(chatId);
    store.db.prepare('DELETE FROM chats WHERE id=?').run(chatId);
    pruneUnusedData(store.db, imageCandidates);
    return { deleted: true };
  });
}

export function deleteSceneCommand(store: Store, id: string, value: unknown) {
  fields(record(value), []);
  return store.transaction(() => {
    const command = store.story.command(id);
    assertIdle(store, command.chatId);
    if (command.runId || command.sourceRevision)
      throw new HttpError(
        409,
        '실행 기록에 연결된 새 장면 요청이에요. 해당 분기 또는 채팅과 함께 삭제해 주세요.'
      );
    if (store.db.prepare('SELECT 1 FROM outline_nodes WHERE command_id=?').get(id))
      throw new HttpError(
        409,
        '구성 항목에 연결된 새 장면 요청이에요. 구성에서 먼저 분리하거나 구성 항목을 삭제해 주세요.'
      );
    store.db.prepare('DELETE FROM scene_commands WHERE id=?').run(id);
    store.event(command.chatId, 'scene.command.deleted', id);
    return { deleted: true, chatId: command.chatId };
  });
}

export function chatDeletionRoutes(
  app: FastifyInstance,
  store: Store,
  publish: (chatId: string) => void,
  onChatDeleted?: (chatId: string) => void
) {
  app.get<{ Params: { id: string } }>('/api/chats/:id/deletion-impact', async (request) =>
    chatDeletionImpact(store, request.params.id)
  );
  app.delete<{ Params: { id: string } }>('/api/chats/:id', async (request) => {
    const result = deleteChat(store, request.params.id, request.body);
    onChatDeleted?.(request.params.id);
    return result;
  });

  app.delete<{ Params: { id: string } }>('/api/scene-commands/:id', async (request) => {
    const result = deleteSceneCommand(store, request.params.id, request.body ?? {});
    publish(result.chatId);
    return result;
  });
}
