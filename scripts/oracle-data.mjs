import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  chownSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const database = 'narrative.sqlite';
const credentials = [`${database}.vertex-credentials`, `${database}.codex/auth.json`];
const quote = (name) => `"${name.replaceAll('"', '""')}"`;

// Discover status columns, rather than maintaining a schema-version table manifest.
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
          `SELECT count(*) AS count FROM ${quote(name)} WHERE status IN ('queued','running','waiting_for_state')`
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

// Called only after the old application stops. Keep every companion file for rollback.
export function copyStoppedData(source, destination) {
  emptyDestination(source, destination);
  safeTree(source);
  for (const name of readdirSync(source))
    copyWithOwnership(join(source, name), join(destination, name));
  return { copied: true };
}

export function restoreData(source, destination) {
  // Validate the complete backup before changing the live volume.
  inspectData(source, { integrity: true });
  safeTree(source);
  assertSeparate(source, destination);
  safeTree(destination);
  for (const name of readdirSync(destination)) rmSync(join(destination, name), { recursive: true });
  return copyStoppedData(source, destination);
}

// Fresh retains only service-account credentials and Codex login, never Codex sessions/config.
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
    await backup(db, join(destination, database));
  } finally {
    db.close();
  }
  if (process.getuid?.() === 0) {
    chownSync(destination, 1000, 1000);
    chownSync(join(destination, database), 1000, 1000);
  }
  // The online backup is coherent even when SQLite uses WAL.
  return inspectData(destination, { integrity: true });
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
  };
  if (!actions[command])
    throw new Error('Expected inspect, audit, backup, restore, credentials, or snapshot');
  console.log(JSON.stringify(await actions[command]()));
}
