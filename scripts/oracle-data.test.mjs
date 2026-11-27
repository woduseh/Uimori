import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  compactDatabase,
  dataMaintenance,
  copyCredentials,
  copyStoppedData,
  inspectData,
  restoreData,
  snapshotDatabase,
} from './oracle-data.mjs';
import { artifactHash, verifyIdentity } from './oracle-image-probe.mjs';
import { distHash } from './lib.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'uimori-oracle-'));
  const source = join(root, 'source');
  mkdirSync(source);
  const db = new DatabaseSync(join(source, 'uimori.sqlite'));
  db.exec(
    "PRAGMA user_version=15; PRAGMA journal_mode=WAL; CREATE TABLE future_jobs(id TEXT PRIMARY KEY,status TEXT,body TEXT); INSERT INTO future_jobs VALUES ('job','completed','original');"
  );
  t.after(() => {
    try {
      db.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  return { root, source, db };
}

test('active work is discovered in future status tables; completed history and pending plans are idle', (t) => {
  const { source, db } = fixture(t);
  db.exec("INSERT INTO future_jobs VALUES ('plan','pending','plan')");
  assert.deepEqual(inspectData(source).active, {});
  for (const state of ['queued', 'running']) {
    db.prepare('UPDATE future_jobs SET status=? WHERE id=?').run(state, 'job');
    assert.throws(() => inspectData(source), /Active work/);
  }
  assert.equal(inspectData(source, { idle: false }).active.future_jobs, 1);
});

test('online SQLite snapshot includes WAL writes and remains independent', async (t) => {
  const { root, source, db } = fixture(t);
  const target = join(root, 'snapshot');
  await snapshotDatabase(source, target);
  db.exec("UPDATE future_jobs SET body='changed'");
  const copied = new DatabaseSync(join(target, 'uimori.sqlite'));
  try {
    assert.equal(copied.prepare('SELECT body FROM future_jobs').get().body, 'original');
  } finally {
    copied.close();
  }
});

test('stopped backup restores DB and companion assets, removing candidate-only files', (t) => {
  const { root, source, db } = fixture(t);
  db.close();
  writeFileSync(join(source, 'image.png'), 'original-image');
  const target = join(root, 'backup');
  copyStoppedData(source, target);
  const changed = new DatabaseSync(join(source, 'uimori.sqlite'));
  changed.exec("UPDATE future_jobs SET body='candidate'");
  changed.close();
  writeFileSync(join(source, 'candidate-only'), 'new');
  writeFileSync(join(source, 'image.png'), 'changed');
  restoreData(target, source);
  assert.equal(readFileSync(join(source, 'image.png'), 'utf8'), 'original-image');
  assert.equal(existsSync(join(source, 'candidate-only')), false);
  assert.equal(inspectData(source, { integrity: true }).integrity, 'ok');
  const restored = new DatabaseSync(join(source, 'uimori.sqlite'));
  try {
    assert.equal(restored.prepare('SELECT body FROM future_jobs').get().body, 'original');
  } finally {
    restored.close();
  }
  assert.throws(() => restoreData(source, join(source, 'nested')), /Overlapping/);
});

function sparseFixture(t) {
  const { source, db } = fixture(t);
  db.exec('CREATE TABLE images(id INTEGER PRIMARY KEY,bytes BLOB)');
  const insert = db.prepare('INSERT INTO images(bytes) VALUES(zeroblob(65536))');
  for (let index = 0; index < 200; index++) insert.run();
  db.exec('DELETE FROM images WHERE id>4');
  db.exec(
    "INSERT INTO future_jobs VALUES('removed','completed',''),('later','completed',''); DELETE FROM future_jobs WHERE id='removed'"
  );
  db.close();
  return { source, file: join(source, 'uimori.sqlite') };
}

test('compaction rewrites a database with many free pages and keeps its content', (t) => {
  const { source, file } = sparseFixture(t);
  const before = statSync(file).size;
  const result = compactDatabase(source, { minFreeBytes: 1024 * 1024 });
  assert.equal(result.compacted, true);
  assert.equal(result.afterBytes, statSync(file).size);
  assert.ok(result.afterBytes < before / 4);
  assert.deepEqual(readdirSync(source), ['uimori.sqlite']);
  assert.equal(inspectData(source, { integrity: true }).integrity, 'ok');
  const compacted = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(compacted.prepare('PRAGMA user_version').get().user_version, 15);
    assert.equal(compacted.prepare('SELECT count(*) AS count FROM images').get().count, 4);
    assert.deepEqual(
      compacted
        .prepare('SELECT rowid,id FROM future_jobs ORDER BY rowid')
        .all()
        .map((row) => [row.rowid, row.id]),
      [
        [1, 'job'],
        [3, 'later'],
      ]
    );
  } finally {
    compacted.close();
  }
  const again = compactDatabase(source, { minFreeBytes: 1024 * 1024 });
  assert.deepEqual([again.compacted, again.reason], [false, 'below-threshold']);
});

test('compaction leaves the database alone below the threshold or past its deadline', (t) => {
  const { source, file } = sparseFixture(t);
  const original = readFileSync(file);
  assert.equal(compactDatabase(source).reason, 'below-threshold');
  const late = compactDatabase(source, { minFreeBytes: 1024 * 1024, swapDeadlineMs: -1 });
  assert.deepEqual([late.compacted, late.reason], [false, 'too-slow']);
  assert.deepEqual(readFileSync(file), original);
  assert.deepEqual(readdirSync(source), ['uimori.sqlite']);
});

test('fresh copies only credential directory and Codex login, never app settings/session databases', (t) => {
  const { root, source } = fixture(t);
  mkdirSync(join(source, 'uimori.sqlite.vertex-credentials'));
  writeFileSync(
    join(source, 'uimori.sqlite.vertex-credentials', 'account.json'),
    'private-account'
  );
  mkdirSync(join(source, 'uimori.sqlite.codex'));
  writeFileSync(join(source, 'uimori.sqlite.codex', 'auth.json'), 'private-login');
  writeFileSync(join(source, 'uimori.sqlite.codex', 'state.sqlite'), 'private-conversation');
  writeFileSync(join(source, 'uimori.sqlite.codex', 'config.toml'), 'old-config');
  const target = join(root, 'fresh');
  assert.equal(copyCredentials(source, target).settingsRetained, false);
  assert.equal(
    readFileSync(join(target, 'uimori.sqlite.codex', 'auth.json'), 'utf8'),
    'private-login'
  );
  for (const name of [
    'uimori.sqlite',
    'uimori.sqlite.codex/state.sqlite',
    'uimori.sqlite.codex/config.toml',
  ])
    assert.equal(existsSync(join(target, name)), false);
  assert.throws(() => copyCredentials(source, target), /empty/);
});

test('actual-image hash matches build runner ordering and rejects altered artifacts', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'uimori-image-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'a'));
  writeFileSync(join(root, 'a', 'file.js'), 'nested');
  writeFileSync(join(root, 'a.js'), 'file');
  writeFileSync(join(root, 'Z.js'), 'uppercase');
  const hash = await distHash(root);
  assert.equal(artifactHash(root), hash);
  const build = 'a'.repeat(64);
  writeFileSync(
    join(root, 'build-identity.json'),
    JSON.stringify({ buildId: build, sourceHash: build, distHash: hash })
  );
  assert.equal(verifyIdentity(root, build, hash).buildId, build);
  assert.equal(verifyIdentity(root, build).distHash, hash);
  writeFileSync(join(root, 'a.js'), 'tampered');
  assert.throws(() => verifyIdentity(root, build, hash), /mismatch/);
});

test('persisted fresh-volume maintenance stays closed and is read without mutation', (t) => {
  const { source, db } = fixture(t);
  db.exec(
    "CREATE TABLE maintenance(id INTEGER PRIMARY KEY, status TEXT, reason TEXT, epoch INTEGER, updated_at TEXT); INSERT INTO maintenance VALUES (1,'open',NULL,0,'old')"
  );
  assert.equal(dataMaintenance(source).status, 'open');
  assert.equal(dataMaintenance(source, 'oracle:isolated-fresh').status, 'closed');
  assert.equal(dataMaintenance(source).reason, 'oracle:isolated-fresh');
  assert.throws(() => dataMaintenance(source, 'bad-owner'));
});
