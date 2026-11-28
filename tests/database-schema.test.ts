import { afterEach, expect, test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Store } from '../server/store.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { createFixtureChat } from './fixtures/chat.js';
import { readHelperTaskResults } from '../server/helper-task-results.js';
import { completedSource } from './fixtures/illustration.js';
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
  const directory = mkdtempSync(join(tmpdir(), 'uimori-schema-'));
  paths.push(directory);
  return join(directory, 'app.sqlite');
}
test('current schema initializes and remains readable after an extra query index', () => {
  const path = file(),
    first = new Store(path);
  expect(databaseSchemaVersion(first.db)).toBe(DATABASE_SCHEMA_VERSION);
  expect(
    first.db.prepare("SELECT name FROM sqlite_schema WHERE name='execution_tool_diagnostics'").get()
  ).toBeTruthy();
  first.db.exec('DROP TABLE execution_tool_diagnostics');
  first.db.exec('CREATE INDEX optional_user_index ON sources(created_at)');
  first.close();
  const next = new Store(path);
  try {
    expect(databaseSchemaVersion(next.db)).toBe(DATABASE_SCHEMA_VERSION);
    expect(
      next.db
        .prepare("SELECT name FROM sqlite_schema WHERE name='execution_tool_diagnostics'")
        .get()
    ).toBeTruthy();
    expect(
      next.db.prepare("SELECT name FROM sqlite_schema WHERE name='optional_user_index'").get()
    ).toBeTruthy();
    expect(
      next.db
        .prepare("SELECT name FROM sqlite_schema WHERE name='branches' OR sql LIKE '%branch_id%'")
        .all()
    ).toEqual([]);
  } finally {
    next.close();
  }
});
test('a database and its backup with helper change records open with saved text and drop the records', () => {
  const path = file(),
    first = new Store(path);
  const chat = createFixtureChat(first, 'Existing chat');
  const sourceId = completedSource(first, chat.id, 'Saved scene text.').id;
  const savedText = first.source(sourceId).text;
  const workspace = new HelperWorkspace(first);
  const conversation = workspace.open({ kind: 'chat', chatId: chat.id });
  const model = first.product.model({
    title: 'Local test',
    connectionId: first.product.connection({
      title: 'Local test',
      protocol: 'fixture-sse-v1',
      endpoint: 'http://127.0.0.1:9',
      enabled: true,
    }).id,
    modelId: 'fixture-schema',
    temperature: null,
    maxOutputTokens: 1024,
  });
  const task = workspace.enqueue(conversation.id, 'key', 'Edit', {
    scope: conversation.scope,
    model: first.product.modelSnapshot(model.id),
    history: [],
    persona: '',
    limits: { helperCalls: 1, totalCalls: 1 },
  });
  const baselineImage = 'a'.repeat(64);
  const baselineThemeAsset = 'b'.repeat(64);
  first.db
    .prepare('INSERT INTO image_blobs(hash,mime,bytes) VALUES(?,?,?)')
    .run(baselineImage, 'image/png', Buffer.from('baseline-only image'));
  first.db
    .prepare('INSERT INTO theme_assets(hash,kind,mime,bytes,created_at) VALUES(?,?,?,?,?)')
    .run(
      baselineThemeAsset,
      'image',
      'image/png',
      Buffer.from('baseline-only asset'),
      new Date().toISOString()
    );
  first.db.exec(`CREATE TABLE helper_changes(
    task_id TEXT NOT NULL REFERENCES helper_tasks(id) ON DELETE CASCADE,
    domain TEXT NOT NULL,target_id TEXT NOT NULL,chat_id TEXT,source_id TEXT,
    position INTEGER NOT NULL,baseline TEXT,entries TEXT NOT NULL,
    text_removed TEXT CHECK(text_removed IN ('deleted','expired')),updated_at TEXT NOT NULL,
    result TEXT,foreign_edit INTEGER NOT NULL DEFAULT 0,rolled_back_at TEXT,
    PRIMARY KEY(task_id,domain,target_id));
  CREATE INDEX helper_changes_chat ON helper_changes(chat_id);
  CREATE INDEX helper_changes_source ON helper_changes(source_id);`);
  const insert = first.db.prepare(
    'INSERT INTO helper_changes(task_id,domain,target_id,chat_id,source_id,position,baseline,entries,updated_at,result) VALUES(?,?,?,?,?,?,?,?,?,?)'
  );
  const now = new Date().toISOString();
  insert.run(
    task.id,
    'scene',
    `${sourceId}:original`,
    chat.id,
    sourceId,
    1,
    JSON.stringify('Earlier text'),
    '[]',
    now,
    'f'.repeat(64)
  );
  insert.run(
    task.id,
    'resource',
    'content:bot-1',
    null,
    null,
    2,
    JSON.stringify({ portrait: baselineImage }),
    '[]',
    now,
    null
  );
  insert.run(
    task.id,
    'resource',
    'theme:theme-1',
    null,
    null,
    3,
    JSON.stringify({ assets: [{ hash: baselineThemeAsset }] }),
    '[]',
    now,
    null
  );
  first.close();
  const backup = join(dirname(path), 'restored.sqlite');
  writeFileSync(backup, readFileSync(path));

  for (const opened of [backup, path]) {
    const next = new Store(opened);
    try {
      expect(databaseSchemaVersion(next.db)).toBe(DATABASE_SCHEMA_VERSION);
      expect(
        next.db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'helper_changes%'").all()
      ).toEqual([]);
      expect(next.chat(chat.id).title).toBe('Existing chat');
      expect(next.source(sourceId).text).toBe(savedText);
      expect(new HelperWorkspace(next).conversation(conversation.id).id).toBe(conversation.id);
      expect(readHelperTaskResults(next, task.id)).toMatchObject({ taskId: task.id, results: [] });
      expect(next.db.prepare('SELECT hash FROM image_cleanup_candidates').all()).toEqual([
        { hash: baselineImage },
      ]);
      expect(
        next.db.prepare('SELECT hash FROM theme_assets WHERE hash=?').get(baselineThemeAsset)
      ).toBeUndefined();
    } finally {
      next.close();
    }
  }
});

test.each([DATABASE_SCHEMA_VERSION - 1, DATABASE_SCHEMA_VERSION + 1])(
  'unsupported schema %s is refused before changing source bytes',
  (version) => {
    const path = file(),
      db = new DatabaseSync(path);
    db.exec(
      `CREATE TABLE app_metadata(key TEXT PRIMARY KEY,value TEXT); INSERT INTO app_metadata VALUES('format','uimori-personal-v1'); CREATE TABLE retained(text TEXT); INSERT INTO retained VALUES('original'); PRAGMA user_version=${version}`
    );
    db.close();
    const before = readFileSync(path);
    expect(() => new Store(path)).toThrow(`DATABASE_VERSION_UNSUPPORTED:${version}`);
    expect(readFileSync(path)).toEqual(before);
  }
);
test('a different format using the current version is refused without writes', () => {
  const version = DATABASE_SCHEMA_VERSION;
  const path = file(),
    db = new DatabaseSync(path);
  db.exec(`CREATE TABLE unrelated(id TEXT); PRAGMA user_version=${version}`);
  db.close();
  const before = readFileSync(path);
  expect(() => new Store(path)).toThrow(`DATABASE_FORMAT_MISMATCH:${version}`);
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
