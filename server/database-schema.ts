import { databaseSchemaSignature } from './database-signature.js';
import { initDatabaseReadIndexes } from './database-performance.js';
import type { DatabaseSync } from 'node:sqlite';
import { initIllustrations } from './illustrations.js';
import { initOutline } from './outline-store.js';
import { initLoreContextDefaults } from './lore-context-defaults.js';

export const DATABASE_SCHEMA_VERSION = 23;
const BASELINE = 'uimori-risu-native';
const METADATA_SCHEMA =
  'CREATE TABLE schema_metadata(id INTEGER PRIMARY KEY CHECK(id=1),baseline TEXT NOT NULL,signature TEXT NOT NULL)';

export class DatabaseSchemaError extends Error {
  constructor(
    readonly code: string,
    readonly version: number
  ) {
    super(`${code}:${version}`);
    this.name = 'DatabaseSchemaError';
  }
}

function assertCurrentSchema(db: DatabaseSync): void {
  const metadata = db
    .prepare("SELECT type,sql FROM sqlite_schema WHERE name='schema_metadata'")
    .get();
  if (metadata?.type !== 'table' || metadata.sql !== METADATA_SCHEMA)
    throw new DatabaseSchemaError('DATABASE_SCHEMA_MISMATCH', DATABASE_SCHEMA_VERSION);
  const rows = db.prepare('SELECT id,baseline,signature FROM schema_metadata').all();
  if (
    rows.length !== 1 ||
    rows[0].id !== 1 ||
    rows[0].baseline !== BASELINE ||
    rows[0].signature !== databaseSchemaSignature(db)
  )
    throw new DatabaseSchemaError('DATABASE_SCHEMA_MISMATCH', DATABASE_SCHEMA_VERSION);
}

/** Read-only admission happens before journal changes, DDL, or default insertion. */
export function databaseSchemaVersion(db: DatabaseSync): number {
  const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
  if (version !== 0 && version !== DATABASE_SCHEMA_VERSION)
    throw new Error(
      `Unsupported database schema version ${version}; Uimori opens only schema ${DATABASE_SCHEMA_VERSION}. Use a new empty UIMORI_DB path; existing databases are not upgraded, deleted, or rewritten.`
    );
  if (
    version === 0 &&
    db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()
  )
    throw new Error(
      'Unversioned database is not empty; automatic schema inference is not supported.'
    );
  if (version === DATABASE_SCHEMA_VERSION) assertCurrentSchema(db);
  return version;
}

const CHAT_VARIABLE_SCHEMA = [
  'CREATE TABLE chat_variable_states(chat_id TEXT NOT NULL,branch_id TEXT NOT NULL,revision INTEGER NOT NULL,values_json TEXT NOT NULL,PRIMARY KEY(chat_id,branch_id))',
  'CREATE TABLE chat_variable_journal(chat_id TEXT NOT NULL,branch_id TEXT NOT NULL,request_key TEXT NOT NULL,payload_hash TEXT NOT NULL,payload TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(chat_id,branch_id,request_key))',
  'CREATE TABLE chat_variable_outputs(source_id TEXT PRIMARY KEY,body TEXT NOT NULL)',
] as const;

const MAINTENANCE_SCHEMA = [
  "CREATE TABLE maintenance(id INTEGER PRIMARY KEY CHECK(id=1),epoch INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('open','closed')),reason TEXT,updated_at TEXT NOT NULL)",
] as const;

/** Initialize only an empty database; opening current data never runs installers. */
export function initializeDatabaseSchema(db: DatabaseSync, initializeFresh: () => void): void {
  const version = databaseSchemaVersion(db);
  if (version === DATABASE_SCHEMA_VERSION) return;
  if (db.isTransaction)
    throw new DatabaseSchemaError('DATABASE_INITIALIZATION_TRANSACTION_ACTIVE', version);
  db.exec('BEGIN IMMEDIATE');
  try {
    initializeFresh();
    initIllustrations(db);
    initOutline(db);
    initLoreContextDefaults(db);
    db.exec(
      'CREATE TABLE native_transfer_receipts(id TEXT PRIMARY KEY,request_key TEXT NOT NULL UNIQUE,digest TEXT NOT NULL,body TEXT NOT NULL,original TEXT NOT NULL,created_at TEXT NOT NULL)'
    );
    for (const sql of [...CHAT_VARIABLE_SCHEMA, ...MAINTENANCE_SCHEMA]) db.exec(sql);
    if (db.prepare('PRAGMA foreign_key_check').all().length)
      throw new DatabaseSchemaError('DATABASE_INITIALIZATION_FOREIGN_KEYS', version);
    initDatabaseReadIndexes(db);
    db.exec(METADATA_SCHEMA);
    db.prepare('INSERT INTO schema_metadata(id,baseline,signature) VALUES(1,?,?)').run(
      BASELINE,
      databaseSchemaSignature(db)
    );
    db.exec(`PRAGMA user_version=${DATABASE_SCHEMA_VERSION}`);
    assertCurrentSchema(db);
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    if (error instanceof DatabaseSchemaError) throw error;
    throw new DatabaseSchemaError('DATABASE_INITIALIZATION_FAILED', version);
  }
}
