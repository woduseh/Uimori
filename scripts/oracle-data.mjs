import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
} from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const database = 'uimori.sqlite';
const credentials = [`${database}.vertex-credentials`, `${database}.codex/auth.json`];
const quote = (name) => `"${name.replaceAll('"', '""')}"`;

export function inspectData(directory, { integrity = false, idle = true, columns = false } = {}) {
  const db = new DatabaseSync(join(directory, database), { readOnly: true });
  try {
    const active = {};
    const tableColumns = {};
    for (const { name } of db
      .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()) {
      const info = db.prepare(`PRAGMA table_info(${quote(name)})`).all();
      if (columns)
        tableColumns[name] = Object.fromEntries(
          info.map(({ name, type, notnull, pk }) => [
            name,
            { type: type.toUpperCase(), notnull, pk },
          ])
        );
      if (!info.some((column) => column.name === 'status')) continue;
      const { count } = db
        .prepare(
          `SELECT count(*) AS count FROM ${quote(name)} WHERE status IN ('queued','running')`
        )
        .get();
      if (count) active[name] = count;
    }
    const result = { schema: db.prepare('PRAGMA user_version').get().user_version, active };
    if (columns) result.columns = tableColumns;
    if (idle && Object.keys(active).length)
      throw new Error(`Active work prevents deployment: ${JSON.stringify(active)}`);
    if (integrity) {
      if (
        db.prepare('PRAGMA quick_check').get().quick_check !== 'ok' ||
        db.prepare('PRAGMA foreign_key_check').all().length
      )
        throw new Error('Database integrity check failed');
      result.integrity = 'ok';
    }
    return result;
  } finally {
    db.close();
  }
}

function safeTree(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
    throw new Error('Unsupported data file type');
  if (stat.isDirectory()) for (const name of readdirSync(path)) safeTree(join(path, name));
}

function assertSeparate(source, destination) {
  const nested = (a, b) => {
    const path = relative(a, b);
    return path === '' || (!path.startsWith('..') && !isAbsolute(path));
  };
  if (
    nested(resolve(source), resolve(destination)) ||
    nested(resolve(destination), resolve(source))
  )
    throw new Error('Overlapping data directories');
}

function emptyDestination(source, destination) {
  source = resolve(source);
  destination = resolve(destination);
  assertSeparate(source, destination);
  if (lstatSync(source).isSymbolicLink()) throw new Error('Symlink data directory refused');
  mkdirSync(destination, { recursive: true });
  if (lstatSync(destination).isSymbolicLink()) throw new Error('Symlink data directory refused');
  if (readdirSync(destination).some((name) => name !== '.uimori-data'))
    throw new Error('Destination must be empty');
}

export function credentialDigest(directory) {
  const hash = createHash('sha256');
  function visit(file) {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error('Symlink credential refused');
    if (stat.isDirectory()) for (const name of readdirSync(file).sort()) visit(join(file, name));
    else if (stat.isFile()) {
      hash.update(relative(directory, file).replaceAll('\\', '/') + '\0');
      hash.update(readFileSync(file));
      hash.update('\0');
    } else throw new Error('Unsupported credential file type');
  }
  for (const name of credentials) {
    const parts = name.split('/');
    let file = directory;
    for (const part of parts) {
      file = join(file, part);
      if (existsSync(file) && lstatSync(file).isSymbolicLink())
        throw new Error('Symlink credential refused');
    }
    if (existsSync(file)) visit(file);
  }
  return { hash: hash.digest('hex') };
}

function copyWithOwnership(source, destination) {
  cpSync(source, destination, { recursive: true });
  function visit(from, to) {
    const stat = lstatSync(from);
    if (process.getuid?.() === 0) chownSync(to, stat.uid, stat.gid);
    if (stat.isDirectory())
      for (const name of readdirSync(from)) visit(join(from, name), join(to, name));
  }
  visit(source, destination);
}

export function copyStoppedData(source, destination) {
  emptyDestination(source, destination);
  safeTree(source);
  for (const name of readdirSync(source))
    copyWithOwnership(join(source, name), join(destination, name));
  const database = inspectData(destination, { integrity: true });
  return { copied: true, integrity: database.integrity };
}

function sessionAuthority(directory) {
  const db = new DatabaseSync(join(directory, database), { readOnly: true });
  try {
    if (
      !db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='access_sessions'").get()
    )
      return null;
    return JSON.stringify(
      db.prepare('SELECT token_hash,authority_hash FROM access_sessions ORDER BY token_hash').all()
    );
  } finally {
    db.close();
  }
}

export function restoreData(source, destination) {
  inspectData(source, { integrity: true });
  safeTree(source);
  assertSeparate(source, destination);
  safeTree(destination);
  if (sessionAuthority(source) !== sessionAuthority(destination))
    throw new Error(
      'Session authority changed after backup; rollback refused to preserve login/logout changes'
    );
  for (const name of readdirSync(destination)) rmSync(join(destination, name), { recursive: true });
  return copyStoppedData(source, destination);
}

export function copyCredentials(source, destination) {
  emptyDestination(source, destination);
  const before = credentialDigest(source);
  const copied = [];
  for (const name of credentials) {
    const file = join(source, name);
    if (!existsSync(file)) continue;
    safeTree(file);
    mkdirSync(resolve(destination, name, '..'), { recursive: true });
    copyWithOwnership(file, join(destination, name));
    copied.push(name);
  }
  if (process.getuid?.() === 0) {
    chownSync(destination, 1000, 1000);
    if (existsSync(join(destination, `${database}.codex`)))
      chownSync(join(destination, `${database}.codex`), 1000, 1000);
  }
  if (credentialDigest(destination).hash !== before.hash)
    throw new Error('Credential copy mismatch');
  return { copied, hash: before.hash, settingsRetained: false };
}

