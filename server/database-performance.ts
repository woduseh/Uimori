import type { DatabaseSync } from 'node:sqlite';
import { databaseSchemaSignature } from './database-signature.js';
import { snapshotStorageTriggers } from './snapshot-storage-schema.js';

const indexes = [
  ['model_inputs_run_seq', 'model_inputs(run_id,seq)'],
  ['tool_events_run_seq', 'tool_events(run_id,seq)'],
  ['sources_chat', 'sources(chat_id)'],
  ['attempts_run', 'attempts(run_id)'],
  ['attempts_chat_run', 'attempts(chat_id,run_id)'],
] as const;
const definitions = indexes.map(([name, columns]) => ({
  name,
  sql: `CREATE INDEX ${name} ON ${columns}`,
}));
const normalize = (sql: string) => sql.trim().replace(/;$/u, '').replace(/\s+/gu, ' ');
const fail = (reason: string): never => {
  throw new Error(`DATABASE_PERFORMANCE_${reason}`);
};

/** Fresh DB only. Existing signed schemas are never silently changed by opening the application. */
export function initDatabaseReadIndexes(db: DatabaseSync): void {
  for (const index of definitions) db.exec(index.sql);
}

/** Validate the caller-selected signed schema and only the known old/new optimization definitions. */
export function inspectDatabasePerformance(db: DatabaseSync, expectedSchemaVersion: number) {
  if (db.prepare('PRAGMA user_version').get()?.user_version !== expectedSchemaVersion)
    fail('SCHEMA_VERSION');
  const metadata = db
    .prepare("SELECT type,sql FROM sqlite_schema WHERE name='schema_metadata'")
    .get();
  if (
    metadata?.type !== 'table' ||
    metadata.sql !==
      'CREATE TABLE schema_metadata(id INTEGER PRIMARY KEY CHECK(id=1),baseline TEXT NOT NULL,signature TEXT NOT NULL)'
  )
    fail('SCHEMA_METADATA');
  const rows = db.prepare('SELECT id,baseline,signature FROM schema_metadata').all();
  if (
    rows.length !== 1 ||
    rows[0].id !== 1 ||
    rows[0].baseline !== 'uimori-risu-native' ||
    rows[0].signature !== databaseSchemaSignature(db)
  )
    fail('SCHEMA_SIGNATURE');
  const schema = new Map(
    db
      .prepare('SELECT name,type,sql FROM sqlite_schema')
      .all()
      .map((row) => [row.name, row])
  );
  const matches = (kind: string, definition: { name: string; sql: string }) => {
    const row = schema.get(definition.name);
    return (
      row?.type === kind &&
      typeof row.sql === 'string' &&
      normalize(row.sql) === normalize(definition.sql)
    );
  };
  const current = snapshotStorageTriggers();
  const legacy = snapshotStorageTriggers(true);
  const targeted = current.every((trigger) => matches('trigger', trigger));
  const old =
    !schema.has('snapshot_text_ref_delete') &&
    legacy.every((trigger) => matches('trigger', trigger));
  if (!targeted && !old) fail('UNKNOWN_SNAPSHOT_TRIGGERS');
  const missingIndexes: string[] = [];
  for (const index of definitions) {
    if (!schema.has(index.name)) missingIndexes.push(index.name);
    else if (!matches('index', index)) fail('INDEX_CONFLICT');
  }
  return {
    optimized: targeted && missingIndexes.length === 0,
    snapshotCleanup: targeted ? ('targeted' as const) : ('legacy' as const),
    missingIndexes,
  };
}

/** Caller owns the server's offline file lease and has made a successful SQLite backup. */
export function optimizeDatabasePerformance(
  db: DatabaseSync,
  expectedSchemaVersion: number
): { changed: boolean } {
  if (db.isTransaction) fail('TRANSACTION_ACTIVE');
  if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) fail('FOREIGN_KEYS_DISABLED');
  // Check inside the write transaction as well; callers cannot accidentally apply an old plan.
  db.exec('BEGIN IMMEDIATE');
  try {
    const before = inspectDatabasePerformance(db, expectedSchemaVersion);
    if (before.optimized) {
      db.exec('COMMIT');
      return { changed: false };
    }
    if (db.prepare('PRAGMA foreign_key_check').all().length) fail('FOREIGN_KEY_CHECK');
    if (before.snapshotCleanup === 'legacy') {
      for (const trigger of snapshotStorageTriggers(true)) db.exec(`DROP TRIGGER ${trigger.name}`);
      for (const trigger of snapshotStorageTriggers()) db.exec(trigger.sql);
    }
    for (const index of definitions)
      if (before.missingIndexes.includes(index.name)) db.exec(index.sql);
    // Intentionally do not sweep or rewrite stored data during installation. Normal changed
    // references are collected by the new trigger; existing expanded/packed rows remain exact.
    if (db.prepare('PRAGMA foreign_key_check').all().length) fail('FOREIGN_KEY_CHECK');
    db.prepare('UPDATE schema_metadata SET signature=? WHERE id=1').run(
      databaseSchemaSignature(db)
    );
    if (!inspectDatabasePerformance(db, expectedSchemaVersion).optimized)
      fail('INSTALLATION_INCOMPLETE');
    db.exec('COMMIT');
    return { changed: true };
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
