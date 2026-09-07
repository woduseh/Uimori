import { createFixtureChat, injectWithFixtureBot } from './fixtures/chat.js';
import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import Fastify from 'fastify';
import { Store } from '../server/store.js';
import {
  deleteLibraryItem,
  libraryDeletionImpact,
  libraryDeletionRoutes,
  type LibraryKind,
} from '../server/library-deletion.js';

const owned: { directory: string; store: Store }[] = [];
function database() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-deletion-'));
  const store = new Store(join(directory, 'test.sqlite'));
  owned.push({ directory, store });
  return store;
}
afterEach(() => {
  for (const { directory, store } of owned.splice(0)) {
    store.close();
    const target = resolve(directory),
      within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('uimori-deletion-')
    )
      throw new Error('Unsafe cleanup');
    rmSync(target, { recursive: true, force: true });
  }
});
const content = (title = 'Synthetic', relatedIds: string[] = []) => ({
  kind: 'module',
  title,
  description: '',
  text: 'Synthetic module',
  loading: 'pinned',
  relatedIds,
});

test('deletes every revision, rejects stale CAS and missing items, without affecting unrelated rows', () => {
  const s = database(),
    a = s.product.content(content()),
    b = s.product.content(content('Keep'));
  const changed = s.product.content({ ...content('Changed'), expectedRevision: 1 }, a.id);
  expect(() => deleteLibraryItem(s, 'content', a.id, { expectedRevision: 1 })).toThrow(
    '항목이 변경'
  );
  expect(libraryDeletionImpact(s, 'content', a.id)).toMatchObject({ canDelete: true, revision: 2 });
  expect(deleteLibraryItem(s, 'content', a.id, { expectedRevision: changed.revision })).toEqual({
    deleted: true,
    id: a.id,
  });
  expect(s.db.prepare('SELECT * FROM versions WHERE id=?').all(a.id)).toEqual([]);
  expect(s.product.get('content', b.id)).toEqual(b);
  expect(() => deleteLibraryItem(s, 'content', a.id, { expectedRevision: 2 })).toThrow('not found');
});

test('references in old versions block deletion until the owning item is removed', () => {
  const s = database(),
    module = s.product.content(content()),
    owner = s.product.content(content('Owner', [module.id]));
  s.product.content({ ...content('Unlinked now'), expectedRevision: 1 }, owner.id);
  expect(libraryDeletionImpact(s, 'content', module.id).blockers).toContainEqual(
    expect.objectContaining({ table: 'versions', count: 1 })
  );
  const before = s.product.export();
  expect(() => deleteLibraryItem(s, 'content', module.id, { expectedRevision: 1 })).toThrow(
    '이전 개정'
  );
  expect(s.product.export().tables).toEqual(before.tables);
  deleteLibraryItem(s, 'content', owner.id, { expectedRevision: 2 });
  deleteLibraryItem(s, 'content', module.id, { expectedRevision: 1 });
});

test('prompt combinations and chat profile references are protected; JSON substring is not a reference', () => {
  const s = database(),
    prompt = s.product.promptPreset({ title: 'Prompt', role: 'main', text: 'Write' });
  const combination = s.product.promptCombination({
    title: 'Options',
    prompt: { id: prompt.id, revision: 1 },
    values: {},
  });
  expect(() => deleteLibraryItem(s, 'prompt-preset', prompt.id, { expectedRevision: 1 })).toThrow(
    '다른 자료'
  );
  deleteLibraryItem(s, 'prompt-combination', combination.id, { expectedRevision: 1 });
  const chat = createFixtureChat(s, 'Synthetic'),
    profile = s.product.profile(chat.id);
  s.db
    .prepare(
      'INSERT INTO profiles VALUES(?,?) ON CONFLICT(chat_id) DO UPDATE SET body=excluded.body'
    )
    .run(
      chat.id,
      JSON.stringify({
        ...profile,
        prompts: { main: { id: prompt.id, revision: 1 }, translation: null },
      })
    );
  expect(libraryDeletionImpact(s, 'prompt-preset', prompt.id).blockers).toContainEqual(
    expect.objectContaining({ table: 'profiles' })
  );
  s.db.prepare('DELETE FROM profiles WHERE chat_id=?').run(chat.id);
  s.product.content({ ...content(), text: `Some text containing ${prompt.id} inside a sentence` });
  deleteLibraryItem(s, 'prompt-preset', prompt.id, { expectedRevision: 1 });
});

