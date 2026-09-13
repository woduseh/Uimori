import type { DatabaseSync } from 'node:sqlite';
import { SCHEMA_15_COLUMNS } from './schema-v15-contract.js';

export const DATABASE_SCHEMA_VERSION = 18;
const BASELINE_VERSION = 15;
const LEDGER = 'schema_migrations';
const ADDITIVE_TABLES = new Set([
  'illustration_settings',
  'illustration_references',
  'illustration_jobs',
  'illustration_images',
  'outline_nodes',
  'outline_batches',
]);
type Column = {
  name: string;
  type: string;
  notnull: number;
  pk: number;
  dflt_value: string | null;
};
type Migration = {
  version: number;
  name: string;
  apply: (db: DatabaseSync) => void;
  validate: (db: DatabaseSync) => void;
};

export class SchemaMigrationError extends Error {
  constructor(
    readonly code: string,
    readonly fromVersion: number,
    readonly toVersion = DATABASE_SCHEMA_VERSION,
    readonly migration?: string
  ) {
    super(`${code}:${fromVersion}->${toVersion}${migration ? `:${migration}` : ''}`);
    this.name = 'SchemaMigrationError';
  }
}

/** Read-only admission happens before journal changes, DDL, or default insertion. */
export function databaseSchemaVersion(db: DatabaseSync): number {
  const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
  if (
    version !== 0 &&
    version !== BASELINE_VERSION &&
    !migrations.some((migration) => migration.version === version)
  )
    throw new Error(
      `Unsupported database schema version ${version}; Uimori supports schema 15 through ${DATABASE_SCHEMA_VERSION}. ${version > DATABASE_SCHEMA_VERSION ? 'Use an application that supports this newer database; downgrades are not applied.' : 'For disposable default development data only, stop the server and run npm run reset:dev.'}`
    );
  if (
    version === 0 &&
    db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()
  )
    throw new Error(
      'Unversioned database is not empty; automatic schema inference is not supported.'
    );
  return version;
}

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Column[])
    .map((column) =>
      [column.name, column.type, column.notnull, column.pk, column.dflt_value ?? '~'].join('|')
    )
    .sort();
}

function assertV15Columns(db: DatabaseSync, version: number, allowMissingAdditions: boolean) {
  for (const [table, expected] of Object.entries(SCHEMA_15_COLUMNS)) {
    const object = db.prepare('SELECT type FROM sqlite_schema WHERE name=?').get(table);
    if (!object && allowMissingAdditions && ADDITIVE_TABLES.has(table)) continue;
    if (object?.type !== 'table')
      throw new SchemaMigrationError(`DATABASE_SCHEMA_MISMATCH:${table}`, version);
    const actual = columns(db, table);
    const target = expected
      .split(' ')
      .filter(
        (column) =>
          !(
            allowMissingAdditions &&
            table === 'helper_tasks' &&
            column.startsWith('started_at|') &&
            !actual.some((entry) => entry.startsWith('started_at|'))
          )
      );
    if (actual.join(' ') !== target.join(' '))
      throw new SchemaMigrationError(`DATABASE_SCHEMA_MISMATCH:${table}`, version);
  }
}

function assertLedger(db: DatabaseSync, version: number) {
  const exists = db.prepare('SELECT type FROM sqlite_schema WHERE name=?').get(LEDGER);
  if (version === BASELINE_VERSION) {
    if (exists) throw new SchemaMigrationError('DATABASE_MIGRATION_LEDGER_MISMATCH', version);
    return;
  }
  if (
    exists?.type !== 'table' ||
    columns(db, LEDGER).join(' ') !== 'applied_at|TEXT|1|0|~ name|TEXT|1|0|~ version|INTEGER|0|1|~'
  )
    throw new SchemaMigrationError('DATABASE_MIGRATION_LEDGER_MISMATCH', version);
  const rows = db
    .prepare('SELECT version,name,applied_at FROM schema_migrations ORDER BY version')
    .all();
  const expected = migrations.filter((migration) => migration.version <= version);
  if (
    rows.length !== expected.length ||
    rows.some(
      (row, index) =>
        row.version !== expected[index].version ||
        row.name !== expected[index].name ||
        typeof row.applied_at !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.applied_at) ||
        !Number.isFinite(Date.parse(row.applied_at)) ||
        new Date(row.applied_at).toISOString() !== row.applied_at
    )
  )
    throw new SchemaMigrationError('DATABASE_MIGRATION_LEDGER_MISMATCH', version);
}

