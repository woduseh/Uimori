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

const database = 'uimori.sqlite';
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

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const snapshotRefsKey = '__snapshot_texts_v1';
const snapshotDigest = (body) => createHash('sha256').update(body).digest('hex');

function readSnapshotText(db, hash) {
  const row = db.prepare('SELECT body FROM snapshot_texts WHERE hash=?').get(hash);
  if (!row || typeof row.body !== 'string' || snapshotDigest(row.body) !== hash)
    throw new Error('Snapshot text integrity failed during migration');
  const value = JSON.parse(row.body);
  if (typeof value !== 'string') throw new Error('Snapshot text is not a string');
  return value;
}

function expandSnapshot(db, value) {
  if (!record(value) || !Object.hasOwn(value, snapshotRefsKey)) return value;
  const refs = value[snapshotRefsKey];
  if (!record(refs)) throw new Error('Snapshot references are invalid');
  const cache = new Map();
  for (const [path, hash] of Object.entries(refs)) {
    const keys = JSON.parse(path);
    if (
      typeof hash !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(hash) ||
      !Array.isArray(keys) ||
      !keys.length ||
      keys.some((key) => typeof key !== 'string')
    )
      throw new Error('Snapshot references are invalid');
    let node = value;
    for (const key of keys.slice(0, -1)) {
      if (!record(node) && !Array.isArray(node)) throw new Error('Snapshot path is invalid');
      node = node[key];
    }
    const key = keys.at(-1);
    if ((!record(node) && !Array.isArray(node)) || node[key] !== '')
      throw new Error('Snapshot path is invalid');
    if (!cache.has(hash)) cache.set(hash, readSnapshotText(db, hash));
    node[key] = cache.get(hash);
  }
  delete value[snapshotRefsKey];
  return value;
}

function installSnapshotPack(db) {
  db.function('snapshot_pack', (input) => {
    const snapshot = JSON.parse(String(input));
    const refs = {};
    const insert = db.prepare('INSERT OR IGNORE INTO snapshot_texts(hash,body) VALUES(?,?)');
    const seen = new Map();
    const visit = (node, path) => {
      if (!record(node) && !Array.isArray(node)) return;
      for (const [key, child] of Object.entries(node)) {
        if (typeof child === 'string' && child.length >= 256) {
          let hash = seen.get(child);
          if (!hash) {
            const body = JSON.stringify(child);
            hash = snapshotDigest(body);
            insert.run(hash, body);
            seen.set(child, hash);
          }
          refs[JSON.stringify([...path, key])] = hash;
          node[key] = '';
        } else if (record(child) || Array.isArray(child)) visit(child, [...path, key]);
      }
    };
    visit(snapshot, []);
    snapshot[snapshotRefsKey] = refs;
    return JSON.stringify(snapshot);
  });
}

function migrateJson23To24(value, counts) {
  if (Array.isArray(value)) {
    for (const item of value) migrateJson23To24(item, counts);
    return;
  }
  if (!record(value)) return;

  // Schema 24 deliberately drops authored package instructions. Match the complete
  // package envelope so ordinary objects with a version or instructions field stay opaque.
  if (
    value.version === 1 &&
    typeof value.id === 'string' &&
    Number.isSafeInteger(value.revision) &&
    typeof value.title === 'string' &&
    typeof value.description === 'string' &&
    Array.isArray(value.lore) &&
    Array.isArray(value.instructions) &&
    record(value.nativeRisu)
  ) {
    delete value.instructions;
    value.version = 2;
    counts.packages += 1;
  }

  // Frozen native receipts mirror package fields. Remove only the retired field
  // namespace; body, lore, starts, variables and historical output remain intact.
  if (
    typeof value.inputHash === 'string' &&
    record(value.variables) &&
    record(value.fields) &&
    Array.isArray(value.messages)
  ) {
    for (const fields of Object.values(value.fields)) {
      if (!record(fields)) continue;
      for (const key of Object.keys(fields)) {
        if (!key.startsWith('instruction:')) continue;
        delete fields[key];
        counts.executionFields += 1;
      }
    }
  }

  for (const item of Object.values(value)) migrateJson23To24(item, counts);
}

/** One-shot, offline data-contract migration. The caller must operate on a copied,
 * stopped data directory; this function never creates or replaces the source copy.
 */
export function migrateSchema23To24(directory) {
  const file = join(directory, database);
  let ownerFilesReset = 0;
  for (const suffix of [
    '.owner.sqlite',
    '.owner.sqlite-wal',
    '.owner.sqlite-shm',
    '.owner.sqlite-journal',
  ]) {
    const ownerFile = join(directory, database + suffix);
    if (!existsSync(ownerFile)) continue;
    const stat = lstatSync(ownerFile);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid server owner file');
    rmSync(ownerFile);
    ownerFilesReset += 1;
  }
  // Docker creates an empty named-volume root as root. The runtime user must be
  // able to recreate the intentionally discarded process-lifetime mutex.
  if (process.getuid?.() === 0) chownSync(directory, 1000, 1000);
  const db = new DatabaseSync(file);
  const counts = { packages: 0, executionFields: 0, rows: 0 };
  try {
    if (Number(db.prepare('PRAGMA user_version').get().user_version) !== 23)
      throw new Error('Schema 23 source required for the 23-to-24 migration');
    if (
      db.prepare('PRAGMA quick_check').get().quick_check !== 'ok' ||
      db.prepare('PRAGMA foreign_key_check').all().length
    )
      throw new Error('Database integrity check failed before migration');
    const metadata = db.prepare('SELECT baseline,signature FROM schema_metadata WHERE id=1').get();
    if (metadata?.baseline !== 'uimori-risu-native' || typeof metadata.signature !== 'string')
      throw new Error('Schema 23 metadata is missing or incompatible');
    installSnapshotPack(db);

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const { name } of db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_metadata'"
        )
        .all()) {
        const columns = db
          .prepare(`PRAGMA table_info(${quote(name)})`)
          .all()
          .filter((column) => column.type.toUpperCase() === 'TEXT');
        for (const column of columns) {
          const rows = db
            .prepare(
              `SELECT rowid AS row_id,${quote(column.name)} AS value FROM ${quote(name)} WHERE ${quote(column.name)} IS NOT NULL`
            )
            .all();
          const update = db.prepare(
            `UPDATE ${quote(name)} SET ${quote(column.name)}=? WHERE rowid=?`
          );
          for (const row of rows) {
            let value;
            try {
              value = JSON.parse(row.value);
            } catch {
              continue;
            }
            if (!record(value) && !Array.isArray(value)) continue;
            const before = counts.packages + counts.executionFields;
            if (column.name === 'snapshot') value = expandSnapshot(db, value);
            migrateJson23To24(value, counts);
            if (counts.packages + counts.executionFields === before) continue;
            update.run(JSON.stringify(value), row.row_id);
            counts.rows += 1;
          }
        }
      }
      db.exec('PRAGMA user_version=24');
      if (db.prepare('PRAGMA foreign_key_check').all().length)
        throw new Error('Database foreign keys failed after migration');
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
  const verified = inspectData(directory, { integrity: true });
  if (verified.schema !== 24) throw new Error('Schema 24 verification failed');
  return { from: 23, to: 24, ...counts, ownerFilesReset, integrity: verified.integrity };
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
    'migrate-23-to-24': () => migrateSchema23To24(source),
  };
  if (!actions[command])
    throw new Error(
      'Expected inspect, audit, backup, restore, credentials, snapshot, or migrate-23-to-24'
    );
  console.log(JSON.stringify(await actions[command]()));
}
