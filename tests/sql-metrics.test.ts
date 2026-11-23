import { expect, test } from 'vitest';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { instrumentDatabase, measureSql, type SqlUsage } from '../server/sql-metrics.js';

function database() {
  const db = instrumentDatabase(new DatabaseSync(':memory:'));
  db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO items(label) VALUES(?)');
  for (const label of ['one', 'two', 'three']) insert.run(label);
  return db;
}

test('counts statements and SQLite time only inside a measured scope', async () => {
  const db = database();
  const usage: SqlUsage = { statements: 0, elapsedMs: 0 };
  db.prepare('SELECT count(*) AS n FROM items').get();
  await measureSql(usage, async () => {
    db.prepare('SELECT label FROM items WHERE id=?').get(1);
    await Promise.resolve();
    db.prepare('SELECT label FROM items').all();
    db.prepare('UPDATE items SET label=? WHERE id=?').run('uno', 1);
    expect([...db.prepare('SELECT id FROM items ORDER BY id').iterate()]).toHaveLength(3);
    db.exec('SAVEPOINT measured; RELEASE measured');
  });
  db.prepare('SELECT count(*) AS n FROM items').get();
  expect(usage.statements).toBe(5);
  expect(usage.elapsedMs).toBeGreaterThan(0);
  db.close();
});

test('instrumented statements keep the native statement behavior', () => {
  const db = database();
  const statement = db.prepare('SELECT id, label FROM items WHERE id=?');
  expect(statement).toBeInstanceOf(StatementSync);
  expect(statement.sourceSQL).toBe('SELECT id, label FROM items WHERE id=?');
  expect(statement.columns().map((column) => column.name)).toEqual(['id', 'label']);
  statement.setReadBigInts(true);
  expect(statement.get(2)).toEqual({ id: 2n, label: 'two' });
  statement.setReadBigInts(false);
  measureSql({ statements: 0, elapsedMs: 0 }, () => {
    expect(statement.all(3)).toEqual([{ id: 3, label: 'three' }]);
    expect(Array.from(statement.iterate(1))).toEqual([{ id: 1, label: 'one' }]);
    expect(statement.expandedSQL).toBe('SELECT id, label FROM items WHERE id=1.0');
  });
  expect(() => db.prepare('SELECT missing FROM items')).toThrow(/no such column/);
  db.close();
});
