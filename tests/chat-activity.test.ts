import { afterEach, expect, test } from 'vitest';
import { createApp, type App } from '../server/app.js';
import { createFixtureChat } from './fixtures/chat.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

let app: App | undefined;
let directory: string | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  if (directory) {
    const target = resolve(directory);
    const within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('uimori-chat-activity-')
    )
      throw new Error('Unsafe cleanup');
    await rm(target, { recursive: true, force: true });
    directory = undefined;
  }
});

test('sidebar activity groups all chats, excludes settled and stale work, and exposes metadata only', async () => {
  directory = await mkdtemp(join(tmpdir(), 'uimori-chat-activity-'));
  app = await createApp({
    dbPath: join(directory, 'activity.sqlite'),
    buildId: 'chat-activity-test',
    testMode: true,
  });
  const store = app.store;
  const first = createFixtureChat(store, 'First');
  const second = createFixtureChat(store, 'Second');
  const makeRun = (chatId: string) => {
    const chat = store.chat(chatId);
    return store.createRun(
      chatId,
      {
        request: 'Private request',
        expectedRevision: null,
        expectedSettingsRevision: chat.settingsRevision,
        idempotencyKey: randomUUID(),
      },
      (current) => ({
        chatId,
        parentRevision: current.headRevision,
        settingsRevision: current.settingsRevision,
        settings: current.settings,
        request: 'Private request',
        history: [],
        resources: [],
      })
    ).run;
  };
  const firstRun = makeRun(first.id);
  const secondRun = makeRun(second.id);
  store.db.prepare("UPDATE runs SET status='waiting_for_state' WHERE id=?").run(secondRun.id);
  const initial = await app.inject('/api/chat-activities');
  expect(initial.statusCode).toBe(200);
  expect(initial.json()).toEqual(
    [first.id, second.id].sort().map((chatId) => ({ chatId, kind: 'main', count: 1 }))
  );
  store.startRun(firstRun.id);
  const source = store.completeRun(
    firstRun.id,
    'Private source',
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    firstRun.snapshot.settings
  );
  store.db.prepare("UPDATE jobs SET status='completed' WHERE chat_id=?").run(first.id);
  store.db
    .prepare("INSERT INTO story_configs(chat_id,revision,body) VALUES(?,1,'{}')")
    .run(first.id);
  const add = (kind: 'state', hash: string, status: string) => {
    const id = randomUUID();
    store.db
      .prepare(`INSERT INTO story_jobs(id,chat_id,source_revision,source_hash,kind,config_revision,status,snapshot,mock,created_at,updated_at,dependency_key)
        VALUES(?,?,?,?,?,1,?,'{}',1,'2026-09-08','2026-09-08',?)`)
      .run(id, first.id, source.id, hash, kind, status, id);
  };
  add('state', source.hash, 'queued');
  add('state', source.hash, 'running');
  add('state', source.hash, 'failed');
  add('state', 'old-source-hash', 'running');
  const active = (await app.inject('/api/chat-activities')).json();
  expect(active).toEqual(
    [
      { chatId: first.id, kind: 'state', count: 2 },
      { chatId: second.id, kind: 'main', count: 1 },
    ].sort((a, b) => a.chatId.localeCompare(b.chatId))
  );
  expect(JSON.stringify(active)).not.toContain('Private');
  store.editSource(source.id, { text: 'New source text', expectedRevision: 0 });
  expect((await app.inject('/api/chat-activities')).json()).toEqual([
    { chatId: second.id, kind: 'main', count: 1 },
  ]);
});
