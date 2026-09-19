import { createFixtureChat } from './fixtures/chat.js';
import { afterEach, expect, test, vi } from 'vitest';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.js';
import { ProductStore } from '../server/product-store.js';
import { DATABASE_SCHEMA_VERSION } from '../server/database-schema.js';

const owned: { root: string; store?: Store; locks?: DatabaseSync[] }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const item of owned.splice(0).reverse()) {
    item.store?.close();
    for (const lock of item.locks ?? []) lock.close();
    const root = resolve(item.root),
      within = relative(resolve(tmpdir()), root);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(root).startsWith('uimori-schema-reset-')
    )
      throw new Error('Unsafe fixture cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture(local = true) {
  const root = mkdtempSync(join(tmpdir(), 'uimori-schema-reset-')),
    repo = join(root, 'repo'),
    directory = join(repo, '.local'),
    script = join(repo, 'scripts', 'reset-dev-data.mjs');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  if (local) mkdirSync(directory);
  copyFileSync(new URL('../scripts/reset-dev-data.mjs', import.meta.url), script);
  const owner: { root: string; store?: Store; locks?: DatabaseSync[] } = { root };
  owned.push(owner);
  return { root, repo, directory, script, owner, path: join(directory, 'uimori.sqlite') };
}
function reset(
  f: ReturnType<typeof fixture>,
  args: string[] = [],
  env: Record<string, string> = {}
) {
  const result = spawnSync(process.execPath, [f.script, ...args], {
    cwd: tmpdir(),
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  const line = [...result.stdout.split(/\r?\n/u), ...result.stderr.split(/\r?\n/u)].find((line) =>
    line.startsWith('{"status"')
  );
  return { ...result, body: line ? JSON.parse(line) : undefined };
}

test('BASE01 a fresh database creates the current schema and a current database reopens directly', () => {
  const f = fixture(),
    store = new Store(f.path);
  f.owner.store = store;
  expect(store.db.prepare('PRAGMA user_version').get()).toEqual({
    user_version: DATABASE_SCHEMA_VERSION,
  });
  expect(
    store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='resources'").get()
  ).toBeUndefined();
  expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  const chat = createFixtureChat(store, 'Current baseline');
  store.close();
  f.owner.store = undefined;
  const reopened = new Store(f.path);
  f.owner.store = reopened;
  expect(reopened.chat(chat.id).title).toBe('Current baseline');
  expect(readdirSync(f.directory).filter((name) => name.includes('.pre-'))).toEqual([]);
});

test('BASE02 nonempty unversioned databases are rejected without inferring an old schema', () => {
  const f = fixture(),
    db = new DatabaseSync(f.path);
  db.exec(
    "CREATE TABLE private_fixture(value TEXT); INSERT INTO private_fixture VALUES('untouched');"
  );
  db.close();
  expect(() => new Store(f.path)).toThrow('Unversioned database is not empty');
  const original = new DatabaseSync(f.path, { readOnly: true });
  try {
    expect(original.prepare('SELECT * FROM private_fixture').get()).toEqual({ value: 'untouched' });
    expect(original.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 });
  } finally {
    original.close();
  }
});

test('BASE03 fresh initialization rolls back as one transaction and releases its owner after a failure', () => {
  const f = fixture(),
    mock = vi.spyOn(ProductStore.prototype, 'initFresh').mockImplementationOnce(() => {
      throw new Error('synthetic initialization failure');
    });
  expect(() => new Store(f.path)).toThrow('DATABASE_INITIALIZATION_FAILED');
  mock.mockRestore();
  const db = new DatabaseSync(f.path, { readOnly: true });
  try {
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 });
    expect(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all()
    ).toEqual([]);
  } finally {
    db.close();
  }
  f.owner.store = new Store(f.path);
  expect(f.owner.store.db.prepare('PRAGMA user_version').get()).toEqual({
    user_version: DATABASE_SCHEMA_VERSION,
  });
});

