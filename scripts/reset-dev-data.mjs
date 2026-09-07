import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, readdirSync, realpathSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The CLI intentionally has no path or environment override. It resets only this
// checkout's default disposable development database, never an arbitrary NR_DB.
const repository = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const directory = join(repository, '.local');
const database = join(directory, 'narrative.sqlite');
const baseNames =
  /^narrative\.sqlite(?:\.pre-(?:m1|v3|m2|native|organization|behavior)-[0-9]+-[a-f0-9]{8}\.sqlite)?$/u;
const candidateBase = (name) => name.replace(/-(?:wal|shm|journal)$/u, '');
const owned = [],
  removed = [];

function checkedDirectory() {
  const info = lstatSync(directory),
    actual = realpathSync(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    actual !== directory ||
    dirname(actual) !== repository
  )
    throw new Error('DEV_RESET_UNSAFE_DIRECTORY');
}
function checkedFile(path, missing = false) {
  checkedDirectory();
  const absolute = resolve(path),
    within = relative(directory, absolute);
  if (!within || isAbsolute(within) || within.startsWith('..') || dirname(absolute) !== directory)
    throw new Error('DEV_RESET_UNSAFE_TARGET');
  if (!existsSync(absolute)) {
    // existsSync follows links, so explicitly reject dangling symbolic links.
    try {
      lstatSync(absolute);
    } catch (error) {
      if (missing && error.code === 'ENOENT') return absolute;
      throw error;
    }
    throw new Error('DEV_RESET_UNSAFE_TARGET');
  }
  const info = lstatSync(absolute);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink > 1 ||
    realpathSync(absolute) !== absolute
  )
    throw new Error('DEV_RESET_UNSAFE_TARGET');
  return absolute;
}
function acquire(base) {
  const path = checkedFile(join(directory, `${base}.owner.sqlite`), true),
    mutex = new DatabaseSync(path);
  try {
    mutex.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
  } catch (error) {
    mutex.close();
    throw new Error(`DEV_DATABASE_OWNER_UNAVAILABLE: ${base}; stop its server before reset.`, {
      cause: error,
    });
  }
  owned.push(mutex);
}

try {
  if (process.argv.length !== 2)
    throw new Error('DEV_RESET_FIXED_TARGET_ONLY: npm run reset:dev accepts no arguments.');
  if (!existsSync(directory)) {
    // A dangling .local link must not be mistaken for an absent directory.
    try {
      lstatSync(directory);
      throw new Error('DEV_RESET_UNSAFE_DIRECTORY');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    console.log(JSON.stringify({ status: 'empty', database, removed }));
  } else {
    checkedDirectory();
    const names = readdirSync(directory)
      .filter((name) => baseNames.test(candidateBase(name)))
      .sort();
    const targets = names.map((name) => checkedFile(join(directory, name)));
    // Acquire every affected DB's existing ownership protocol before deleting
    // anything, including an old pre-upgrade copy opened by another process.
    const bases = new Set(['narrative.sqlite', ...names.map(candidateBase)]);
    for (const base of bases) acquire(base);
    for (const path of targets) {
      unlinkSync(checkedFile(path));
      removed.push(basename(path));
    }
    // Keep mutex files in place: unlinking a lifetime mutex would let another
    // process lock a new inode while an old owner still holds the previous one.
    console.log(
      JSON.stringify({
        status: removed.length ? 'reset' : 'empty',
        database,
        removed,
        retained: 'SQLite ownership mutex files',
      })
    );
  }
} catch (error) {
  console.error(
    JSON.stringify({
      status: 'error',
      database,
      removed,
      error: error instanceof Error ? error.message : 'DEV_RESET_FAILED',
    })
  );
  process.exitCode = 1;
} finally {
  for (const mutex of owned.reverse()) mutex.close();
}
