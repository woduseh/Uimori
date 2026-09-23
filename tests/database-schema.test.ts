import { HelperWorkspace } from '../server/helper-workspace.js';
import { ChatOptionsStore } from '../server/chat-options.js';
import { vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { describe } from 'vitest';
import { afterEach, expect, test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import {
  DATABASE_SCHEMA_VERSION,
  databaseSchemaVersion,
  initializeDatabaseSchema,
} from '../server/database-schema.js';

const paths: string[] = [];
afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});
function file() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-schema-v1-'));
  paths.push(directory);
  return join(directory, 'app.sqlite');
}

test('personal current schema initializes and remains readable after an extra query index', () => {
  const path = file();
  const first = new Store(path);
  expect(databaseSchemaVersion(first.db)).toBe(DATABASE_SCHEMA_VERSION);
  first.db.exec('CREATE INDEX optional_user_index ON sources(created_at)');
  first.close();
  const next = new Store(path);
  expect(databaseSchemaVersion(next.db)).toBe(DATABASE_SCHEMA_VERSION);
  expect(
    next.db.prepare("SELECT name FROM sqlite_schema WHERE name='optional_user_index'").get()
  ).toBeTruthy();
  next.close();
});

test.each([DATABASE_SCHEMA_VERSION + 1, 23, 24])(
  'opening another schema %s leaves its bytes untouched',
  (version) => {
    const path = file(),
      db = new DatabaseSync(path);
    db.exec(
      `CREATE TABLE retained(text TEXT); INSERT INTO retained VALUES('original'); PRAGMA user_version=${version}`
    );
    db.close();
    const before = readFileSync(path);
    expect(() => new Store(path)).toThrow(/transfer user data/);
    expect(readFileSync(path)).toEqual(before);
  }
);

test('an old database that also used numeric version 1 is not mistaken for personal v1', () => {
  const path = file(),
    db = new DatabaseSync(path);
  db.exec('CREATE TABLE unrelated(id TEXT); PRAGMA user_version=1');
  db.close();
  const before = readFileSync(path);
  expect(() => new Store(path)).toThrow('DATABASE_FORMAT_MISMATCH:1');
  expect(readFileSync(path)).toEqual(before);
});

test('unversioned nonempty databases are not inferred or overwritten', () => {
  const db = new DatabaseSync(file());
  try {
    db.exec('CREATE TABLE another_application(id TEXT)');
    expect(() => databaseSchemaVersion(db)).toThrow(/not an empty/);
  } finally {
    db.close();
  }
});

test('failed fresh initialization rolls back its tables and version', () => {
  const db = new DatabaseSync(file());
  try {
    expect(() =>
      initializeDatabaseSchema(db, () => {
        db.exec('CREATE TABLE temporary_data(id TEXT)');
        throw new Error('synthetic failure');
      })
    ).toThrow('synthetic failure');
    expect(databaseSchemaVersion(db)).toBe(0);
    expect(
      db.prepare("SELECT 1 FROM sqlite_schema WHERE name='temporary_data'").get()
    ).toBeUndefined();
  } finally {
    db.close();
  }
});

describe('Prior schema 1 migration', () => {
  const owned: { store: Store; path: string }[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const item of owned.splice(0)) {
      item.store.close();
      rmSync(item.path, { recursive: true, force: true });
    }
  });

  test('real prior schema-1 output upgrades with original text, translation and oneoff semantics intact', () => {
    const path = mkdtempSync(join(tmpdir(), 'uimori-real-migration-'));
    const db = new DatabaseSync(join(path, 'app.sqlite'));
    db.exec('PRAGMA foreign_keys=OFF');
    db.exec(readFileSync(new URL('./fixtures/personal-schema-1.sql', import.meta.url), 'utf8'));
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
    expect(db.prepare('SELECT count(*) AS n FROM helper_delegations').get()?.n).toBe(1);
    const original = db.prepare('SELECT id,text FROM sources ORDER BY id').all();
    const translations = db.prepare('SELECT job_id,result FROM job_results ORDER BY job_id').all();
    db.close();
    const owner = { store: new Store(join(path, 'app.sqlite')), path };
    owned.push(owner);
    const store = owner.store,
      chat = store.chats()[0]!;
    const options = new ChatOptionsStore(store),
      state = options.get(chat.id);
    expect(store.db.prepare('PRAGMA user_version').get()?.user_version).toBe(
      DATABASE_SCHEMA_VERSION
    );
    expect(store.db.prepare('SELECT id,text FROM sources ORDER BY id').all()).toEqual(original);
    expect(store.db.prepare('SELECT job_id,result FROM job_results ORDER BY job_id').all()).toEqual(
      translations
    );
    expect(state.fixedValues).toEqual({ tone: 'bold' });
    expect(state.pending.map((p) => p.values)).toEqual([{ tone: 'warm' }]);
    expect(state.pending[0]).not.toHaveProperty('headHash');
    const request = {
      request: 'Continue',
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      branchId: state.branchId,
      idempotencyKey: randomUUID(),
    };
    const run = store.createRun(chat.id, request, (c) => ({
      chatId: c.id,
      parentRevision: c.headRevision,
      settings: c.settings,
      settingsRevision: c.settingsRevision,
      request: request.request,
      history: store.history(c.headRevision),
      resources: [],
      profile: store.product.snapshot(c.id),
    }));
    expect(run.run.snapshot.profile!.chatOptions!.values).toEqual({ tone: 'warm' });
    expect(options.get(chat.id).pending).toEqual([]);
    expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    store.close();
    owner.store = new Store(join(path, 'app.sqlite'));
    expect(owner.store.db.prepare('PRAGMA user_version').get()?.user_version).toBe(
      DATABASE_SCHEMA_VERSION
    );
  });
});

