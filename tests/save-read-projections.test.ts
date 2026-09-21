import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'vitest';
import { editDraftRevisions } from '../server/edit-draft-revisions.js';
import { assertPackageImageReferences } from '../server/package-image-references.js';
import { recordContentProfileEvents } from '../server/content-profile-events.js';
import type { PackageImage } from '../core/package-images.js';

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE versions(kind TEXT,id TEXT,revision INTEGER,body TEXT,
      PRIMARY KEY(kind,id,revision));
    CREATE TABLE edit_drafts(id TEXT PRIMARY KEY,kind TEXT,target_id TEXT,revision INTEGER,body TEXT);
    CREATE TABLE prompt_workspace(id INTEGER PRIMARY KEY,body TEXT);
    CREATE TABLE chats(id TEXT PRIMARY KEY,created_at TEXT);
    CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,chat_id TEXT,kind TEXT,entity_id TEXT,at TEXT);`);
  return db;
}
const image = (hash: string, mime: PackageImage['mime'] = 'image/png'): PackageImage => ({
  id: 'image',
  title: 'Image',
  description: '',
  blobHash: hash,
  mime,
  allowedUse: 'both',
});

function withDatabase(check: (db: DatabaseSync) => void) {
  const db = database();
  try {
    check(db);
  } finally {
    db.close();
  }
}

test('draft probes use indexed revisions, not draft/content JSON bodies', () =>
  withDatabase((db) => {
    db.prepare('INSERT INTO edit_drafts VALUES(?,?,?,?,?)').run('d', 'content', 'c', 7, 'not JSON');
    const insert = db.prepare('INSERT INTO versions VALUES(?,?,?,?)');
    insert.run('content', 'c', 1, 'also not JSON');
    insert.run('content', 'c', 3, 'never materialize');
    assert.deepEqual(editDraftRevisions(db, 'd'), { revision: 7, targetRevision: 3 });
    assert.deepEqual(editDraftRevisions(db, 'd'), { revision: 7, targetRevision: 3 });
    db.prepare('UPDATE edit_drafts SET revision=revision+1 WHERE id=?').run('d');
    assert.equal(editDraftRevisions(db, 'd').revision, 8);
  }));

test('new and missing targets remain distinguishable from a missing draft', () =>
  withDatabase((db) => {
    const insert = db.prepare('INSERT INTO edit_drafts VALUES(?,?,?,?,?)');
    insert.run('new', 'content', null, 1, '{}');
    insert.run('missing-target', 'content', 'gone', 2, '{}');
    assert.deepEqual(editDraftRevisions(db, 'new'), { revision: 1, targetRevision: null });
    assert.deepEqual(editDraftRevisions(db, 'missing-target'), {
      revision: 2,
      targetRevision: null,
    });
    assert.throws(() => editDraftRevisions(db, 'missing'), { statusCode: 404 });
  }));

test('workspace and preset probes follow their own revision authorities', () =>
  withDatabase((db) => {
    const insert = db.prepare('INSERT INTO edit_drafts VALUES(?,?,?,?,?)');
    insert.run('w', 'prompt-workspace', 'current', 2, '{}');
    insert.run('p', 'prompt-preset', 'p', 3, '{}');
    db.prepare('INSERT INTO prompt_workspace VALUES(1,?)').run(JSON.stringify({ revision: 9 }));
    db.prepare('INSERT INTO versions VALUES(?,?,?,?)').run('prompt-preset', 'p', 5, '{}');
    db.prepare('INSERT INTO versions VALUES(?,?,?,?)').run('content', 'p', 99, '{}');
    assert.deepEqual(editDraftRevisions(db, 'w'), { revision: 2, targetRevision: 9 });
    assert.deepEqual(editDraftRevisions(db, 'p'), { revision: 3, targetRevision: 5 });
  }));

test('image aliases reuse metadata reads and never return the Base64 body to JS', () =>
  withDatabase((db) => {
    const hash = 'a'.repeat(64);
    db.prepare('INSERT INTO versions VALUES(?,?,?,?)').run(
      'package-image',
      hash,
      1,
      JSON.stringify({ hash, mime: 'image/png', base64: 'A'.repeat(250_000) })
    );
    let reads = 0;
    const observed = new Proxy(db, {
      get(target, key) {
        if (key !== 'prepare') return Reflect.get(target, key, target);
        return (sql: string) => {
          const statement = target.prepare(sql),
            get = statement.get.bind(statement);
          statement.get = (...args) => {
            reads++;
            const row = Reflect.apply(get, statement, args);
            assert.deepEqual(Object.keys(row ?? {}).sort(), ['hash', 'mime']);
            return row;
          };
          return statement;
        };
      },
    });
    assertPackageImageReferences(observed, [image(hash), { ...image(hash), id: 'alias' }]);
    assert.equal(reads, 1);
  }));

test('every image alias still checks its claimed MIME, even after a cache hit', () =>
  withDatabase((db) => {
    const hash = 'b'.repeat(64);
    db.prepare('INSERT INTO versions VALUES(?,?,?,?)').run(
      'package-image',
      hash,
      1,
      JSON.stringify({ hash, mime: 'image/png', base64: '' })
    );
    assert.throws(
      () => assertPackageImageReferences(db, [image(hash), image(hash, 'image/jpeg')]),
      { statusCode: 400, message: 'Package image reference mismatch' }
    );
  }));

test('missing images, wrong revisions and stored hash mismatches still fail', () =>
  withDatabase((db) => {
    const hash = 'c'.repeat(64),
      insert = db.prepare('INSERT INTO versions VALUES(?,?,?,?)');
    assertPackageImageReferences(db, []);
    assert.throws(() => assertPackageImageReferences(db, [image(hash)]), { statusCode: 404 });
    insert.run('package-image', hash, 2, JSON.stringify({ hash, mime: 'image/png' }));
    assert.throws(() => assertPackageImageReferences(db, [image(hash)]), { statusCode: 404 });
    insert.run(
      'package-image',
      hash,
      1,
      JSON.stringify({ hash: 'd'.repeat(64), mime: 'image/png' })
    );
    assert.throws(() => assertPackageImageReferences(db, [image(hash)]), { statusCode: 400 });
  }));

test('bulk profile invalidation retains chat membership and admission order', () =>
  withDatabase((db) => {
    const insert = db.prepare('INSERT INTO chats VALUES(?,?)');
    insert.run('b', '2026-01-02');
    insert.run('z', '2026-01-01');
    insert.run('a', '2026-01-02');
    recordContentProfileEvents(db);
    const rows = db.prepare('SELECT chat_id,kind,entity_id,at FROM events ORDER BY seq').all();
    assert.deepEqual(
      rows.map((r) => [r.chat_id, r.kind, r.entity_id]),
      [
        ['z', 'profile.updated', 'z'],
        ['a', 'profile.updated', 'a'],
        ['b', 'profile.updated', 'b'],
      ]
    );
    assert.ok(rows.every((r) => Number.isFinite(Date.parse(String(r.at)))));
  }));

test('profile invalidation participates in rollback and works with an empty library', () =>
  withDatabase((db) => {
    recordContentProfileEvents(db);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get()!.n, 0);
    db.exec("INSERT INTO chats VALUES('a','2026-01-01'); BEGIN");
    recordContentProfileEvents(db);
    db.exec('ROLLBACK');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get()!.n, 0);
  }));
