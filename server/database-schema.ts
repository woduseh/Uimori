import { initPushSchema } from './push-schema.js';
import { initReadingState } from './reading-state.js';
import { initManuscriptSearch } from './search-schema.js';
import type { DatabaseSync } from 'node:sqlite';
import { initDatabaseReadIndexes } from './database-performance.js';
import { initIllustrations } from './illustrations.js';
import { initOutline, initOutlineWorkspace } from './outline-store.js';
import { initLoreContextDefaults } from './lore-context-defaults.js';

export const DATABASE_SCHEMA_VERSION = 15;
const FORMAT = 'uimori-personal-v1';

export class DatabaseSchemaError extends Error {
  constructor(
    readonly code: string,
    readonly version: number
  ) {
    super(`${code}:${version}`);
    this.name = 'DatabaseSchemaError';
  }
}

/** Reject unsupported input before WAL or schema writes. */
export function databaseSchemaVersion(db: DatabaseSync): number {
  const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
  if (version === 0) {
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get())
      throw new Error('This is not an empty Uimori database. Choose a new DB path.');
    return 0;
  }
  if (version !== DATABASE_SCHEMA_VERSION)
    throw new DatabaseSchemaError('DATABASE_VERSION_UNSUPPORTED', version);
  const marker = db
    .prepare("SELECT 1 FROM sqlite_schema WHERE name='app_metadata' AND type='table'")
    .get();
  if (
    !marker ||
    db.prepare("SELECT value FROM app_metadata WHERE key='format'").get()?.value !== FORMAT
  )
    throw new DatabaseSchemaError('DATABASE_FORMAT_MISMATCH', version);
  return version;
}

/** Initialize an empty database; existing databases must already use the current format. */
export function initializeDatabaseSchema(db: DatabaseSync, initializeFresh: () => void): void {
  const previous = databaseSchemaVersion(db);
  if (previous === DATABASE_SCHEMA_VERSION) {
    initDatabaseReadIndexes(db);
    return;
  }
  try {
    db.exec('BEGIN IMMEDIATE');
    initializeFresh();
    initIllustrations(db);
    initOutline(db);
    initLoreContextDefaults(db);
    db.exec(`
        CREATE TABLE app_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE resource_undo(kind TEXT NOT NULL,id TEXT NOT NULL,saved_revision INTEGER NOT NULL,model TEXT NOT NULL,PRIMARY KEY(kind,id));
        CREATE TABLE image_blobs(hash TEXT PRIMARY KEY,mime TEXT NOT NULL,bytes BLOB NOT NULL);
        CREATE TABLE chat_lore_state(chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,body TEXT NOT NULL);
        CREATE TABLE import_operations(key TEXT PRIMARY KEY,digest TEXT NOT NULL,result TEXT NOT NULL);
        CREATE TABLE chat_variable_states(chat_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,values_json TEXT NOT NULL);
        CREATE TABLE chat_variable_journal(chat_id TEXT NOT NULL,request_key TEXT NOT NULL,payload_hash TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(chat_id,request_key));
        CREATE TABLE chat_variable_outputs(source_id TEXT PRIMARY KEY,body TEXT NOT NULL);
        CREATE TABLE maintenance(id INTEGER PRIMARY KEY CHECK(id=1),epoch INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('open','closed')),reason TEXT,updated_at TEXT NOT NULL);
        CREATE TABLE image_cleanup_candidates(hash TEXT PRIMARY KEY);
        CREATE TABLE anthropic_batches(attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),run_id TEXT NOT NULL REFERENCES runs(id),ordinal INTEGER NOT NULL,batch_id TEXT UNIQUE,custom_id TEXT NOT NULL,request_sha256 TEXT NOT NULL,status TEXT NOT NULL,result TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(run_id,ordinal));
        CREATE INDEX anthropic_batches_run ON anthropic_batches(run_id,ordinal);
      `);
    db.prepare('INSERT INTO app_metadata VALUES(?,?)').run('format', FORMAT);
    db.prepare('INSERT INTO app_metadata VALUES(?,?)').run(
      'usage-coverage-since',
      new Date().toISOString()
    );
    initManuscriptSearch(db);
    initReadingState(db);
    initPushSchema(db);
    initOutlineWorkspace(db);
    initDatabaseReadIndexes(db);
    db.exec(`PRAGMA user_version=${DATABASE_SCHEMA_VERSION}; COMMIT`);
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
