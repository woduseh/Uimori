import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'vitest';
import { Store } from '../server/store.js';
import { SnapshotDatabase } from '../server/snapshot-database.js';
import { snapshotStorageTriggers } from '../server/snapshot-storage-schema.js';
import { databaseSchemaSignature } from '../server/database-signature.js';
import { DATABASE_SCHEMA_VERSION } from '../server/database-schema.js';
import {
  inspectDatabasePerformance,
  optimizeDatabasePerformance,
} from '../server/database-performance.js';

const directories: string[] = [];
const handles = new Set<Store | SnapshotDatabase>();
afterEach(() => {
  for (const handle of handles) handle.close();
  handles.clear();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const close = (handle: Store | SnapshotDatabase) => {
  handle.close();
  handles.delete(handle);
};

test('Store admits signed legacy optimization definitions, then reopens an explicitly optimized DB', () => {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-perf-store-'));
  directories.push(directory);
  const path = join(directory, 'synthetic.sqlite');
  const store = new Store(path);
  handles.add(store);
  assert.equal(inspectDatabasePerformance(store.db, DATABASE_SCHEMA_VERSION).optimized, true);
  const bot = store.product.content({
    kind: 'bot',
    title: 'Synthetic owner',
    description: 'Database performance fixture',
    text: 'Synthetic content',
    loading: 'pinned',
    relatedIds: [],
  });
  const chat = store.createChat('Synthetic performance fixture', 'calm', { botId: bot.id });
  // Persist a standalone execution row without starting workers or contacting a provider.
  const snapshot = {
    chatId: chat.id,
    parentRevision: null,
    settingsRevision: chat.settingsRevision,
    settings: chat.settings,
    request: 'Original request '.repeat(80),
    history: [],
    resources: [],
  };
  store.db
    .prepare(`INSERT INTO runs(id,chat_id,parent_revision,status,request,snapshot,request_key,command,created_at,updated_at,branch_id)
    VALUES(?,?,NULL,'queued',?,snapshot_pack(?),?,'{}',?,?,?)`)
    .run(
      'performance-fixture',
      chat.id,
      snapshot.request,
      JSON.stringify(snapshot),
      'performance-fixture',
      new Date().toISOString(),
      new Date().toISOString(),
      `main:${chat.id}`
    );
  // Only this synthetic DB is downgraded to the previous physical optimization definitions.
  for (const trigger of snapshotStorageTriggers()) store.db.exec(`DROP TRIGGER ${trigger.name}`);
  for (const trigger of snapshotStorageTriggers(true)) store.db.exec(trigger.sql);
  for (const name of [
    'model_inputs_run_seq',
    'tool_events_run_seq',
    'sources_chat',
    'attempts_run',
    'attempts_chat_run',
  ])
    store.db.exec(`DROP INDEX ${name}`);
  store.db
    .prepare('UPDATE schema_metadata SET signature=? WHERE id=1')
    .run(databaseSchemaSignature(store.db));
  close(store);
  const admitted = new Store(path);
  handles.add(admitted);
  assert.equal(
    inspectDatabasePerformance(admitted.db, DATABASE_SCHEMA_VERSION).snapshotCleanup,
    'legacy'
  );
  assert.deepEqual(admitted.run('performance-fixture').snapshot, snapshot);
  close(admitted);
  const maintenance = new SnapshotDatabase(path);
  handles.add(maintenance);
  maintenance.exec('PRAGMA foreign_keys=ON');
  optimizeDatabasePerformance(maintenance, DATABASE_SCHEMA_VERSION);
  close(maintenance);
  const reopened = new Store(path);
  handles.add(reopened);
  assert.equal(inspectDatabasePerformance(reopened.db, DATABASE_SCHEMA_VERSION).optimized, true);
  assert.deepEqual(reopened.run('performance-fixture').snapshot, snapshot);
  assert.deepEqual(reopened.db.prepare('PRAGMA foreign_key_check').all(), []);
});
