import type { DatabaseSync } from 'node:sqlite';
import { initDatabaseReadIndexes } from './database-performance.js';
import { initIllustrations } from './illustrations.js';
import { initOutline } from './outline-store.js';
import { initLoreContextDefaults } from './lore-context-defaults.js';

export const DATABASE_SCHEMA_VERSION = 1;
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

/** A format marker and forward version, not a fingerprint of every index and DDL statement. */
export function databaseSchemaVersion(db: DatabaseSync): number {
  const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
  if (version === 0) {
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get())
      throw new Error('This is not an empty Uimori database. Choose a new DB path.');
    return 0;
  }
  if (version !== DATABASE_SCHEMA_VERSION)
    throw new Error(
      `Database version ${version} is not the personal-v1 format. Keep the original file and transfer user data to a new database.`
    );
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

/** A new baseline; future migrations run once in order rather than supporting old shapes at runtime. */
export function initializeDatabaseSchema(db: DatabaseSync, initializeFresh: () => void): void {
  if (databaseSchemaVersion(db) === DATABASE_SCHEMA_VERSION) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    initializeFresh();
    initIllustrations(db);
    initOutline(db);
    initLoreContextDefaults(db);
    db.exec(`
      CREATE TABLE app_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE resource_undo(kind TEXT NOT NULL,id TEXT NOT NULL,saved_revision INTEGER NOT NULL,model TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE image_blobs(hash TEXT PRIMARY KEY,mime TEXT NOT NULL,bytes BLOB NOT NULL);
      CREATE TABLE chat_lore_state(chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,body TEXT NOT NULL,PRIMARY KEY(chat_id,branch_id));
      CREATE TABLE import_operations(key TEXT PRIMARY KEY,digest TEXT NOT NULL,result TEXT NOT NULL);
      CREATE TABLE chat_variable_states(chat_id TEXT NOT NULL,branch_id TEXT NOT NULL,revision INTEGER NOT NULL,values_json TEXT NOT NULL,PRIMARY KEY(chat_id,branch_id));
      CREATE TABLE chat_variable_journal(chat_id TEXT NOT NULL,branch_id TEXT NOT NULL,request_key TEXT NOT NULL,payload_hash TEXT NOT NULL,payload TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(chat_id,branch_id,request_key));
      CREATE TABLE chat_variable_outputs(source_id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE maintenance(id INTEGER PRIMARY KEY CHECK(id=1),epoch INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('open','closed')),reason TEXT,updated_at TEXT NOT NULL);
    `);
    initDatabaseReadIndexes(db);
    db.prepare('INSERT INTO app_metadata VALUES(?,?)').run('format', FORMAT);
    db.exec(`PRAGMA user_version=${DATABASE_SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
