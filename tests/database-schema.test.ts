import { afterEach, expect, test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { createFixtureChat } from './fixtures/chat.js';
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
test('an existing database without the helper change record opens with its data and gains the table', () => {
  const path = file(),
    first = new Store(path);
  const chat = createFixtureChat(first, 'Existing chat');
  const conversation = new HelperWorkspace(first).open({ kind: 'chat', chatId: chat.id });
  first.db.exec('DROP TABLE helper_changes');
  first.close();
  const next = new Store(path);
  try {
    expect(databaseSchemaVersion(next.db)).toBe(DATABASE_SCHEMA_VERSION);
    expect(next.chat(chat.id).title).toBe('Existing chat');
    expect(new HelperWorkspace(next).conversation(conversation.id).id).toBe(conversation.id);
    expect(next.db.prepare('SELECT COUNT(*) AS n FROM helper_changes').get()).toEqual({ n: 0 });
  } finally {
    next.close();
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
