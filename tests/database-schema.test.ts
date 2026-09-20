import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.js';
import {
  DATABASE_SCHEMA_VERSION,
  DatabaseSchemaError,
  initializeDatabaseSchema,
} from '../server/database-schema.js';

const owned: { directory: string; databases: (DatabaseSync | Store)[] }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const item of owned.splice(0).reverse()) {
    for (const database of item.databases.reverse()) {
      try {
        database.close();
      } catch {
        // Individual tests close their owned database before reopening it.
      }
    }
    const directory = resolve(item.directory);
    const within = relative(resolve(tmpdir()), directory);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(directory).startsWith('uimori-schema-')
    )
      throw new Error('Unsafe schema fixture cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-schema-'));
  const item = { directory, databases: [] as (DatabaseSync | Store)[] };
  owned.push(item);
  const path = join(directory, 'synthetic.sqlite');
  return {
    path,
    raw: () => {
      const database = new DatabaseSync(path);
      item.databases.push(database);
      return database;
    },
    open: () => {
      const store = new Store(path);
      item.databases.push(store);
      return store;
    },
  };
}

test.each([1, 14, 15, 16, 17, 18, 19, 20, 21, 22, DATABASE_SCHEMA_VERSION + 1])(
  'unsupported schema %i is rejected before modifying any database bytes',
  (version) => {
    const f = fixture();
    const raw = f.raw();
    raw.exec(
      `CREATE TABLE private_fixture(value TEXT); INSERT INTO private_fixture VALUES('unchanged'); PRAGMA user_version=${version}`
    );
    raw.close();
    const before = readFileSync(f.path);
    expect(() => f.open()).toThrow(`Unsupported database schema version ${version}`);
    expect(readFileSync(f.path)).toEqual(before);
    // A rejected open also releases the ownership lock.
    expect(() => f.open()).toThrow(`Unsupported database schema version ${version}`);
  }
);

test('current schema metadata, tables and indices must remain intact on reopen', () => {
  const f = fixture();
  const store = f.open();
  expect(store.db.prepare('PRAGMA user_version').get()).toEqual({
    user_version: DATABASE_SCHEMA_VERSION,
  });
  expect(
    store.db.prepare("SELECT name FROM sqlite_schema WHERE name='schema_migrations'").get()
  ).toBeUndefined();
  const before = store.db.prepare('SELECT * FROM schema_metadata').all();
  store.close();
  const reopened = f.open();
  expect(reopened.db.prepare('SELECT * FROM schema_metadata').all()).toEqual(before);
  expect(reopened.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  reopened.close();
  const raw = f.raw();
  raw.exec('DROP INDEX one_active_run_per_branch');
  raw.close();
  const bytes = readFileSync(f.path);
  expect(() => f.open()).toThrow('DATABASE_SCHEMA_MISMATCH');
  expect(readFileSync(f.path)).toEqual(bytes);
});

test.each([
  'DROP TABLE schema_metadata',
  'DELETE FROM schema_metadata',
  "UPDATE schema_metadata SET baseline='unknown'",
  "UPDATE schema_metadata SET signature='invalid'",
  'DROP TABLE maintenance',
])('current schema refuses structural corruption without repairing it: %s', (sql) => {
  const f = fixture();
  const store = f.open();
  store.db.exec(sql);
  store.close();
  const bytes = readFileSync(f.path);
  expect(() => f.open()).toThrow(DatabaseSchemaError);
  expect(readFileSync(f.path)).toEqual(bytes);
});

test('failed fresh initialization rolls back its DDL, version and metadata', () => {
  const f = fixture();
  const raw = f.raw();
  expect(() =>
    initializeDatabaseSchema(raw, () => {
      raw.exec('CREATE TABLE partial_fixture(value TEXT)');
      throw new Error('synthetic failure');
    })
  ).toThrow('DATABASE_INITIALIZATION_FAILED');
  expect(raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 });
  expect(
    raw.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all()
  ).toEqual([]);
  raw.close();
  expect(f.open().db.prepare('PRAGMA user_version').get()).toEqual({
    user_version: DATABASE_SCHEMA_VERSION,
  });
});