describe('Prior schema 3 independent chat migration', () => {
  const owners: { store: Store; path: string }[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const { store, path } of owners.splice(0)) {
      store.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  test('real previous schema 3 converts shared branches once while preserving independent user data', () => {
    const path = mkdtempSync(join(tmpdir(), 'uimori-final-migration-'));
    const db = new DatabaseSync(join(path, 'app.sqlite'));
    db.exec('PRAGMA foreign_keys=OFF');
    db.exec(readFileSync(new URL('./fixtures/personal-schema-3.sql', import.meta.url), 'utf8'));
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(3);
    const originalId = String(
      db.prepare("SELECT id FROM chats WHERE title='Legacy shared story'").get()!.id
    );
    const standaloneId = String(
      db.prepare("SELECT id FROM chats WHERE title='Standalone unchanged'").get()!.id
    );
    const conversationId = String(db.prepare('SELECT id FROM helper_conversations').get()!.id);
    const artifactText = db.prepare('SELECT text FROM helper_artifacts').get()!.text;
    db.close();
    const owner = { path, store: new Store(join(path, 'app.sqlite')) };
    owners.push(owner);
    const store = owner.store;
    expect(store.db.prepare('PRAGMA user_version').get()?.user_version).toBe(
      DATABASE_SCHEMA_VERSION
    );
    expect(() => store.chat(originalId)).toThrow('Chat not found');
    expect(store.chat(standaloneId).title).toBe('Standalone unchanged');
    expect(store.context.current(standaloneId)).toMatchObject({
      usable: true,
      checkpoint: { plan: { summary: 'Standalone current summary.' } },
    });
    const copies = store.chats().filter((c) => c.id !== standaloneId);
    expect(copies).toHaveLength(2);
    const alternative = copies.find((c) => c.title.includes('Alternative'))!;
    const original = copies.find((c) => c.id !== alternative.id)!;
    expect(store.history(original.headRevision).map((s) => s.text)).toEqual([
      'Shared first scene.',
      'Default ending.',
    ]);
    expect(store.history(alternative.headRevision).map((s) => s.text)).toEqual([
      'Shared first scene.',
      'Alternative ending.',
    ]);
    expect(
      store.db
        .prepare('SELECT result FROM job_results')
        .all()
        .map((r) => JSON.parse(String(r.result)).text)
    ).toEqual(expect.arrayContaining(['공통 첫 장면.', '기본 결말.']));
    expect(copies.every((c) => store.product.branches(c.id).length === 1)).toBe(true);
    const helpers = new HelperWorkspace(store);
    expect(helpers.conversation(conversationId).scope).toMatchObject({ chatId: alternative.id });
    expect(store.db.prepare('SELECT text FROM helper_artifacts').get()!.text).toBe(artifactText);
    expect(helpers.messages(conversationId).map((m) => m.text)).toEqual(
      expect.arrayContaining(['Preserve this helper question', 'Preserved helper answer.'])
    );
    const options = new ChatOptionsStore(store).get(alternative.id);
    expect(options.pending.map((p) => p.values)).toEqual([{ tone: 'quiet' }]);
    expect(
      store.story.notes
        .entries({ chatId: alternative.id, history: store.history(alternative.headRevision) })
        .map((n) => n.text)
    ).toContain('Only this route has the silver key.');
    expect(
      store.db
        .prepare('SELECT values_json FROM chat_variable_states WHERE chat_id=?')
        .get(alternative.id)?.values_json
    ).toBe('{"choice":"alternate"}');
    expect(store.db.prepare('SELECT count(*) AS n FROM assets').get()?.n).toBe(1);
    expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    const ids = store
      .chats()
      .map((c) => c.id)
      .sort();
    store.close();
    owner.store = new Store(join(path, 'app.sqlite'));
    expect(
      owner.store
        .chats()
        .map((c) => c.id)
        .sort()
    ).toEqual(ids);
  });
});