export async function snapshotDatabase(source, destination) {
  emptyDestination(source, destination);
  inspectData(source);
  const db = new DatabaseSync(join(source, database), { readOnly: true });
  try {
    // https://sqlite.org/backup.html#using_the_sqlite_online_backup_api (2026-11-20): a completed
    // online backup is a bit-wise identical copy of the source database as it was when copying
    // began.
    await backup(db, join(destination, database));
  } finally {
    db.close();
  }
  if (process.getuid?.() === 0) {
    chownSync(destination, 1000, 1000);
    chownSync(join(destination, database), 1000, 1000);
  }
  return inspectData(destination, { integrity: true });
}

function contentIdentity(db) {
  const schema = db
    .prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name')
    .all();
  return JSON.stringify({
    version: db.prepare('PRAGMA user_version').get().user_version,
    schema,
    rows: schema
      .filter((entry) => entry.type === 'table')
      .map((entry) => db.prepare(`SELECT count(*) AS count FROM ${quote(entry.name)}`).get().count),
  });
}

export function compactDatabase(
  directory,
  { minFreeRatio = 0.2, minFreeBytes = 64 * 1024 * 1024, swapDeadlineMs = 15 * 60_000 } = {}
) {
  const file = join(directory, database);
  const copy = `${file}.compact`;
  const started = Date.now();
  const db = new DatabaseSync(file);
  let measured;
  let identity;
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const pragma = (name) => Number(Object.values(db.prepare(`PRAGMA ${name}`).get())[0]);
    const pageSize = pragma('page_size');
    const pages = pragma('page_count');
    const free = pragma('freelist_count');
    measured = {
      beforeBytes: pages * pageSize,
      freeBytes: free * pageSize,
      freeRatio: pages ? Math.round((free / pages) * 1000) / 1000 : 0,
    };
    if (measured.freeRatio < minFreeRatio || measured.freeBytes < minFreeBytes)
      return { compacted: false, reason: 'below-threshold', ...measured };
    const disk = statfsSync(directory);
    if (
      Number(disk.bavail) * Number(disk.bsize) <
      (measured.beforeBytes - measured.freeBytes) * 1.1
    )
      return { compacted: false, reason: 'insufficient-disk', ...measured };
    rmSync(copy, { force: true });
    identity = contentIdentity(db);
    db.prepare('VACUUM INTO ?').run(copy);
  } finally {
    db.close();
  }
  try {
    const compacted = new DatabaseSync(copy, { readOnly: true });
    try {
      if (
        compacted.prepare('PRAGMA quick_check').get().quick_check !== 'ok' ||
        compacted.prepare('PRAGMA foreign_key_check').all().length ||
        contentIdentity(compacted) !== identity
      )
        throw new Error('Compacted database differs from its source');
    } finally {
      compacted.close();
    }
    if (Date.now() - started > swapDeadlineMs) {
      rmSync(copy, { force: true });
      return { compacted: false, reason: 'too-slow', ...measured };
    }
    const original = lstatSync(file);
    const descriptor = openSync(copy, 'r+');
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    if (process.getuid?.() === 0) chownSync(copy, original.uid, original.gid);
    chmodSync(copy, original.mode & 0o7777);
    for (const suffix of ['-wal', '-shm']) rmSync(file + suffix, { force: true });
    renameSync(copy, file);
  } catch (error) {
    rmSync(copy, { force: true });
    throw error;
  }
  return {
    compacted: true,
    ...measured,
    afterBytes: statSync(file).size,
    durationMs: Date.now() - started,
  };
}

export function dataMaintenance(directory, closeOwner) {
  const db = new DatabaseSync(join(directory, database), { readOnly: !closeOwner });
  try {
    if (closeOwner) {
      if (!closeOwner.startsWith('oracle:')) throw new Error('Invalid maintenance owner');
      db.prepare(
        "UPDATE maintenance SET status='closed', epoch=epoch+1, reason=?, updated_at=? WHERE id=1"
      ).run(closeOwner, new Date().toISOString());
    }
    const row = db.prepare('SELECT status, reason, epoch FROM maintenance WHERE id=1').get();
    if (!row) throw new Error('Maintenance row missing');
    return row;
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, source = '/data', destination = '/backup'] = process.argv.slice(2);
  const actions = {
    inspect: () => inspectData(source),
    audit: () => inspectData(source, { integrity: true, idle: false }),
    backup: () => copyStoppedData(source, destination),
    restore: () => restoreData(source, destination),
    credentials: () => copyCredentials(source, destination),
    'credential-digest': () => credentialDigest(source),
    snapshot: () => snapshotDatabase(source, destination),
    compact: () => compactDatabase(source),
    maintenance: () => dataMaintenance(source),
    'close-maintenance': () => {
      if (!process.env.UIMORI_MAINTENANCE_OWNER) throw new Error('Missing maintenance owner');
      return dataMaintenance(source, process.env.UIMORI_MAINTENANCE_OWNER);
    },
  };
  if (!actions[command])
    throw new Error('Expected inspect, audit, backup, restore, credentials, or snapshot');
  console.log(JSON.stringify(await actions[command]()));
}
