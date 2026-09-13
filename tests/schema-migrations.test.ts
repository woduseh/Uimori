import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.js';
import { DATABASE_SCHEMA_VERSION, SchemaMigrationError } from '../server/schema-migrations.js';
import { exportChatBackup, importChatBackup } from '../server/chat-backup.js';
import { createFrozenSchema15 } from './fixtures/schema-v15.js';

const owned: { directory: string; databases: (DatabaseSync | Store)[] }[] = [];
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No external calls in migrations'));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const item of owned.splice(0).reverse()) {
    for (const db of item.databases.reverse()) {
      try {
        db.close();
      } catch {
        // Tests intentionally close and reopen their owned database.
      }
    }
    const path = resolve(item.directory),
      within = relative(resolve(tmpdir()), path);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(path).startsWith('uimori-migration-')
    )
      throw new Error('Unsafe migration fixture cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-migration-'));
  const item = { directory, databases: [] as (DatabaseSync | Store)[] };
  owned.push(item);
  const path = join(directory, 'synthetic.sqlite');
  return {
    path,
    raw: () => {
      const db = new DatabaseSync(path);
      item.databases.push(db);
      return db;
    },
    frozen: () => {
      const db = createFrozenSchema15(path);
      item.databases.push(db);
      return db;
    },
    open: () => {
      const store = new Store(path);
      item.databases.push(store);
      return store;
    },
  };
}
function snapshot(db: DatabaseSync) {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all();
  return Object.fromEntries(
    tables.map(({ name }) => [
      String(name),
      db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
    ])
  );
}
function schema(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"
    )
    .all();
}
function ledger(db: DatabaseSync) {
  return db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
}
function withoutLedger(db: DatabaseSync) {
  const {
    schema_migrations: _ledger,
    native_transfer_receipts: _transfers,
    package_extension_operations: _extensionOperations,
    package_extension_operation_attempts: _extensionAttempts,
    ...data
  } = snapshot(db);
  return data;
}
function omitAdditions(db: DatabaseSync) {
  db.exec(
    'DROP TABLE illustration_images; DROP TABLE illustration_jobs; DROP TABLE illustration_references; DROP TABLE illustration_settings; DROP TABLE outline_batches; DROP TABLE outline_nodes; ALTER TABLE helper_tasks DROP COLUMN started_at;'
  );
}

