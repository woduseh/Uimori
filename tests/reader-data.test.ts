import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, test } from 'vitest';
import {
  changedReaderSources,
  readerJobIds,
  readerPresentationRevisions,
} from '../server/reader-data.js';

const databases = new Set<DatabaseSync>();
afterEach(() => {
  for (const db of databases) db.close();
  databases.clear();
});
function fixture() {
  const db = new DatabaseSync(':memory:');
  databases.add(db);
  db.exec(`CREATE TABLE jobs(id TEXT PRIMARY KEY,chat_id TEXT,source_revision TEXT,source_hash TEXT,kind TEXT,revision INTEGER,created_at TEXT);
    CREATE TABLE illustration_jobs(id TEXT PRIMARY KEY,chat_id TEXT,source_revision TEXT);`);
  const insert = (
    id: string,
    hash: string,
    kind: string,
    revision = 1,
    source = 'source',
    chat = 'chat',
    at = '2026-01-01'
  ) =>
    db
      .prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)')
      .run(id, chat, source, hash, kind, revision, at);
  return { db, insert };
}

test('event replay groups repeated IDs without crossing chat or task-table ownership', () => {
  const state = fixture();
  state.insert('same', 'hash', 'translation');
  state.insert('secret', 'hash', 'translation', 1, 'foreign', 'another-chat');
  state.db.exec("INSERT INTO illustration_jobs VALUES('same','chat','image-source')");
  let reads = 0;
  const db = {
    prepare: (sql: string) => {
      reads++;
      return state.db.prepare(sql);
    },
  } as DatabaseSync;
  const events = Array.from({ length: 2000 }, (_, i) => ({
    kind: i % 2 ? 'job.running' : 'job.completed',
    entityId: 'same',
  }));
  events.push(
    { kind: 'illustration.completed', entityId: 'same' },
    { kind: 'job.completed', entityId: 'secret' },
    { kind: 'source.edited', entityId: 'edited' },
    { kind: 'job.completed', entityId: 'deleted' },
    { kind: 'run.completed', entityId: 'not-a-source' }
  );
  assert.deepEqual([...changedReaderSources({ db }, 'chat', events)].sort(), [
    'edited',
    'image-source',
    'source',
  ]);
  assert.equal(reads, 2);
});

test('visible jobs filter by kind and hash and select the latest translation by revision, date and ID', () => {
  const state = fixture();
  state.insert('older-revision', 'hash', 'translation', 1, 'source', 'chat', '2026-01-03');
  state.insert('z-older-date', 'hash', 'translation', 2);
  state.insert('a-tied', 'hash', 'translation', 2, 'source', 'chat', '2026-01-02');
  state.insert('b-latest', 'hash', 'translation', 2, 'source', 'chat', '2026-01-02');
  state.insert('current-status', 'hash', 'status');
  state.insert('stale-status', 'stale', 'status');
  state.insert('stale-image', 'stale', 'image');
  state.insert('foreign-source', 'hash', 'translation', 3, 'other-source');
  assert.deepEqual(
    readerJobIds(state, 'source', 'hash').map((row) => row.id),
    ['stale-image', 'b-latest']
  );
});

test('the latest translation uses all revisions before source-hash filtering, not a fallback', () => {
  const state = fixture();
  state.insert('old-matching', 'hash', 'translation', 1);
  state.insert('latest-nonmatching', 'different', 'translation', 2);
  assert.deepEqual(readerJobIds(state, 'source', 'hash'), []);
});

test('presentation revisions follow each scene unless the chat renders through a native card', () => {
  const db = new DatabaseSync(':memory:');
  databases.add(db);
  db.exec(`CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,chat_id TEXT,kind TEXT,entity_id TEXT);
    CREATE TABLE jobs(id TEXT PRIMARY KEY,chat_id TEXT,source_revision TEXT,kind TEXT);
    CREATE TABLE sources(id TEXT PRIMARY KEY,run_id TEXT);
    CREATE TABLE runs(id TEXT PRIMARY KEY,snapshot TEXT);
    CREATE TABLE app_metadata(key TEXT PRIMARY KEY,value TEXT);
    INSERT INTO sources VALUES('a','run-a'),('b','run-b');
    INSERT INTO runs VALUES('run-a','{"settled":true}'),('run-b','{"settled":true}');`);
  const event = (kind: string, entity: string) =>
    db
      .prepare('INSERT INTO events(chat_id,kind,entity_id) VALUES(?,?,?)')
      .run('chat', kind, entity);
  let packages: { nativeRisu?: object }[] = [];
  const store = {
    db,
    product: { snapshot: () => ({ packages, promptPresets: {} }) },
  } as unknown as Parameters<typeof readerPresentationRevisions>[0];
  const revisions = () => readerPresentationRevisions(store, 'chat', ['a', 'b']);
  event('source.ready', 'a');
  event('source.ready', 'b');
  const before = revisions();
  event('source.ready', 'c');
  assert.deepEqual(revisions(), before);
  event('source.edited', 'a');
  const edited = revisions();
  assert.notEqual(edited.a, before.a);
  assert.equal(edited.b, before.b);
  event('asset.created', 'asset');
  const assets = revisions();
  assert.notEqual(assets.a, edited.a);
  assert.notEqual(assets.b, edited.b);
  packages = [{ nativeRisu: {} }];
  const native = revisions();
  event('source.ready', 'd');
  const next = revisions();
  assert.notEqual(next.a, native.a);
  assert.notEqual(next.b, native.b);
});
