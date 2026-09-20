import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { SnapshotDatabase, initSnapshotStorage } from '../server/snapshot-database.js';
import { databaseSchemaSignature } from '../server/database-signature.js';
import {
  initDatabaseReadIndexes,
  inspectDatabasePerformance,
  optimizeDatabasePerformance,
} from '../server/database-performance.js';
import { initLegacySnapshotStorage } from './fixtures/legacy-snapshot-storage.js';

const databases = new Set<SnapshotDatabase>();
const schemaVersion = 22;
afterEach(() => {
  for (const db of databases) db.close();
  databases.clear();
});
const tables = [
  'runs',
  'context_checkpoints',
  'context_jobs',
  'helper_tasks',
  'helper_artifact_jobs',
  'helper_artifacts',
];
const content = '동일한 본문 日本語 🌿 "quote" \\path\r\n'.repeat(300);
function sign(db: SnapshotDatabase) {
  db.prepare('UPDATE schema_metadata SET signature=? WHERE id=1').run(databaseSchemaSignature(db));
}
function fixture(legacy = true) {
  const db = new SnapshotDatabase(':memory:');
  databases.add(db);
  db.exec('PRAGMA foreign_keys=ON');
  for (const table of tables)
    db.exec(
      `CREATE TABLE ${table}(id TEXT,revision INTEGER,snapshot TEXT NOT NULL,UNIQUE(id,revision))`
    );
  db.exec(`
    CREATE TABLE model_inputs(seq INTEGER PRIMARY KEY,run_id TEXT,input TEXT);
    CREATE TABLE tool_events(seq INTEGER PRIMARY KEY,run_id TEXT,event TEXT);
    CREATE TABLE sources(id TEXT PRIMARY KEY,chat_id TEXT);
    CREATE TABLE attempts(id TEXT PRIMARY KEY,chat_id TEXT,run_id TEXT,job_id TEXT,role TEXT);
    CREATE TABLE schema_metadata(id INTEGER PRIMARY KEY CHECK(id=1),baseline TEXT NOT NULL,signature TEXT NOT NULL);
    INSERT INTO schema_metadata VALUES(1,'uimori-risu-native','');
    PRAGMA user_version=22;
  `);
  if (legacy) initLegacySnapshotStorage(db);
  else {
    initSnapshotStorage(db);
    initDatabaseReadIndexes(db);
  }
  sign(db);
  return db;
}
function write(db: SnapshotDatabase, id: string, value: unknown, packed = true) {
  db.prepare(`INSERT INTO runs VALUES(?,1,${packed ? 'snapshot_pack(?)' : '?'})`).run(
    id,
    JSON.stringify(value)
  );
}
function rawData(db: SnapshotDatabase) {
  return JSON.stringify({
    snapshots: tables.map((table) =>
      db.prepare(`SELECT id,revision,snapshot AS raw FROM ${table} ORDER BY id,revision`).all()
    ),
    texts: db.prepare('SELECT * FROM snapshot_texts ORDER BY hash').all(),
    refs: db.prepare('SELECT * FROM snapshot_text_refs ORDER BY owner_table,owner_id,hash').all(),
  });
}
function structure(db: SnapshotDatabase) {
  return JSON.stringify({
    schema: db
      .prepare("SELECT * FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
      .all(),
    metadata: db.prepare('SELECT * FROM schema_metadata').all(),
    version: db.prepare('PRAGMA user_version').get(),
  });
}
function read(db: SnapshotDatabase, id: string) {
  return JSON.parse(String(db.prepare('SELECT snapshot FROM runs WHERE id=?').get(id)?.snapshot));
}

test('legacy signed schema is reported without rewriting any schema or data', () => {
  const db = fixture();
  write(db, 'one', { text: content });
  const before = [structure(db), rawData(db)];
  assert.deepEqual(inspectDatabasePerformance(db, schemaVersion), {
    optimized: false,
    snapshotCleanup: 'legacy',
    missingIndexes: [
      'model_inputs_run_seq',
      'tool_events_run_seq',
      'sources_chat',
      'attempts_run',
      'attempts_chat_run',
    ],
  });
  assert.deepEqual([structure(db), rawData(db)], before);
});

test('explicit installation preserves packed rows, text, references, version and portable values', () => {
  const db = fixture();
  const value = { history: [{ text: content }], other: content, short: '보존' };
  write(db, 'one', value);
  db.exec(
    "INSERT INTO helper_artifacts SELECT 'artifact',1,snapshot FROM runs; INSERT INTO helper_artifacts SELECT 'artifact',2,snapshot FROM runs"
  );
  const before = rawData(db),
    oldSignature = databaseSchemaSignature(db);
  assert.deepEqual(optimizeDatabasePerformance(db, schemaVersion), { changed: true });
  assert.equal(rawData(db), before);
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 22);
  assert.notEqual(databaseSchemaSignature(db), oldSignature);
  assert.equal(
    db.prepare('SELECT signature FROM schema_metadata').get()?.signature,
    databaseSchemaSignature(db)
  );
  assert.deepEqual(read(db, 'one'), value);
  assert.equal(inspectDatabasePerformance(db, schemaVersion).optimized, true);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('an already optimized fresh database is an idempotent no-op', () => {
  const db = fixture(false);
  write(db, 'one', { text: content });
  const before = [structure(db), rawData(db), db.prepare('PRAGMA schema_version').get()];
  assert.deepEqual(optimizeDatabasePerformance(db, schemaVersion), { changed: false });
  assert.deepEqual([structure(db), rawData(db), db.prepare('PRAGMA schema_version').get()], before);
});

test('updates retain shared references instead of deleting and reinserting them', () => {
  const db = fixture(false);
  write(db, 'one', { a: content, b: content + 'old' });
  write(db, 'other', { a: content });
  const retained = db
    .prepare(
      "SELECT rowid,hash FROM snapshot_text_refs WHERE owner_table='runs' AND owner_id='one' ORDER BY rowid"
    )
    .all();
  const deleted: string[] = [];
  db.function('record_deleted_reference', (hash) => {
    deleted.push(String(hash));
    return 0;
  });
  db.exec(
    'CREATE TRIGGER test_deleted_reference AFTER DELETE ON snapshot_text_refs BEGIN SELECT record_deleted_reference(OLD.hash); END'
  );
  db.prepare('UPDATE runs SET snapshot=snapshot_pack(?) WHERE id=?').run(
    JSON.stringify({ a: content, c: content + 'new' }),
    'one'
  );
  assert.equal(deleted.length, 1);
  const current = db
    .prepare(
      "SELECT rowid,hash FROM snapshot_text_refs WHERE owner_table='runs' AND owner_id='one' ORDER BY rowid"
    )
    .all();
  const common = retained.find((item) => !deleted.includes(String(item.hash)))!;
  assert.ok(current.some((item) => item.hash === common.hash && item.rowid === common.rowid));
  assert.equal(db.prepare('SELECT count(*) AS n FROM snapshot_texts').get()?.n, 2);
  assert.deepEqual(read(db, 'other'), { a: content });
});

test('expanded JSON updates also collect old bodies through the nested packing trigger', () => {
  const db = fixture(false);
  write(db, 'one', { a: content, b: content + 'old' });
  db.prepare('UPDATE runs SET snapshot=? WHERE id=?').run(
    JSON.stringify({ a: content, b: content + 'new' }),
    'one'
  );
  assert.equal(db.prepare('SELECT count(*) AS n FROM snapshot_texts').get()?.n, 2);
  assert.deepEqual(read(db, 'one'), { a: content, b: content + 'new' });
  db.prepare('UPDATE runs SET snapshot=?').run(JSON.stringify({ a: 'short' }));
  assert.equal(db.prepare('SELECT count(*) AS n FROM snapshot_texts').get()?.n, 0);
});

test('all snapshot owner tables keep composite revisions and shared copies until the final reference', () => {
  const db = fixture(false);
  for (const table of tables)
    db.prepare(`INSERT INTO ${table} VALUES('same',1,?)`).run(JSON.stringify({ text: content }));
  db.exec("INSERT INTO helper_artifacts SELECT 'same',2,snapshot FROM runs");
  for (const table of tables) db.exec(`DELETE FROM ${table} WHERE revision=1`);
  assert.equal(db.prepare('SELECT count(*) AS n FROM snapshot_texts').get()?.n, 1);
  assert.equal(
    JSON.parse(String(db.prepare('SELECT snapshot FROM helper_artifacts').get()?.snapshot)).text,
    content
  );
  db.exec('DELETE FROM helper_artifacts');
  assert.equal(db.prepare('SELECT count(*) AS n FROM snapshot_texts').get()?.n, 0);
});

test('targeted collection does not sweep unrelated stored bodies', () => {
  const db = fixture(false);
  write(db, 'one', { text: content });
  // A deliberately unreferenced sentinel distinguishes targeted collection from a global sweep.
  db.prepare('INSERT INTO snapshot_texts VALUES(?,?)').run('unrelated-sentinel', '"untouched"');
  db.exec('DELETE FROM runs');
  assert.deepEqual(
    db
      .prepare('SELECT hash,body FROM snapshot_texts')
      .all()
      .map((row) => ({ ...row })),
    [{ hash: 'unrelated-sentinel', body: '"untouched"' }]
  );
});

test('snapshot replacement and reference cleanup roll back together', () => {
  const db = fixture(false);
  write(db, 'one', { text: content });
  const before = rawData(db);
  db.exec('BEGIN');
  db.prepare('UPDATE runs SET snapshot=snapshot_pack(?)').run(
    JSON.stringify({ text: content + 'changed' })
  );
  db.exec('ROLLBACK');
  assert.equal(rawData(db), before);
  assert.deepEqual(read(db, 'one'), { text: content });
});

test('failed outer insertion cannot leave newly packed text or references behind', () => {
  const db = fixture(false);
  write(db, 'one', { text: content });
  const before = rawData(db);
  assert.throws(() => write(db, 'one', { text: content + 'different' }));
  assert.equal(rawData(db), before);
});

test('installation rolls back schema, metadata and data when later DDL fails', () => {
  const db = fixture();
  write(db, 'one', { text: content });
  const before = [structure(db), rawData(db)];
  const original = db.exec.bind(db);
  db.exec = (sql: string) => {
    if (sql.startsWith('CREATE INDEX tool_events_run_seq')) throw new Error('injected DDL failure');
    return original(sql);
  };
  try {
    assert.throws(() => optimizeDatabasePerformance(db, schemaVersion), /injected DDL failure/u);
  } finally {
    db.exec = original;
  }
  assert.equal(db.isTransaction, false);
  assert.deepEqual([structure(db), rawData(db)], before);
  assert.equal(inspectDatabasePerformance(db, schemaVersion).snapshotCleanup, 'legacy');
});

test('modified signatures, unknown triggers and conflicting indexes are never silently repaired', () => {
  for (const mode of ['signature', 'trigger', 'index']) {
    const db = fixture();
    if (mode === 'signature') db.exec("UPDATE schema_metadata SET signature='invalid'");
    if (mode === 'trigger') {
      db.exec(
        'DROP TRIGGER runs_snapshot_delete; CREATE TRIGGER runs_snapshot_delete AFTER DELETE ON runs BEGIN SELECT 1; END'
      );
      sign(db);
    }
    if (mode === 'index') {
      db.exec('CREATE INDEX attempts_run ON attempts(chat_id)');
      sign(db);
    }
    const before = [structure(db), rawData(db)];
    assert.throws(() => optimizeDatabasePerformance(db, schemaVersion), /DATABASE_PERFORMANCE_/u);
    assert.deepEqual([structure(db), rawData(db)], before);
  }
});

test('older, unversioned and future schemas remain rejected without writes', () => {
  for (const version of [0, 21, 23]) {
    const db = fixture();
    db.exec(`PRAGMA user_version=${version}`);
    const before = [structure(db), rawData(db)];
    assert.throws(() => optimizeDatabasePerformance(db, schemaVersion), /SCHEMA_VERSION/u);
    assert.deepEqual([structure(db), rawData(db)], before);
  }
});

test('missing metadata and foreign-key corruption are rejected before installing changes', () => {
  const missing = fixture();
  missing.exec('DELETE FROM schema_metadata');
  assert.throws(() => optimizeDatabasePerformance(missing, schemaVersion), /SCHEMA_SIGNATURE/u);
  const db = fixture();
  write(db, 'one', { text: content });
  db.exec('PRAGMA foreign_keys=OFF; DELETE FROM snapshot_texts; PRAGMA foreign_keys=ON');
  const before = [structure(db), rawData(db)];
  assert.throws(() => optimizeDatabasePerformance(db, schemaVersion), /FOREIGN_KEY_CHECK/u);
  assert.deepEqual([structure(db), rawData(db)], before);
});

test('the installer refuses disabled foreign keys and never rolls back a caller-owned transaction', () => {
  const db = fixture();
  db.exec('PRAGMA foreign_keys=OFF');
  assert.throws(() => optimizeDatabasePerformance(db, schemaVersion), /FOREIGN_KEYS_DISABLED/u);
  db.exec('PRAGMA foreign_keys=ON; BEGIN');
  assert.throws(() => optimizeDatabasePerformance(db, schemaVersion), /TRANSACTION_ACTIVE/u);
  assert.equal(db.isTransaction, true);
  db.exec('ROLLBACK');
});

test('targeted body deletion and frequent lookup plans use their matching indexes', () => {
  const db = fixture(false);
  const queries = [
    ["SELECT input FROM model_inputs WHERE run_id='x' ORDER BY seq", 'model_inputs_run_seq'],
    ["SELECT event FROM tool_events WHERE run_id='x' ORDER BY seq", 'tool_events_run_seq'],
    ["SELECT id FROM sources WHERE chat_id='x'", 'sources_chat'],
    [
      "SELECT count(*) FROM attempts WHERE run_id='x' AND job_id IS NULL AND role!='title'",
      'attempts_run',
    ],
    ["SELECT count(*) FROM attempts WHERE chat_id='x' AND run_id='r'", 'attempts_chat_run'],
  ];
  for (const [sql, index] of queries) {
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all()
      .map((row) => String(row.detail))
      .join('\n');
    assert.match(plan, new RegExp(index, 'u'));
    assert.doesNotMatch(plan, /SCAN (?:model_inputs|tool_events|sources|attempts)/u);
  }
  const plan = db
    .prepare(
      'EXPLAIN QUERY PLAN DELETE FROM snapshot_texts WHERE hash=? AND NOT EXISTS(SELECT 1 FROM snapshot_text_refs WHERE hash=?)'
    )
    .all('x', 'x')
    .map((row) => String(row.detail))
    .join('\n');
  assert.doesNotMatch(plan, /SCAN snapshot_texts/u);
  assert.match(plan, /snapshot_text_refs_hash/u);
});