test('MIG01 fresh initialization and reopening agree with the frozen v15 shape plus ledger and transfer receipts', () => {
  const f = fixture(),
    store = f.open();
  expect(store.db.prepare('PRAGMA user_version').get()).toEqual({
    user_version: DATABASE_SCHEMA_VERSION,
  });
  expect(ledger(store.db)).toEqual([
    { version: 16, name: 'schema-16-beta-baseline', applied_at: expect.any(String) },
    { version: 17, name: 'schema-17-native-transfer-receipts', applied_at: expect.any(String) },
    { version: 18, name: 'schema-18-package-extension-operations', applied_at: expect.any(String) },
  ]);
  const before = snapshot(store.db),
    beforeSchema = schema(store.db);
  store.close();
  const again = f.open();
  expect(snapshot(again.db)).toEqual(before);
  expect(schema(again.db)).toEqual(beforeSchema);
  expect(again.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

test('MIG02 an actual frozen v15 preserves every stored row, source, image, state, entropy and snapshot', () => {
  const f = fixture(),
    raw = f.frozen();
  const before = snapshot(raw);
  expect(before.sources.length).toBeGreaterThan(0);
  expect(before.assets.length).toBeGreaterThan(0);
  expect(before.package_behavior_states.length).toBeGreaterThan(0);
  expect(before.package_behavior_entropy.length).toBe(1);
  const beforeSchema = schema(raw);
  raw.close();
  const store = f.open();
  expect(withoutLedger(store.db)).toEqual(before);
  expect(
    schema(store.db).filter(
      (entry) =>
        ![
          'schema_migrations',
          'native_transfer_receipts',
          'package_extension_operations',
          'package_extension_operation_attempts',
        ].includes(String(entry.tbl_name))
    )
  ).toEqual(beforeSchema);
  const firstLedger = ledger(store.db);
  store.close();
  expect(ledger(f.open().db)).toEqual(firstLedger);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

test.each(['all absent', 'some tables present', 'timing only'] as const)(
  'MIG03 known v15 additions: %s',
  (variant) => {
    const f = fixture(),
      raw = f.frozen();
    if (variant === 'all absent') omitAdditions(raw);
    else if (variant === 'some tables present')
      raw.exec(
        'DROP TABLE illustration_images; DROP TABLE illustration_jobs; DROP TABLE outline_batches; ALTER TABLE helper_tasks DROP COLUMN started_at;'
      );
    else raw.exec('ALTER TABLE helper_tasks DROP COLUMN started_at');
    const before = snapshot(raw);
    raw.close();
    const store = f.open();
    const after = withoutLedger(store.db);
    for (const [table, rows] of Object.entries(before)) expect(after[table], table).toEqual(rows);
    expect(
      store.db
        .prepare('PRAGMA table_info(helper_tasks)')
        .all()
        .some((column) => column.name === 'started_at')
    ).toBe(true);
    expect(store.db.prepare('SELECT count(*) AS n FROM illustration_settings').get()).toEqual({
      n: 1,
    });
    expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  }
);

test('MIG04 migrated nullable timing keeps a pre-existing task unchanged and adds SQL NULL', () => {
  const f = fixture(),
    raw = f.frozen();
  raw.exec(`ALTER TABLE helper_tasks DROP COLUMN started_at;
    INSERT INTO helper_conversations(id,scope_key,creation_key,creation_hash,scope,title,auto_title,revision,persona,created_at,updated_at) VALUES('old-conversation','scope','creation','hash','{}','Synthetic old helper',0,1,'{}','old-time','old-time');
    INSERT INTO helper_tasks(id,conversation_id,request_key,request,status,generation,owner,snapshot,error,usage,created_at,updated_at) VALUES('old-task','old-conversation','request','Synthetic request','running',3,'old-owner','{"frozen":true}',NULL,'{}','created','updated');`);
  const before = raw.prepare('SELECT * FROM helper_tasks').get();
  raw.close();
  const store = f.open();
  expect(store.db.prepare('SELECT * FROM helper_tasks').get()).toEqual({
    ...before,
    started_at: null,
  });
});

test.each([
  'missing core table',
  'conflicting additive column',
  'base view',
  'additive view',
] as const)('MIG05 unsupported v15 shape fails without mutation: %s', (variant) => {
  const f = fixture(),
    raw = f.frozen();
  if (variant === 'missing core table') raw.exec('DROP TABLE provider_connection_tests');
  else if (variant === 'base view')
    raw.exec(
      'DROP TABLE provider_connection_tests; CREATE VIEW provider_connection_tests AS SELECT NULL AS id'
    );
  else if (variant === 'additive view')
    raw.exec('DROP TABLE outline_batches; CREATE VIEW outline_batches AS SELECT NULL AS chat_id');
  else raw.exec('ALTER TABLE illustration_jobs ADD COLUMN unexpected TEXT');
  const before = snapshot(raw),
    beforeSchema = schema(raw);
  raw.close();
  expect(() => f.open()).toThrow('DATABASE_SCHEMA_MISMATCH');
  const after = f.raw();
  expect(snapshot(after)).toEqual(before);
  expect(schema(after)).toEqual(beforeSchema);
  expect(after.prepare('PRAGMA user_version').get()).toEqual({ user_version: 15 });
});

test.each(['after DDL', 'after ledger'] as const)(
  'MIG06 failed upgrade rolls back and releases ownership: %s',
  (point) => {
    const f = fixture(),
      raw = f.frozen();
    omitAdditions(raw);
    const before = snapshot(raw),
      beforeSchema = schema(raw);
    raw.close();
    const exec = DatabaseSync.prototype.exec;
    const injected = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
      this: DatabaseSync,
      sql: string
    ) {
      if (
        point === 'after DDL'
          ? sql.startsWith('ALTER TABLE helper_tasks ADD')
          : sql === 'PRAGMA user_version=16'
      )
        throw new Error('synthetic failure with private data that diagnostics must not copy');
      return exec.call(this, sql);
    });
    let error: unknown;
    try {
      f.open();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SchemaMigrationError);
    expect(error).toMatchObject({
      code: 'DATABASE_MIGRATION_FAILED',
      fromVersion: 15,
      toVersion: DATABASE_SCHEMA_VERSION,
      migration: 'schema-16-beta-baseline',
    });
    expect(String(error)).not.toContain('private data');
    injected.mockRestore();
    const unchanged = f.raw();
    expect(schema(unchanged)).toEqual(beforeSchema);
    expect(snapshot(unchanged)).toEqual(before);
    expect(unchanged.prepare('PRAGMA user_version').get()).toEqual({ user_version: 15 });
    unchanged.close();
    expect(ledger(f.open().db)).toHaveLength(3);
  }
);

test('MIG07 final foreign-key validation rolls back all additions', () => {
  const f = fixture(),
    raw = f.frozen();
  omitAdditions(raw);
  raw.exec(
    "PRAGMA foreign_keys=OFF; INSERT INTO profiles(chat_id,body) VALUES('missing-chat','{}')"
  );
  const before = snapshot(raw),
    beforeSchema = schema(raw);
  raw.close();
  expect(() => f.open()).toThrow('DATABASE_MIGRATION_FOREIGN_KEYS');
  const after = f.raw();
  expect(snapshot(after)).toEqual(before);
  expect(schema(after)).toEqual(beforeSchema);
});

test.each([0, 14, 19])(
  'MIG08 unsupported version %s leaves the original SQLite bytes and data intact',
  (version) => {
    const f = fixture(),
      raw = f.frozen();
    raw.exec(`PRAGMA user_version=${version}`);
    raw.close();
    const bytes = readFileSync(f.path);
    expect(() => f.open()).toThrow(
      version === 0
        ? 'Unversioned database is not empty'
        : `Unsupported database schema version ${version}`
    );
    expect(readFileSync(f.path)).toEqual(bytes);
  }
);

test.each([
  'DROP TABLE schema_migrations',
  'DELETE FROM schema_migrations',
  "UPDATE schema_migrations SET name='unknown'",
  "UPDATE schema_migrations SET applied_at='not-a-time'",
  "INSERT INTO schema_migrations VALUES(19,'unknown','2026-09-12T00:00:00.000Z')",
  'ALTER TABLE schema_migrations ADD COLUMN unexpected TEXT',
  'PRAGMA user_version=15',
])('MIG09 inconsistent ledger is rejected without repair: %s', (sql) => {
  const f = fixture(),
    store = f.open();
  store.db.exec(sql);
  const before = snapshot(store.db),
    beforeSchema = schema(store.db);
  store.close();
  expect(() => f.open()).toThrow('DATABASE_MIGRATION_LEDGER_MISMATCH');
  const after = f.raw();
  expect(snapshot(after)).toEqual(before);
  expect(schema(after)).toEqual(beforeSchema);
});

test('MIG10 a missing current table is not silently recreated', () => {
  const f = fixture(),
    store = f.open();
  store.db.exec('DROP TABLE outline_batches');
  store.close();
  expect(() => f.open()).toThrow('DATABASE_SCHEMA_MISMATCH:outline_batches');
});

test('MIG11 SQLite backup retains migration history; archive15 and chat-backup1 retain their independent formats', () => {
  const source = fixture();
  source.frozen().close();
  const store = source.open();
  const backup = fixture();
  writeFileSync(backup.path, store.product.backup());
  const restored = backup.open();
  expect(snapshot(restored.db)).toEqual(snapshot(store.db));
  const archive = store.product.export();
  expect(archive.version).toBe(15);
  expect(archive.tables).not.toHaveProperty('schema_migrations');
  const target = fixture().open(),
    destinationLedger = ledger(target.db);
  target.product.import(archive);
  expect(ledger(target.db)).toEqual(destinationLedger);
  const chatId = String(store.db.prepare('SELECT id FROM chats LIMIT 1').get()!.id);
  const portable = exportChatBackup(store, chatId);
  expect(portable.version).toBe(1);
  const imported = importChatBackup(target, {
    backup: portable,
    idempotencyKey: 'synthetic-migration-import',
  });
  expect(imported.sources).toBeGreaterThan(0);
  expect(ledger(target.db)).toEqual(destinationLedger);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

test('MIG12 frozen schema16 adds transfer and extension storage; failed schema17 rolls back its ledger and DDL', () => {
  const f = fixture(),
    raw = f.frozen();
  raw.exec(
    "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES(16,'schema-16-beta-baseline','2026-09-12T00:00:00.000Z'); PRAGMA user_version=16"
  );
  const before = snapshot(raw),
    beforeSchema = schema(raw);
  raw.close();
  const exec = DatabaseSync.prototype.exec;
  const injected = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
    this: DatabaseSync,
    sql: string
  ) {
    if (sql === 'PRAGMA user_version=17') throw new Error('Synthetic schema17 failure');
    return exec.call(this, sql);
  });
  expect(() => f.open()).toThrow(
    'DATABASE_MIGRATION_FAILED:16->18:schema-17-native-transfer-receipts'
  );
  injected.mockRestore();
  const unchanged = f.raw();
  expect(snapshot(unchanged)).toEqual(before);
  expect(schema(unchanged)).toEqual(beforeSchema);
  unchanged.close();
  const store = f.open();
  expect(ledger(store.db)[0]).toEqual(before.schema_migrations[0]);
  for (const [table, rows] of Object.entries(before))
    if (table !== 'schema_migrations') expect(snapshot(store.db)[table]).toEqual(rows);
  expect(store.db.prepare('SELECT * FROM native_transfer_receipts').all()).toEqual([]);
  expect(ledger(store.db)).toHaveLength(3);
});

test('MIG14 schema17 upgrades atomically and preserves every previous table and ledger row', () => {
  const f = fixture(),
    old = f.open();
  old.db.exec(
    'DROP TABLE package_extension_operation_attempts; DROP TABLE package_extension_operations; DELETE FROM schema_migrations WHERE version=18; PRAGMA user_version=17'
  );
  const before = snapshot(old.db),
    beforeSchema = schema(old.db);
  old.close();
  const exec = DatabaseSync.prototype.exec;
  const injected = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
    this: DatabaseSync,
    sql: string
  ) {
    if (sql === 'PRAGMA user_version=18') throw new Error('Synthetic schema18 failure');
    return exec.call(this, sql);
  });
  expect(() => f.open()).toThrow(
    'DATABASE_MIGRATION_FAILED:17->18:schema-18-package-extension-operations'
  );
  injected.mockRestore();
  const unchanged = f.raw();
  expect(snapshot(unchanged)).toEqual(before);
  expect(schema(unchanged)).toEqual(beforeSchema);
  expect(unchanged.prepare('PRAGMA user_version').get()!.user_version).toBe(17);
  unchanged.close();
  const current = f.open();
  for (const [table, rows] of Object.entries(before))
    if (table !== 'schema_migrations') expect(snapshot(current.db)[table]).toEqual(rows);
  expect(ledger(current.db).slice(0, 2)).toEqual(before.schema_migrations);
  expect(current.db.prepare('SELECT * FROM package_extension_operations').all()).toEqual([]);
  expect(current.db.prepare('SELECT * FROM package_extension_operation_attempts').all()).toEqual(
    []
  );
});

test('MIG15 schema18 rejects a weakened extension active-owner index without repairing it', () => {
  const f = fixture(),
    store = f.open();
  store.db.exec(
    "DROP INDEX package_extension_one_active; CREATE INDEX package_extension_one_active ON package_extension_operations(chat_id,branch_id,attachment_instance_id) WHERE status='running'"
  );
  const before = schema(store.db);
  store.close();
  expect(() => f.open()).toThrow('DATABASE_SCHEMA_MISMATCH:package_extension_one_active');
  expect(schema(f.raw())).toEqual(before);
});

test.each(['missing', 'partial'] as const)(
  'MIG13 schema17 rejects a receipt table without complete idempotency uniqueness: %s',
  (variant) => {
    const f = fixture(),
      store = f.open();
    store.db.exec(
      'DROP TABLE native_transfer_receipts; CREATE TABLE native_transfer_receipts(id TEXT PRIMARY KEY,request_key TEXT NOT NULL,digest TEXT NOT NULL,body TEXT NOT NULL,original TEXT NOT NULL,created_at TEXT NOT NULL)'
    );
    if (variant === 'partial')
      store.db.exec(
        "CREATE UNIQUE INDEX partial_receipt_key ON native_transfer_receipts(request_key) WHERE request_key='x'"
      );
    const before = schema(store.db);
    store.close();
    expect(() => f.open()).toThrow('DATABASE_SCHEMA_MISMATCH:native_transfer_receipts');
    expect(schema(f.raw())).toEqual(before);
  }
);
