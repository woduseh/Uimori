import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import type { RunSnapshot } from '../core/types.js';
import { HttpError } from '../server/request-validation.js';
import { readRunSnapshot, readRunStatus } from '../server/run-projections.js';
import { SnapshotDatabase } from '../server/snapshot-database.js';

const databases = new Set<SnapshotDatabase>();
afterEach(() => {
  for (const db of databases) db.close();
  databases.clear();
});

function snapshot(request = '다음 장면'): RunSnapshot {
  return {
    chatId: 'chat-1',
    parentRevision: null,
    settingsRevision: 1,
    settings: { preset: 'calm', mode: 'direct', translation: false, status: false, maxCalls: 8 },
    request,
    history: [],
    resources: [],
  };
}

/** Minimal isolated tables exercise the real packing/expansion boundary, not a Store mock. */
function fixture(value = snapshot(), packed = true) {
  const db = new SnapshotDatabase(':memory:');
  databases.add(db);
  db.exec(`
    CREATE TABLE runs(id TEXT PRIMARY KEY,status TEXT NOT NULL,snapshot TEXT NOT NULL);
    CREATE TABLE snapshot_texts(hash TEXT PRIMARY KEY,body TEXT NOT NULL);
  `);
  db.prepare(
    packed
      ? "INSERT INTO runs VALUES(?,'queued',snapshot_pack(?))"
      : "INSERT INTO runs VALUES(?,'queued',?)"
  ).run('run-1', JSON.stringify(value));
  return { db };
}

test('status projections read live transitions, including cancellation, without a state cache', () => {
  const store = fixture();
  for (const status of [
    'queued',
    'running',
    'completed',
    'failed',
    'cancelled',
    'interrupted',
    'refused',
    'partial',
  ]) {
    store.db.prepare('UPDATE runs SET status=? WHERE id=?').run(status, 'run-1');
    assert.equal(readRunStatus(store, 'run-1'), status);
  }
});

test('a status check never expands the snapshot, even when its referenced body is unavailable', () => {
  const store = fixture(snapshot('본문 🌿 '.repeat(2000)));
  store.db.exec('DELETE FROM snapshot_texts');
  store.db.prepare('UPDATE runs SET status=? WHERE id=?').run('running', 'run-1');
  assert.equal(readRunStatus(store, 'run-1'), 'running');
  store.db.prepare('UPDATE runs SET status=? WHERE id=?').run('cancelled', 'run-1');
  assert.equal(readRunStatus(store, 'run-1'), 'cancelled');
  assert.throws(() => readRunSnapshot(store, 'run-1'), /SNAPSHOT_TEXT_INTEGRITY/u);
});

test('packed and inline snapshot reads preserve exact values without diagnostic tables', () => {
  const value = snapshot('한국어 日本語 🌿 "quoted" \\path\n'.repeat(1000));
  value.history = [
    { revision: 'source-1', text: value.request },
    { revision: 'source-2', text: '다른 장면 '.repeat(1000) },
  ];
  for (const packed of [false, true]) {
    const store = fixture(value, packed);
    // No attempts, model_inputs, or tool_events table exists in this fixture.
    assert.deepEqual(readRunSnapshot(store, 'run-1'), value);
  }
});

test('snapshot reads are detached and observe a later persisted revision', () => {
  const original = snapshot('보존할 본문 '.repeat(100));
  const store = fixture(original);
  const first = readRunSnapshot(store, 'run-1');
  first.request = '로컬 수정';
  first.settings.maxCalls = 1;
  first.history.push({ revision: 'local-only', text: '저장하지 않은 수정' });
  assert.deepEqual(readRunSnapshot(store, 'run-1'), original);
  const next = { ...original, settingsRevision: 2, request: '새로 저장한 본문 '.repeat(100) };
  store.db
    .prepare('UPDATE runs SET snapshot=snapshot_pack(?) WHERE id=?')
    .run(JSON.stringify(next), 'run-1');
  assert.deepEqual(readRunSnapshot(store, 'run-1'), next);
});

test('snapshot projections retain hash-integrity and malformed-JSON failures', () => {
  const store = fixture(snapshot('검증할 본문 '.repeat(200)));
  store.db.prepare('UPDATE snapshot_texts SET body=?').run(JSON.stringify('tampered'));
  assert.throws(() => readRunSnapshot(store, 'run-1'), /SNAPSHOT_TEXT_INTEGRITY/u);
  store.db.prepare('UPDATE runs SET snapshot=? WHERE id=?').run('{invalid', 'run-1');
  assert.throws(() => readRunSnapshot(store, 'run-1'), SyntaxError);
});

test('both projections preserve the missing-run HTTP error', () => {
  const store = fixture();
  for (const read of [readRunStatus, readRunSnapshot])
    assert.throws(
      () => read(store, 'missing'),
      (error: unknown) =>
        error instanceof HttpError && error.statusCode === 404 && error.message === 'Run not found'
    );
});

test('database failures propagate rather than serving cached or assumed execution state', () => {
  const store = fixture();
  assert.equal(readRunStatus(store, 'run-1'), 'queued');
  store.db.exec('DROP TABLE runs');
  assert.throws(() => readRunStatus(store, 'run-1'), /no such table/u);
  assert.throws(() => readRunSnapshot(store, 'run-1'), /no such table/u);
});
