import { afterEach, expect, test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { databaseSchemaVersion, initializeDatabaseSchema } from '../server/database-schema.js';

const paths: string[] = [];
afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});
function file() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-schema-v1-'));
  paths.push(directory);
  return join(directory, 'app.sqlite');
}

test('personal schema 1 initializes and remains readable after an extra query index', () => {
  const path = file();
  const first = new Store(path);
  expect(databaseSchemaVersion(first.db)).toBe(1);
  first.db.exec('CREATE INDEX optional_user_index ON sources(created_at)');
  first.close();
  const next = new Store(path);
  expect(databaseSchemaVersion(next.db)).toBe(1);
  expect(
    next.db.prepare("SELECT name FROM sqlite_schema WHERE name='optional_user_index'").get()
  ).toBeTruthy();
  next.close();
});

test.each([2, 23, 24])('opening another schema %s leaves its bytes untouched', (version) => {
  const path = file(),
    db = new DatabaseSync(path);
  db.exec(
    `CREATE TABLE retained(text TEXT); INSERT INTO retained VALUES('original'); PRAGMA user_version=${version}`
  );
  db.close();
  const before = readFileSync(path);
  expect(() => new Store(path)).toThrow(/transfer user data/);
  expect(readFileSync(path)).toEqual(before);
});

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
