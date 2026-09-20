import { expect, test } from 'vitest';
import { SnapshotDatabase, initSnapshotStorage } from '../server/snapshot-database.js';

const tables = [
  'runs',
  'context_checkpoints',
  'context_jobs',
  'helper_tasks',
  'helper_artifact_jobs',
  'helper_artifacts',
];
function database() {
  const db = new SnapshotDatabase(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const table of tables)
    db.exec(`CREATE TABLE ${table}(id TEXT, revision INTEGER, snapshot TEXT NOT NULL)`);
  initSnapshotStorage(db);
  return db;
}
const content = '한글 😀 \r\n " exact text '.repeat(1000);
test('shares exact text across stages and tables, hydrates rows and preserves metadata-only reads', () => {
  const db = database();
  try {
    const original = {
      history: [{ text: content }],
      native: { messages: [{ data: content }] },
      status: 'prepared',
    };
    for (const table of tables)
      db.prepare(`INSERT INTO ${table} VALUES(?,?,?)`).run('same', 1, JSON.stringify(original));
    expect(db.prepare('SELECT count(*) AS n FROM snapshot_texts').get()?.n).toBe(1);
    for (const table of tables) {
      expect(
        JSON.parse(String(db.prepare(`SELECT snapshot FROM ${table}`).get()?.snapshot))
      ).toEqual(original);
      expect(
        db.prepare(`SELECT json_extract(snapshot,'$.status') AS status FROM ${table}`).get()?.status
      ).toBe('prepared');
      expect(
        db
          .prepare(`SELECT snapshot_text(snapshot,'["history","0","text"]') AS text FROM ${table}`)
          .get()?.text
      ).toBe(content);
    }
    const stored = Number(db.prepare('SELECT length(snapshot) AS bytes FROM runs').get()?.bytes);
    expect(stored).toBeLessThan(JSON.stringify(original).length / 10);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    db.close();
  }
});
test('encoded SQL copies and composite revisions retain text until the last reference is deleted', () => {
  const db = database();
  try {
    db.prepare('INSERT INTO runs VALUES(?,?,?)').run('a', 1, JSON.stringify({ text: content }));
    db.exec(
      "INSERT INTO helper_artifacts SELECT 'same',1,snapshot FROM runs; INSERT INTO helper_artifacts SELECT 'same',2,snapshot FROM runs; DELETE FROM runs"
    );
    expect(db.prepare('SELECT count(*) AS n FROM snapshot_texts').get()?.n).toBe(1);
    db.exec('DELETE FROM helper_artifacts WHERE revision=1');
    expect(
      JSON.parse(String(db.prepare('SELECT snapshot FROM helper_artifacts').get()?.snapshot)).text
    ).toBe(content);
    db.exec('DELETE FROM helper_artifacts');
    expect(db.prepare('SELECT count(*) AS n FROM snapshot_texts').get()?.n).toBe(0);
  } finally {
    db.close();
  }
});
test('replacement, rollback and immutable pool keep references consistent', () => {
  const db = database();
  try {
    db.prepare('INSERT INTO runs VALUES(?,?,?)').run('a', 1, JSON.stringify({ text: content }));
    expect(() => db.exec("UPDATE snapshot_texts SET body='corrupt'")).toThrow('Immutable');
    db.exec('BEGIN');
    db.prepare('UPDATE runs SET snapshot=?').run(JSON.stringify({ text: content + 'changed' }));
    db.exec('ROLLBACK');
    expect(JSON.parse(String(db.prepare('SELECT snapshot FROM runs').get()?.snapshot)).text).toBe(
      content
    );
    expect(db.prepare('SELECT count(*) AS n FROM snapshot_texts').get()?.n).toBe(1);
    db.prepare('UPDATE runs SET snapshot=?').run(JSON.stringify({ text: 'short' }));
    expect(db.prepare('SELECT count(*) AS n FROM snapshot_texts').get()?.n).toBe(0);
  } finally {
    db.close();
  }
});

test('packing before row allocation stays atomic when the outer insert fails', () => {
  const db = database();
  try {
    db.exec('CREATE UNIQUE INDEX runs_identity ON runs(id)');
    db.prepare('INSERT INTO runs VALUES(?,1,snapshot_pack(?))').run(
      'one',
      JSON.stringify({ text: content })
    );
    const pages = Number(db.prepare('PRAGMA page_count').get()?.page_count);
    expect(() =>
      db
        .prepare('INSERT INTO runs VALUES(?,1,snapshot_pack(?))')
        .run('one', JSON.stringify({ text: content + 'different' }))
    ).toThrow();
    expect(db.prepare('SELECT count(*) AS n FROM snapshot_texts').get()?.n).toBe(1);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(pages * 4096).toBeLessThan(Buffer.byteLength(content) * 5);
  } finally {
    db.close();
  }
});
