import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotDatabase, initSnapshotStorage } from '../dist/server/snapshot-database.js';
import { snapshotStorageTriggers } from '../dist/server/snapshot-storage-schema.js';
import { databaseSchemaSignature } from '../dist/server/database-signature.js';
import { DATABASE_SCHEMA_VERSION } from '../dist/server/database-schema.js';
import {
  initDatabaseReadIndexes,
  inspectDatabasePerformance,
} from '../dist/server/database-performance.js';
import { optimizeDatabaseFile } from './optimize-database.mjs';

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture(optimized = false, wal = false) {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-perf-cli-'));
  directories.push(directory);
  const path = join(directory, 'synthetic.sqlite');
  const db = new SnapshotDatabase(path);
  if (wal) db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
  db.exec('PRAGMA foreign_keys=ON');
  for (const table of [
    'runs',
    'context_checkpoints',
    'context_jobs',
    'helper_tasks',
    'helper_artifact_jobs',
    'helper_artifacts',
  ])
    db.exec(`CREATE TABLE ${table}(id TEXT,revision INTEGER,snapshot TEXT NOT NULL)`);
  db.exec(`CREATE TABLE model_inputs(seq INTEGER PRIMARY KEY,run_id TEXT,input TEXT);
    CREATE TABLE tool_events(seq INTEGER PRIMARY KEY,run_id TEXT,event TEXT);
    CREATE TABLE sources(id TEXT PRIMARY KEY,chat_id TEXT);
    CREATE TABLE attempts(id TEXT PRIMARY KEY,chat_id TEXT,run_id TEXT,job_id TEXT,role TEXT);
    CREATE TABLE schema_metadata(id INTEGER PRIMARY KEY CHECK(id=1),baseline TEXT NOT NULL,signature TEXT NOT NULL);
    INSERT INTO schema_metadata VALUES(1,'uimori-risu-native','');
    PRAGMA user_version=${DATABASE_SCHEMA_VERSION};`);
  initSnapshotStorage(db);
  if (optimized) initDatabaseReadIndexes(db);
  else {
    for (const trigger of snapshotStorageTriggers()) db.exec(`DROP TRIGGER ${trigger.name}`);
    for (const trigger of snapshotStorageTriggers(true)) db.exec(trigger.sql);
  }
  db.prepare('INSERT INTO runs VALUES(?,1,snapshot_pack(?))').run(
    'run',
    JSON.stringify({ text: 'WAL 보존 🌿 '.repeat(500) })
  );
  db.prepare('UPDATE schema_metadata SET signature=?').run(databaseSchemaSignature(db));
  const raw = db.prepare('SELECT snapshot AS raw FROM runs').get().raw;
  if (!wal) db.close();
  return { directory, path, raw, db: wal ? db : null };
}
function inspect(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      ...inspectDatabasePerformance(db, DATABASE_SCHEMA_VERSION),
      raw: db.prepare('SELECT snapshot AS raw FROM runs').get().raw,
    };
  } finally {
    db.close();
  }
}

test('default check is read-only and creates neither a lock nor a backup', async () => {
  const state = fixture();
  const bytes = readFileSync(state.path),
    files = readdirSync(state.directory);
  const result = await optimizeDatabaseFile(state.path);
  assert.equal(result.changed, false);
  assert.equal(result.backup, null);
  assert.equal(result.snapshotCleanup, 'legacy');
  assert.deepEqual(readFileSync(state.path), bytes);
  assert.deepEqual(readdirSync(state.directory), files);
});

test('apply makes a verified old-schema backup before atomically installing the optimization', async () => {
  const state = fixture();
  const result = await optimizeDatabaseFile(state.path, { apply: true });
  assert.equal(result.changed, true);
  assert.equal(result.optimized, true);
  assert.ok(existsSync(result.backup));
  assert.equal(inspect(result.backup).snapshotCleanup, 'legacy');
  assert.equal(inspect(result.backup).raw, state.raw);
  assert.equal(inspect(state.path).optimized, true);
  assert.equal(inspect(state.path).raw, state.raw);
});

test('a live server ownership lease blocks optimization before creating a backup', async () => {
  const state = fixture();
  const lease = new DatabaseSync(`${state.path}.owner.sqlite`);
  lease.exec('BEGIN EXCLUSIVE');
  const bytes = readFileSync(state.path),
    files = readdirSync(state.directory);
  try {
    await assert.rejects(optimizeDatabaseFile(state.path, { apply: true }), /locked/u);
    assert.deepEqual(readFileSync(state.path), bytes);
    assert.deepEqual(readdirSync(state.directory), files);
  } finally {
    lease.close();
  }
});

test('repeated apply is a no-op and does not create extra backups', async () => {
  const state = fixture();
  await optimizeDatabaseFile(state.path, { apply: true });
  const bytes = readFileSync(state.path),
    files = readdirSync(state.directory);
  const result = await optimizeDatabaseFile(state.path, { apply: true });
  assert.equal(result.changed, false);
  assert.equal(result.backup, null);
  assert.deepEqual(readFileSync(state.path), bytes);
  assert.deepEqual(readdirSync(state.directory), files);
});

test('an invalid schema is left unchanged and is not copied into a misleading successful backup', async () => {
  const state = fixture();
  const db = new DatabaseSync(state.path);
  db.exec("UPDATE schema_metadata SET signature='bad'");
  db.close();
  const bytes = readFileSync(state.path);
  await assert.rejects(optimizeDatabaseFile(state.path, { apply: true }), /SCHEMA_SIGNATURE/u);
  assert.deepEqual(readFileSync(state.path), bytes);
  assert.equal(
    readdirSync(state.directory).filter((name) => name.startsWith('uimori-performance-backup-'))
      .length,
    0
  );
});

test('nonexistent paths are never turned into new user databases', async () => {
  const state = fixture();
  const path = join(state.directory, 'missing.sqlite');
  await assert.rejects(optimizeDatabaseFile(path, { apply: true }), /ENOENT/u);
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(`${path}.owner.sqlite`), false);
});

test('SQLite backup includes committed WAL data instead of copying only the main file', async () => {
  const state = fixture(false, true);
  try {
    assert.ok(existsSync(`${state.path}-wal`));
    const result = await optimizeDatabaseFile(state.path, { apply: true });
    assert.equal(inspect(result.backup).raw, state.raw);
    assert.equal(inspect(result.backup).snapshotCleanup, 'legacy');
    assert.equal(inspect(state.path).raw, state.raw);
  } finally {
    state.db.close();
  }
});