/** Frozen 15 -> 16 steps. Future defaults and installers must not change this migration. */
function migrate15To16(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS illustration_settings (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS illustration_references (chat_id TEXT PRIMARY KEY REFERENCES chats(id), revision INTEGER NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS illustration_jobs (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), source_revision TEXT NOT NULL REFERENCES sources(id), source_hash TEXT NOT NULL, origin TEXT NOT NULL CHECK(origin IN ('automatic','manual')), status TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, owner TEXT, attempt INTEGER NOT NULL DEFAULT 1, input TEXT NOT NULL, diagnostic TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS illustration_jobs_source ON illustration_jobs(source_revision,created_at);
    CREATE INDEX IF NOT EXISTS illustration_jobs_chat ON illustration_jobs(chat_id,created_at);
    CREATE TABLE IF NOT EXISTS illustration_images (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES illustration_jobs(id), chat_id TEXT NOT NULL REFERENCES chats(id), position INTEGER NOT NULL, mime TEXT NOT NULL, hash TEXT NOT NULL, body TEXT NOT NULL, bytes BLOB NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS illustration_images_job ON illustration_images(job_id,position);
    CREATE TABLE IF NOT EXISTS outline_nodes (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), branch_id TEXT NOT NULL REFERENCES branches(id), parent_id TEXT REFERENCES outline_nodes(id), level TEXT NOT NULL, position INTEGER NOT NULL, title TEXT NOT NULL, intent TEXT NOT NULL, fixed INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL, command_id TEXT REFERENCES scene_commands(id), request_key TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(chat_id,request_key));
    CREATE INDEX IF NOT EXISTS outline_nodes_branch ON outline_nodes(chat_id,branch_id,parent_id,position);
    CREATE TABLE IF NOT EXISTS outline_batches (chat_id TEXT NOT NULL REFERENCES chats(id), branch_id TEXT NOT NULL REFERENCES branches(id), request_key TEXT NOT NULL, authority TEXT NOT NULL, operations TEXT NOT NULL, created TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(chat_id,request_key));
  `);
  db.prepare('INSERT OR IGNORE INTO illustration_settings(id,body) VALUES(1,?)').run(
    '{"revision":1,"generator":"none","automatic":false,"maxPerSource":2,"maxAutoRetries":1,"styleGuidance":"","codex":{"model":null,"useReferences":true},"comfyui":{"baseUrl":"","authorizationEnv":"","workflow":"","timeoutMs":300000,"pollIntervalMs":1000,"promptModel":null,"negativeGuidance":""}}'
  );
  if (!columns(db, 'helper_tasks').some((column) => column.startsWith('started_at|')))
    db.exec('ALTER TABLE helper_tasks ADD COLUMN started_at TEXT');
}

const EXTENSION_OPERATION_SCHEMA = [
  'CREATE TABLE package_extension_operations(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),branch_id TEXT NOT NULL REFERENCES branches(id),attachment_instance_id TEXT NOT NULL,request_key TEXT NOT NULL,request_hash TEXT NOT NULL,command TEXT NOT NULL,snapshot TEXT NOT NULL,status TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 0,owner TEXT,result TEXT,usage TEXT,error TEXT,created_at TEXT NOT NULL,started_at TEXT,updated_at TEXT NOT NULL,UNIQUE(chat_id,branch_id,attachment_instance_id,request_key))',
  "CREATE UNIQUE INDEX package_extension_one_active ON package_extension_operations(chat_id,branch_id,attachment_instance_id) WHERE status IN ('queued','running')",
  'CREATE INDEX package_extension_recent ON package_extension_operations(chat_id,branch_id,attachment_instance_id,created_at)',
  'CREATE TABLE package_extension_operation_attempts(operation_id TEXT NOT NULL REFERENCES package_extension_operations(id) ON DELETE CASCADE,attempt_id TEXT PRIMARY KEY REFERENCES attempts(id) ON DELETE CASCADE,call_index INTEGER NOT NULL,UNIQUE(operation_id,call_index))',
] as const;

const migrations: readonly Migration[] = [
  {
    version: 16,
    name: 'schema-16-beta-baseline',
    apply: migrate15To16,
    // Version 16 deliberately keeps the completed v15 data columns. A future
    // migration supplies its own postcondition instead of changing this one.
    validate: (db) => assertV15Columns(db, 16, false),
  },
  {
    version: 17,
    name: 'schema-17-native-transfer-receipts',
    apply: (db) =>
      db.exec(
        'CREATE TABLE native_transfer_receipts(id TEXT PRIMARY KEY,request_key TEXT NOT NULL UNIQUE,digest TEXT NOT NULL,body TEXT NOT NULL,original TEXT NOT NULL,created_at TEXT NOT NULL)'
      ),
    validate: (db) => {
      assertV15Columns(db, 17, false);
      const uniqueRequestKey = db
        .prepare(
          'SELECT name FROM pragma_index_list(\'native_transfer_receipts\') WHERE "unique"=1 AND partial=0'
        )
        .all()
        .some((index) => {
          const fields = db
            .prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno')
            .all(String(index.name));
          return fields.length === 1 && fields[0].name === 'request_key';
        });
      if (
        db.prepare("SELECT type FROM sqlite_schema WHERE name='native_transfer_receipts'").get()
          ?.type !== 'table' ||
        columns(db, 'native_transfer_receipts').join(' ') !==
          'body|TEXT|1|0|~ created_at|TEXT|1|0|~ digest|TEXT|1|0|~ id|TEXT|0|1|~ original|TEXT|1|0|~ request_key|TEXT|1|0|~' ||
        !uniqueRequestKey
      )
        throw new SchemaMigrationError('DATABASE_SCHEMA_MISMATCH:native_transfer_receipts', 17);
    },
  },
  {
    version: 18,
    name: 'schema-18-package-extension-operations',
    apply: (db) => {
      for (const sql of EXTENSION_OPERATION_SCHEMA) db.exec(sql);
    },
    validate: (db) => {
      migrations.find((migration) => migration.version === 17)!.validate(db);
      for (const sql of EXTENSION_OPERATION_SCHEMA) {
        const match = /^CREATE (?:UNIQUE )?(TABLE|INDEX) ([a-z_]+)/u.exec(sql)!;
        const actual = db.prepare('SELECT type,sql FROM sqlite_schema WHERE name=?').get(match[2]);
        if (actual?.type !== match[1].toLowerCase() || actual.sql !== sql)
          throw new SchemaMigrationError(`DATABASE_SCHEMA_MISMATCH:${match[2]}`, 18);
      }
    },
  },
];

/** Synchronous storage-only upgrade. Call while owning the database, before workers/recovery. */
export function initializeDatabaseSchema(db: DatabaseSync, initializeFresh: () => void): void {
  const fromVersion = databaseSchemaVersion(db);
  if (fromVersion !== 0) {
    assertLedger(db, fromVersion);
    if (fromVersion === BASELINE_VERSION) assertV15Columns(db, fromVersion, true);
    else migrations.find((migration) => migration.version === fromVersion)!.validate(db);
  }
  if (fromVersion === DATABASE_SCHEMA_VERSION) return;
  if (db.isTransaction)
    throw new SchemaMigrationError('DATABASE_MIGRATION_TRANSACTION_ACTIVE', fromVersion);
  let activeMigration = 'fresh-schema-15';
  db.exec('BEGIN IMMEDIATE');
  try {
    if (fromVersion === 0) initializeFresh();
    if (fromVersion <= BASELINE_VERSION)
      db.exec(
        'CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)'
      );
    for (const migration of migrations) {
      if (migration.version <= fromVersion) continue;
      activeMigration = migration.name;
      migration.apply(db);
      migration.validate(db);
      if (db.prepare('PRAGMA foreign_key_check').all().length)
        throw new SchemaMigrationError(
          'DATABASE_MIGRATION_FOREIGN_KEYS',
          fromVersion,
          migration.version,
          migration.name
        );
      db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)').run(
        migration.version,
        migration.name,
        new Date().toISOString()
      );
      db.exec(`PRAGMA user_version=${migration.version}`);
    }
    assertLedger(db, DATABASE_SCHEMA_VERSION);
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    if (error instanceof SchemaMigrationError) throw error;
    // Preserve the migration identity without copying source data or SQL values into diagnostics.
    throw new SchemaMigrationError(
      'DATABASE_MIGRATION_FAILED',
      fromVersion,
      DATABASE_SCHEMA_VERSION,
      activeMigration
    );
  }
}