test('model and connection deletion respects current references but preserves completed diagnostics', () => {
  const s = database(),
    c = s.product.connection({
      title: 'Fixture',
      protocol: 'openai-chat-v1',
      endpoint: 'http://127.0.0.1:9999/v1',
      enabled: true,
    });
  const m = s.product.model({
    title: 'Model',
    connectionId: c.id,
    modelId: 'synthetic',
    maxOutputTokens: 100,
    temperature: null,
  });
  expect(() => deleteLibraryItem(s, 'connection', c.id, { expectedRevision: 1 })).toThrow(
    '저장된 모델 설정'
  );
  s.db
    .prepare('INSERT INTO provider_connection_tests VALUES(?,?,?,?,?,?,?)')
    .run('test', 'key', m.id, 1, 'running', null, JSON.stringify({ model: m, connection: c }));
  expect(() => deleteLibraryItem(s, 'model', m.id, { expectedRevision: 1 })).toThrow('응답 테스트');
  s.db.prepare("UPDATE provider_connection_tests SET status='completed'").run();
  deleteLibraryItem(s, 'model', m.id, { expectedRevision: 1 });
  deleteLibraryItem(s, 'connection', c.id, { expectedRevision: 1 });
  expect(s.db.prepare('SELECT model_id FROM provider_connection_tests').get()).toEqual({
    model_id: m.id,
  });
});

test('all supported kinds expose DELETE and read-only impact routes with strict request validation', async () => {
  const s = database(),
    app = Fastify();
  libraryDeletionRoutes(app, s);
  const routes: Partial<Record<LibraryKind, string>> = {
    content: 'content',
    'prompt-preset': 'prompt-presets',
    'prompt-combination': 'prompt-combinations',
  };
  try {
    for (const [kind, path] of Object.entries(routes)) {
      const item = s.product.save(kind, { title: 'Synthetic minimal route fixture' });
      expect(
        (
          await injectWithFixtureBot(app, {
            method: 'GET',
            url: `/api/${path}/${item.id}/deletion-impact`,
          })
        ).json()
      ).toMatchObject({ canDelete: true });
      expect(
        (
          await injectWithFixtureBot(app, {
            method: 'DELETE',
            url: `/api/${path}/${item.id}`,
            payload: {},
          })
        ).statusCode
      ).toBe(400);
      expect(
        (
          await injectWithFixtureBot(app, {
            method: 'DELETE',
            url: `/api/${path}/${item.id}`,
            payload: { expectedRevision: 1, force: true },
          })
        ).statusCode
      ).toBe(400);
      expect(
        (
          await injectWithFixtureBot(app, {
            method: 'DELETE',
            url: `/api/${path}/${item.id}`,
            payload: { expectedRevision: 1 },
          })
        ).statusCode
      ).toBe(200);
    }
  } finally {
    await app.close();
  }
});

test('active captured provider work blocks deletion; terminal snapshots survive deletion and archive restore', () => {
  const s = database(),
    chat = createFixtureChat(s, 'Synthetic frozen run');
  const c = s.product.connection({
    title: 'Fixture',
    protocol: 'openai-chat-v1',
    endpoint: 'http://127.0.0.1:9999/v1',
    enabled: true,
  });
  const m = s.product.model({
    title: 'Model',
    connectionId: c.id,
    modelId: 'synthetic',
    maxOutputTokens: 100,
    temperature: null,
  });
  const p = s.product.profile(chat.id);
  s.product.updateProfile(chat.id, {
    expectedRevision: p.revision,
    attachments: [],
    personaReference: p.personaReference,
    routes: { ...p.routes, main: { id: m.id } },
    image: false,
  });
  const captured = s.product.snapshot(chat.id)!;
  const run = s.createRun(
    chat.id,
    {
      request: 'Synthetic',
      expectedRevision: null,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: 'deletion-snapshot',
    },
    (current) => ({
      chatId: chat.id,
      parentRevision: null,
      settingsRevision: current.settingsRevision,
      settings: current.settings,
      request: 'Synthetic',
      history: [],
      resources: s.product.resources(chat.id, captured),
      profile: captured,
    })
  ).run;
  const current = s.product.profile(chat.id);
  s.product.updateProfile(chat.id, {
    expectedRevision: current.revision,
    attachments: [],
    personaReference: current.personaReference,
    routes: p.routes,
    image: false,
  });
  expect(libraryDeletionImpact(s, 'model', m.id).blockers).toContainEqual(
    expect.objectContaining({ table: 'runs' })
  );
  s.finishRun(run.id, 'cancelled', 'Synthetic cancellation');
  const frozen = s.run(run.id).snapshot;
  deleteLibraryItem(s, 'model', m.id, { expectedRevision: 1 });
  deleteLibraryItem(s, 'connection', c.id, { expectedRevision: 1 });
  expect(s.run(run.id).snapshot).toEqual(frozen);
  const target = database();
  expect(target.product.import(s.product.export())).toEqual({ restored: true, chats: 1 });
  expect(target.run(run.id).snapshot.profile?.models.main?.id).toBe(m.id);
  expect(target.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});
