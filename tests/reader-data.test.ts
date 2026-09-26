import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, test } from 'vitest';
import { changedReaderSources, readerJobIds } from '../server/reader-data.js';

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

test('source-only and irrelevant events need no task-table queries', () => {
  const db = {
    prepare: () => {
      throw new Error('unexpected task query');
    },
  } as unknown as DatabaseSync;
  assert.deepEqual([...changedReaderSources({ db }, 'chat', [])], []);
  assert.deepEqual(
    [
      ...changedReaderSources({ db }, 'chat', [
        { kind: 'run.running', entityId: 'run' },
        { kind: 'source.edited', entityId: 'source' },
      ]),
    ],
    ['source']
  );
});

test('visible jobs match the original hash/kind/latest-translation filtering and ordering', () => {
  const state = fixture();
  state.insert('old-translation', 'hash', 'translation', 1);
  state.insert('new-translation', 'hash', 'translation', 2);
  state.insert('current-status', 'hash', 'status');
  state.insert('stale-status', 'stale', 'status');
  state.insert('stale-image', 'stale', 'image');
  state.insert('foreign-source', 'hash', 'translation', 3, 'other-source');
  assert.deepEqual(
    readerJobIds(state, 'source', 'hash').map((row) => row.id),
    ['current-status', 'new-translation', 'stale-image']
  );
});

test('the latest translation uses all revisions before source-hash filtering, not a fallback', () => {
  const state = fixture();
  state.insert('old-matching', 'hash', 'translation', 1);
  state.insert('latest-nonmatching', 'different', 'translation', 2);
  assert.deepEqual(readerJobIds(state, 'source', 'hash'), []);
});

test('translation ranking retains revision, creation-time and ID tie breaks', () => {
  const state = fixture();
  state.insert('a', 'hash', 'translation', 3, 'source', 'chat', '2026-01-01');
  state.insert('b', 'hash', 'translation', 3, 'source', 'chat', '2026-01-02');
  state.insert('c', 'hash', 'translation', 3, 'source', 'chat', '2026-01-02');
  assert.deepEqual(
    readerJobIds(state, 'source', 'hash').map((row) => row.id),
    ['c']
  );
});
