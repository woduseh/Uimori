import { DatabaseSync, backup } from 'node:sqlite';
import { mkdtempSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Explicit offline maintenance. No guessed DB path, reset, VACUUM or provider execution. */
export async function optimizeDatabaseFile(path, { apply = false } = {}) {
  if (typeof path !== 'string' || !path.trim())
    throw new Error('An explicit --db path is required');
  const canonical = realpathSync(path);
  if (!statSync(canonical).isFile())
    throw new Error('The database path must name an existing file');
  const { inspectDatabasePerformance, optimizeDatabasePerformance } = await import(
    '../dist/server/database-performance.js'
  );
  const { DATABASE_SCHEMA_VERSION } = await import('../dist/server/database-schema.js');
  let ownership;
  let db;
  try {
    if (apply) {
      // Same canonical path and lifetime lock as Store. It fails while a server owns the DB.
      ownership = new DatabaseSync(`${canonical}.owner.sqlite`);
      ownership.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    }
    db = new DatabaseSync(canonical, { readOnly: !apply });
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0');
    const before = inspectDatabasePerformance(db, DATABASE_SCHEMA_VERSION);
    if (!apply || before.optimized)
      return { database: canonical, ...before, changed: false, backup: null };
    // mkdtemp creates a new private directory: the SQLite backup cannot overwrite an old backup.
    const directory = mkdtempSync(join(dirname(canonical), 'uimori-performance-backup-'));
    const backupPath = join(directory, 'before.sqlite');
    await backup(db, backupPath);
    const saved = new DatabaseSync(backupPath, { readOnly: true });
    try {
      if (saved.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok')
        throw new Error(`Backup verification failed; original DB unchanged. Backup: ${backupPath}`);
      inspectDatabasePerformance(saved, DATABASE_SCHEMA_VERSION);
    } finally {
      saved.close();
    }
    try {
      const result = optimizeDatabasePerformance(db, DATABASE_SCHEMA_VERSION);
      return {
        database: canonical,
        ...inspectDatabasePerformance(db, DATABASE_SCHEMA_VERSION),
        ...result,
        backup: backupPath,
      };
    } catch (error) {
      throw new Error(`Optimization failed; transaction rolled back. Backup: ${backupPath}`, {
        cause: error,
      });
    }
  } finally {
    db?.close();
    ownership?.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const help =
    'Usage: node scripts/optimize-database.mjs --db <existing.sqlite> [--apply]\nWithout --apply this only reports the current optimization state. Stop the server before applying.';
  if (args.length === 1 && args[0] === '--help') return console.log(help);
  if (
    ![2, 3].includes(args.length) ||
    args[0] !== '--db' ||
    !args[1] ||
    (args.length === 3 && args[2] !== '--apply')
  )
    throw new Error(help);
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 14) throw new Error('Use the project Node 24 runtime (>=24.14.0).');
  console.log(
    JSON.stringify(await optimizeDatabaseFile(args[1], { apply: args[2] === '--apply' }), null, 2)
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message);
    if (error.cause instanceof Error) console.error(error.cause.message);
    process.exitCode = 1;
  });
