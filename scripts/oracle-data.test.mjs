import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  copyCredentials,
  copyStoppedData,
  inspectData,
  migrateSchema23To24,
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

test('schema 23 migration rewrites only package contracts and native instruction fields', (t) => {
  const { root, source, db } = fixture(t);
  db.exec(`DROP TABLE future_jobs;
    CREATE TABLE schema_metadata(id INTEGER PRIMARY KEY CHECK(id=1),baseline TEXT NOT NULL,signature TEXT NOT NULL);
    INSERT INTO schema_metadata VALUES(1,'uimori-risu-native','fixture-signature');
    CREATE TABLE versions(id TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE runs(id TEXT PRIMARY KEY,snapshot TEXT NOT NULL);
    CREATE TABLE snapshot_texts(hash TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TRIGGER runs_snapshot_update AFTER UPDATE OF snapshot ON runs
      WHEN json_type(NEW.snapshot,'$.__snapshot_texts_v1') IS NULL
      BEGIN UPDATE runs SET snapshot=snapshot_pack(NEW.snapshot) WHERE rowid=NEW.rowid; END;
    PRAGMA user_version=23;`);
  const pkg = {
    version: 1,
    id: 'card',
    revision: 3,
    title: 'Card',
    description: '',
    lore: [],
    instructions: [{ id: 'old', target: 'main', text: 'retired' }],
    nativeRisu: { version: 1 },
  };
  db.prepare('INSERT INTO versions VALUES(?,?)').run(
    'content',
    JSON.stringify({ package: pkg, unrelated: { version: 1, instructions: ['keep'] } })
  );
  const retired = 'retired '.repeat(80);
  const retiredBody = JSON.stringify(retired);
  const retiredHash = createHash('sha256').update(retiredBody).digest('hex');
  db.prepare('INSERT INTO snapshot_texts VALUES(?,?)').run(retiredHash, retiredBody);
  const snapshot = {
    profile: { packages: [structuredClone(pkg)] },
    nativeRisuExecution: {
      version: 2,
      inputHash: 'hash',
      variables: {},
      messages: [],
      fields: { 'card@3:bot': { body: 'body', 'instruction:old': '' } },
    },
  };
  snapshot.profile.packages[0].instructions[0].text = '';
  snapshot.__snapshot_texts_v1 = {
    '["profile","packages","0","instructions","0","text"]': retiredHash,
    '["nativeRisuExecution","fields","card@3:bot","instruction:old"]': retiredHash,
  };
  db.prepare('INSERT INTO runs VALUES(?,?)').run('run', JSON.stringify(snapshot));
  db.close();
  writeFileSync(join(source, 'uimori.sqlite.owner.sqlite'), 'ephemeral owner');
  writeFileSync(join(source, 'uimori.sqlite.owner.sqlite-shm'), 'ephemeral shared memory');

  const target = join(root, 'migrated');
  copyStoppedData(source, target);
  const result = migrateSchema23To24(target);
  assert.deepEqual(result, {
    from: 23,
    to: 24,
    packages: 2,
    executionFields: 1,
    rows: 2,
    ownerFilesReset: 2,
    integrity: 'ok',
  });
  assert.equal(existsSync(join(target, 'uimori.sqlite.owner.sqlite')), false);
  assert.equal(existsSync(join(target, 'uimori.sqlite.owner.sqlite-shm')), false);
  assert.equal(existsSync(join(source, 'uimori.sqlite.owner.sqlite')), true);
  assert.equal(inspectData(source).schema, 23);
  const migrated = new DatabaseSync(join(target, 'uimori.sqlite'), { readOnly: true });
  try {
    const content = JSON.parse(migrated.prepare('SELECT body FROM versions').get().body);
    assert.equal(content.package.version, 2);
    assert.equal('instructions' in content.package, false);
    assert.deepEqual(content.unrelated.instructions, ['keep']);
    const snapshot = JSON.parse(migrated.prepare('SELECT snapshot FROM runs').get().snapshot);
    assert.deepEqual(snapshot.__snapshot_texts_v1, {});
    assert.equal('instruction:old' in snapshot.nativeRisuExecution.fields['card@3:bot'], false);
  } finally {
    migrated.close();
  }
  assert.throws(() => migrateSchema23To24(target), /Schema 23 source required/);
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
  writeFileSync(join(root, 'a.js'), 'tampered');
  assert.throws(() => verifyIdentity(root, build, hash), /mismatch/);
});
