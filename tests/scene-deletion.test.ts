import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { forkChat } from '../server/chat-fork.js';
import { readChatVariables, writeChatVariables } from '../server/chat-variables.js';
import { OrphanMemory } from '../server/orphan-memory.js';
import { nativeSourceSnapshot } from '../server/risu-native-actions.js';
import { readStoredRunSnapshot } from '../server/run-projections.js';
import { deleteScenes, sceneDeletionImpact } from '../server/scene-deletion.js';
import { updateSceneContext } from '../server/scene-context.js';
import { Store } from '../server/store.js';
import { createFixtureChat } from './fixtures/chat.js';
import { createTestDirectory } from './fixtures/test-directory.js';

const owned: { store: Store; remove: () => void }[] = [];
afterEach(() => {
  for (const item of owned.splice(0)) {
    item.store.close();
    item.remove();
  }
});
function database() {
  const temporary = createTestDirectory('uimori-scene-deletion-');
  const store = new Store(join(temporary.directory, 'synthetic.sqlite'));
  owned.push({ store, remove: temporary.remove });
  return store;
}
function queued(store: Store, chatId: string) {
  const chat = store.chat(chatId),
    profile = store.product.snapshot(chatId);
  return store.createRun(
    chatId,
    {
      request: 'Synthetic continuation',
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (current) => ({
      chatId,
      parentRevision: current.headRevision,
      settingsRevision: current.settingsRevision,
      settings: current.settings,
      request: 'Synthetic continuation',
      history: store.history(current.headRevision),
      resources: store.product.resources(chatId, profile),
      profile,
    })
  ).run;
}
function complete(store: Store, chatId: string, text: string) {
  const run = queued(store, chatId);
  store.startRun(run.id);
  return store.completeRun(run.id, text, {
    modelCalls: 0,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  });
}
function variable(store: Store, chatId: string, value: string) {
  const chat = store.chat(chatId);
  return writeChatVariables(store, chatId, {
    expectedRevision: readChatVariables(store, chatId).revision,
    expectedSourceHash: chat.headRevision ? store.source(chat.headRevision).hash : null,
    idempotencyKey: randomUUID(),
    values: { chapter: value },
  });
}
function manuscript() {
  const store = database(),
    chat = createFixtureChat(store, 'Synthetic A B C');
  variable(store, chat.id, 'A');
  const a = complete(store, chat.id, 'Scene A: the beginning.');
  variable(store, chat.id, 'B');
  const b = complete(store, chat.id, 'Scene B: the bridge.');
  const note = store.story.notes.write(chat.id, {
    text: 'A remembered bridge.',
    author: 'Synthetic author',
    expectedRevision: 0,
    expectedHeadRevision: b.id,
    idempotencyKey: 'bridge-note',
  }).note;
  variable(store, chat.id, 'C');
  const c = complete(store, chat.id, 'Scene C: the conclusion.');
  return { store, chatId: chat.id, a, b, c, note };
}
function request(f: ReturnType<typeof manuscript>, scope: 'only' | 'following' = 'only') {
  return {
    ...sceneDeletionImpact(f.store, f.chatId, f.b.id).request,
    scope,
    idempotencyKey: randomUUID(),
  };
}
function intact(store: Store) {
  expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
}

test('deleting only B preserves C identity, text and hash, reconnects it to A and leaves an independent copy untouched', () => {
  const f = manuscript(),
    { store, chatId, a, b, c } = f;
  const copied = forkChat(store, chatId, {
    fromRevision: c.id,
    idempotencyKey: 'independent-copy',
  });
  const copyBefore = store.history(copied.headRevision);
  expect(copyBefore.map((source) => source.revision)).not.toContain(b.id);
  const variables = readChatVariables(store, chatId);
  const impact = sceneDeletionImpact(store, chatId, b.id);
  expect(impact).toMatchObject({
    sourceId: b.id,
    onlyCount: 1,
    followingCount: 2,
    orphanNoteCount: { only: 1, following: 1 },
  });
  const result = deleteScenes(store, chatId, b.id, request(f));
  expect(result).toMatchObject({ deleted: true, sourceIds: [b.id], headRevision: c.id });
  expect(store.history(store.chat(chatId).headRevision).map((source) => source.revision)).toEqual([
    a.id,
    c.id,
  ]);
  expect(store.source(c.id)).toMatchObject({
    id: c.id,
    text: c.text,
    hash: c.hash,
    parentRevision: a.id,
  });
  expect(store.run(c.runId).parentRevision).toBe(a.id);
  expect(readChatVariables(store, chatId)).toEqual(variables);
  expect(store.history(store.chat(copied.id).headRevision)).toEqual(copyBefore);
  expect(store.db.prepare('SELECT id FROM sources WHERE id=?').get(b.id)).toBeUndefined();
  expect(store.db.prepare('SELECT id FROM runs WHERE id=?').get(b.runId)).toBeUndefined();
  intact(store);
});

test('deleting B and following scenes restores A checkpoint and preserves the removed note as invisible orphan memory', () => {
  const f = manuscript(),
    { store, chatId, a, b, c, note } = f;
  const variables = readChatVariables(store, chatId);
  store.editSource(b.id, { expectedRevision: 0, text: 'Edited bridge.' });
  store.editTranslation(b.id, {
    expectedRevision: 0,
    expectedSourceHash: store.source(b.id).hash,
    text: '번역된 다리.',
  });
  const result = deleteScenes(store, chatId, b.id, request(f, 'following'));
  expect(result.sourceIds).toEqual([b.id, c.id]);
  expect(store.chat(chatId).headRevision).toBe(a.id);
  expect(readChatVariables(store, chatId)).toEqual({
    revision: variables.revision + 1,
    values: { chapter: 'A' },
  });
  expect(store.story.detail(chatId).notes).toEqual([]);
  expect(
    JSON.parse(
      String(store.db.prepare('SELECT entry FROM author_notes WHERE id=?').get(note.id)?.entry)
    )
  ).toEqual(note);
  expect(new OrphanMemory(store).detail(chatId).entries).toContainEqual({
    kind: 'note',
    note,
    reason: 'missing-source',
  });
  for (const id of [b.id, c.id]) {
    expect(store.db.prepare('SELECT id FROM sources WHERE id=?').get(id)).toBeUndefined();
    expect(
      store.db.prepare('SELECT source_id FROM chat_variable_outputs WHERE source_id=?').get(id)
    ).toBeUndefined();
  }
  expect(
    store.db.prepare('SELECT source_id FROM source_edits WHERE source_id=?').get(b.id)
  ).toBeUndefined();
  expect(store.db.prepare('SELECT id FROM jobs WHERE source_revision=?').get(b.id)).toBeUndefined();
  intact(store);
});

test.each(['head', 'settings', 'hash'] as const)(
  'a stale %s review rejects deletion without changing the manuscript',
  (boundary) => {
    const f = manuscript(),
      command = request(f);
    if (boundary === 'head') command.expectedHeadRevision = f.a.id;
    if (boundary === 'settings') command.expectedSettingsRevision += 1;
    if (boundary === 'hash') command.expectedSourceHash = '0'.repeat(64);
    expect(() => deleteScenes(f.store, f.chatId, f.b.id, command)).toThrow('채팅이 변경');
    expect(
      f.store.history(f.store.chat(f.chatId).headRevision).map((source) => source.revision)
    ).toEqual([f.a.id, f.b.id, f.c.id]);
    intact(f.store);
  }
);

test.each(['later source', 'request context', 'variables'] as const)(
  'a %s change after reviewing a following deletion requires a fresh review',
  (boundary) => {
    const f = manuscript(),
      command = request(f, 'following');
    if (boundary === 'later source')
      f.store.editSource(f.c.id, { expectedRevision: 0, text: 'Revised conclusion after review.' });
    if (boundary === 'request context')
      updateSceneContext(f.store, f.b.id, {
        expectedRevision: 0,
        requestText: 'Revised bridge request.',
      });
    if (boundary === 'variables') variable(f.store, f.chatId, 'Revised after review');
    const variables = readChatVariables(f.store, f.chatId);
    expect(() => deleteScenes(f.store, f.chatId, f.b.id, command)).toThrow('채팅이 변경');
    expect(
      f.store.history(f.store.chat(f.chatId).headRevision).map((source) => source.revision)
    ).toEqual([f.a.id, f.b.id, f.c.id]);
    expect(readChatVariables(f.store, f.chatId)).toEqual(variables);
    intact(f.store);
  }
);

test('replaying a successful receipt during a new active run does not publish another deletion', () => {
  const f = manuscript(),
    command = request(f),
    published: string[] = [];
  const notify = (chatId: string) => {
    published.push(chatId);
  };
  const result = deleteScenes(f.store, f.chatId, f.b.id, command, notify);
  expect(published).toEqual([f.chatId]);
  const active = queued(f.store, f.chatId);
  expect(deleteScenes(f.store, f.chatId, f.b.id, command, notify)).toEqual(result);
  expect(published).toEqual([f.chatId]);
  expect(f.store.run(active.id).status).toBe('queued');
  expect(f.store.chat(f.chatId).settingsRevision).toBe(result.settingsRevision);
  intact(f.store);
});

test('illustration diagnostic attempt IDs retain numeric usage while detaching deleted scene payloads', () => {
  const f = manuscript(),
    time = new Date().toISOString();
  f.store.db
    .prepare(
      "INSERT INTO attempts(id,chat_id,role,connection_id,model_id,status,request,response,input_tokens,output_tokens,cost_usd) VALUES('deleted-illustration',?,'illustration','fixture','fixture','completed',?,?,17,23,0.25)"
    )
    .run(
      f.chatId,
      JSON.stringify({ prompt: 'Synthetic removed bridge image request' }),
      JSON.stringify({ text: 'Synthetic private image response' })
    );
  f.store.db
    .prepare(
      "INSERT INTO illustration_jobs(id,chat_id,source_revision,source_hash,origin,status,input,diagnostic,created_at,updated_at) VALUES('deleted-illustration-job',?,?,?,'manual','completed','{}',?,?,?)"
    )
    .run(
      f.chatId,
      f.b.id,
      f.b.hash,
      JSON.stringify({ attempts: ['deleted-illustration'] }),
      time,
      time
    );
  deleteScenes(f.store, f.chatId, f.b.id, request(f));
  expect(
    f.store.db.prepare("SELECT id FROM illustration_jobs WHERE id='deleted-illustration-job'").get()
  ).toBeUndefined();
  const attempt = f.store.db
    .prepare(
      "SELECT chat_id,run_id,job_id,usage_detached,request,response,input_tokens,output_tokens,cost_usd FROM attempts WHERE id='deleted-illustration'"
    )
    .get();
  expect(attempt).toMatchObject({
    chat_id: null,
    run_id: null,
    job_id: null,
    usage_detached: 1,
    request: '{}',
    input_tokens: 17,
    output_tokens: 23,
    cost_usd: 0.25,
  });
  expect(JSON.parse(String(attempt?.response))).toMatchObject({ detailsOmitted: true });
  expect(String(attempt?.response)).not.toContain('Synthetic private');
  intact(f.store);
});

test('active generation and outstanding provider calls reject a reviewed deletion; an identical completed request is idempotent', () => {
  const f = manuscript(),
    command = request(f),
    pending = queued(f.store, f.chatId);
  expect(() => sceneDeletionImpact(f.store, f.chatId, f.b.id)).toThrow('진행 중');
  expect(() => deleteScenes(f.store, f.chatId, f.b.id, command)).toThrow('진행 중');
  f.store.finishRun(pending.id, 'cancelled', 'Synthetic cancellation');
  f.store.db
    .prepare(
      "INSERT INTO attempts(id,chat_id,run_id,role,connection_id,model_id,status,request) VALUES('scene-delete-attempt',?,?,'main','fixture','fixture','running','{}')"
    )
    .run(f.chatId, pending.id);
  expect(() => deleteScenes(f.store, f.chatId, f.b.id, command)).toThrow('프로바이더 요청');
  f.store.db
    .prepare("UPDATE attempts SET status='cancelled' WHERE id='scene-delete-attempt'")
    .run();
  const deleted = deleteScenes(f.store, f.chatId, f.b.id, command);
  expect(deleteScenes(f.store, f.chatId, f.b.id, command)).toEqual(deleted);
  expect(f.store.chat(f.chatId).settingsRevision).toBe(deleted.settingsRevision);
  expect(() =>
    deleteScenes(f.store, f.chatId, f.b.id, { ...command, scope: 'following' })
  ).toThrow();
  intact(f.store);
});

test('C native message edits cannot resurrect the removed B in reconstructed history', () => {
  const f = manuscript(),
    { store, chatId, b, c } = f;
  const snapshot = readStoredRunSnapshot(store, c.runId);
  snapshot.messageChanges = {
    removed: [],
    updated: [
      {
        message: {
          id: `source:${b.id}`,
          role: 'assistant',
          text: 'Native revised bridge.',
          sourceRevision: b.id,
          sourceHash: b.hash,
        },
      },
    ],
    order: [`request:${b.id}`, `source:${b.id}`, `source:${c.id}`],
  };
  store.db.prepare('UPDATE runs SET snapshot=? WHERE id=?').run(JSON.stringify(snapshot), c.runId);
  expect(nativeSourceSnapshot(store, chatId, c.id).snapshot.logicalHistory).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: `source:${b.id}`, text: 'Native revised bridge.' }),
    ])
  );
  deleteScenes(store, chatId, b.id, request(f));
  const history = nativeSourceSnapshot(store, chatId, c.id).snapshot.logicalHistory!;
  expect(
    history.some(
      (message) =>
        message.id === `source:${b.id}` ||
        message.id === `request:${b.id}` ||
        message.sourceRevision === b.id
    )
  ).toBe(false);
  expect(
    history.some((message) => message.id === `source:${c.id}` && message.text === c.text)
  ).toBe(true);
  intact(store);
});

test('failed runs that captured deleted text lose that captured context and cannot be retried', () => {
  const f = manuscript(),
    failed = queued(f.store, f.chatId);
  f.store.finishRun(failed.id, 'failed', 'Synthetic provider failure');
  expect(
    readStoredRunSnapshot(f.store, failed.id).history.some((source) => source.revision === f.b.id)
  ).toBe(true);
  deleteScenes(f.store, f.chatId, f.b.id, request(f));
  const snapshot = readStoredRunSnapshot(f.store, failed.id);
  expect(snapshot.invalidatedBySceneDeletion).toBe(true);
  expect(snapshot.history).toEqual([]);
  expect(() => f.store.retryRun(failed.id, 'deleted-context-retry')).toThrow(
    'SCENE_DELETED_RETRY_UNAVAILABLE'
  );
  intact(f.store);
});