test('BASE04 the current archive format remains independent from the database schema', () => {
  const source = fixture(),
    target = fixture();
  source.owner.store = new Store(source.path);
  target.owner.store = new Store(target.path);
  const chat = createFixtureChat(source.owner.store, 'Current archive');
  const archive = source.owner.store.product.export();
  const before = structuredClone(archive),
    empty = target.owner.store.product.export().tables;
  for (const version of [0, archive.version + 1]) {
    expect(() => target.owner.store!.product.import({ ...archive, version })).toThrow(
      'Unsupported archive'
    );
    expect(target.owner.store.product.export().tables).toEqual(empty);
    expect(archive).toEqual(before);
  }
  expect(target.owner.store.product.import(archive)).toMatchObject({ restored: true, chats: 1 });
  expect(target.owner.store.chat(chat.id).title).toBe('Current archive');
  expect(archive).toEqual(before);
});

test('RESET01 the CLI removes only the default development DB and its SQLite sidecars', () => {
  const f = fixture(),
    outside = join(f.root, 'other.sqlite');
  writeFileSync(outside, 'outside');
  const remove = [
    'uimori.sqlite',
    'uimori.sqlite-wal',
    'uimori.sqlite-shm',
    'uimori.sqlite-journal',
  ];
  const keep = [
    'other.sqlite',
    'uimori.sqlite.backup-explicit.sqlite',
    'uimori.sqlite.pre-copy.sqlite',
    'uimori.sqlite.pre-copy.sqlite-wal',
    'notes.txt',
  ];
  for (const name of [...remove, ...keep]) writeFileSync(join(f.directory, name), name);
  const result = reset(f, [], { UIMORI_DB: outside });
  expect(result.status, result.stderr).toBe(0);
  expect(result.body.status).toBe('reset');
  expect(result.body.removed.sort()).toEqual(remove.sort());
  expect(readFileSync(outside, 'utf8')).toBe('outside');
  for (const name of keep) expect(readFileSync(join(f.directory, name), 'utf8')).toBe(name);
  expect(existsSync(f.path + '.owner.sqlite')).toBe(true);
  expect(reset(f).body.status).toBe('empty');
});

test('RESET02 a running owner blocks reset before any development file is deleted', () => {
  const f = fixture();
  f.owner.store = new Store(f.path);
  const backup = 'uimori.sqlite.backup.sqlite';
  writeFileSync(join(f.directory, backup), 'copy');
  const result = reset(f);
  expect(result.status).toBe(1);
  expect(result.body).toMatchObject({ status: 'error', removed: [] });
  expect(result.body.error).toContain('DEV_DATABASE_OWNER_UNAVAILABLE');
  expect(existsSync(f.path)).toBe(true);
  expect(readFileSync(join(f.directory, backup), 'utf8')).toBe('copy');
});

test('RESET04 redirected .local directories are rejected before following their files', () => {
  const f = fixture(false),
    outside = join(f.root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'uimori.sqlite'), 'outside');
  symlinkSync(outside, f.directory, 'junction');
  const result = reset(f);
  expect(result.status).toBe(1);
  expect(result.body.error).toBe('DEV_RESET_UNSAFE_DIRECTORY');
  expect(readFileSync(join(outside, 'uimori.sqlite'), 'utf8')).toBe('outside');
});

test('RESET05 hard-linked database targets and path override arguments are refused', () => {
  const f = fixture(),
    outside = join(f.root, 'outside.sqlite');
  writeFileSync(outside, 'outside');
  linkSync(outside, f.path);
  const result = reset(f);
  expect(result.status).toBe(1);
  expect(result.body.error).toBe('DEV_RESET_UNSAFE_TARGET');
  expect(readFileSync(outside, 'utf8')).toBe('outside');
  const args = reset(f, ['--db', outside]);
  expect(args.status).toBe(1);
  expect(args.body.error).toContain('DEV_RESET_FIXED_TARGET_ONLY');
});

test('RESET06 an absent default directory is a no-op without creating a database', () => {
  const f = fixture(false),
    result = reset(f);
  expect(result.status, result.stderr).toBe(0);
  expect(result.body).toMatchObject({ status: 'empty', removed: [] });
  expect(existsSync(f.directory)).toBe(false);
});
