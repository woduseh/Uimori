import { expect, test } from 'vitest';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { instrumentDatabase, measureSql } from '../server/sql-metrics.js';

function database() {
  const db = instrumentDatabase(new DatabaseSync(':memory:'));
  db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO items(label) VALUES(?)');
  for (const label of ['one', 'two', 'three']) insert.run(label);
  return db;
}

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
