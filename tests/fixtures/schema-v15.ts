import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

type FrozenValue = string | number | null | { base64: string };

/** Frozen before migrations existed; never reconstruct old storage using today's Store. */
export function createFrozenSchema15(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(new URL('./schema-v15.sql', import.meta.url), 'utf8'));
  const data = JSON.parse(
    readFileSync(new URL('./schema-v15-data.json', import.meta.url), 'utf8')
  ) as Record<string, Record<string, FrozenValue>[]>;
  db.exec('PRAGMA foreign_keys=ON; BEGIN; PRAGMA defer_foreign_keys=ON;');
  try {
    for (const [table, rows] of Object.entries(data))
      for (const row of rows) {
        const keys = Object.keys(row);
        db.prepare(
          `INSERT INTO "${table}"(${keys.map((key) => `"${key}"`).join(',')}) VALUES(${keys.map(() => '?').join(',')})`
        ).run(
          ...keys.map((key) => {
            const value = row[key];
            return value && typeof value === 'object' ? Buffer.from(value.base64, 'base64') : value;
          })
        );
      }
    db.exec('COMMIT');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
