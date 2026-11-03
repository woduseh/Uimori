import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
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
    } catch {
      /* Already closed for stopped-copy verification. */
    }
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

for (const change of ['logout', 'login', 'authority']) {
  test(`rollback preserves the candidate when ${change} changed session authority after backup`, (t) => {
    const { root, source, db } = fixture(t);
    db.exec(`
      CREATE TABLE access_sessions(token_hash TEXT PRIMARY KEY,authority_hash TEXT NOT NULL);
      CREATE TABLE push_subscriptions(id TEXT PRIMARY KEY,session_hash TEXT REFERENCES access_sessions(token_hash) ON DELETE CASCADE);
      INSERT INTO access_sessions VALUES('device','authority');
      INSERT INTO push_subscriptions VALUES('subscription','device');
    `);
    db.close();
    const target = join(root, 'backup');
    copyStoppedData(source, target);
    const backup = readFileSync(join(target, 'uimori.sqlite'));
    const changed = new DatabaseSync(join(source, 'uimori.sqlite'));
    changed.exec('PRAGMA foreign_keys=ON');
    if (change === 'logout') changed.exec("DELETE FROM access_sessions WHERE token_hash='device'");
    if (change === 'login')
      changed.exec("INSERT INTO access_sessions VALUES('new-device','authority')");
    if (change === 'authority')
      changed.exec("UPDATE access_sessions SET authority_hash='changed-authority'");
    const sessions = changed.prepare('SELECT * FROM access_sessions ORDER BY token_hash').all();
    const subscriptions = changed.prepare('SELECT * FROM push_subscriptions').all();
    changed.close();
    const candidate = readFileSync(join(source, 'uimori.sqlite'));
    writeFileSync(join(source, 'candidate-only'), 'preserve');

    assert.throws(() => restoreData(target, source), /Session authority changed/);
    assert.deepEqual(readFileSync(join(source, 'uimori.sqlite')), candidate);
    assert.deepEqual(readFileSync(join(target, 'uimori.sqlite')), backup);
    assert.equal(readFileSync(join(source, 'candidate-only'), 'utf8'), 'preserve');
    const preserved = new DatabaseSync(join(source, 'uimori.sqlite'), { readOnly: true });
    try {
      assert.deepEqual(
        preserved.prepare('SELECT * FROM access_sessions ORDER BY token_hash').all(),
        sessions
      );
      assert.deepEqual(preserved.prepare('SELECT * FROM push_subscriptions').all(), subscriptions);
    } finally {
      preserved.close();
    }
  });
}

test('a temporary control login removed before rollback does not prevent restoration', (t) => {
  const { root, source, db } = fixture(t);
  db.exec(
    "CREATE TABLE access_sessions(token_hash TEXT PRIMARY KEY,authority_hash TEXT NOT NULL); INSERT INTO access_sessions VALUES('device','authority')"
  );
  db.close();
  const target = join(root, 'backup');
  copyStoppedData(source, target);
  const changed = new DatabaseSync(join(source, 'uimori.sqlite'));
  changed.exec(
    "INSERT INTO access_sessions VALUES('control','authority'); DELETE FROM access_sessions WHERE token_hash='control'; UPDATE future_jobs SET body='candidate'"
  );
  changed.close();
  restoreData(target, source);
  const restored = new DatabaseSync(join(source, 'uimori.sqlite'), { readOnly: true });
  try {
    assert.equal(restored.prepare('SELECT body FROM future_jobs').get().body, 'original');
    assert.equal(restored.prepare('SELECT count(*) AS count FROM access_sessions').get().count, 1);
  } finally {
    restored.close();
  }
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
