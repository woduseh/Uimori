import { backup } from 'node:sqlite';
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';

/** SQLite produces a consistent snapshot; HTTP streams it without loading the DB into a Buffer. */
export async function databaseBackupStream(store: Store) {
  const path = `${store.path}.backup-${randomUUID()}.sqlite`;
  try {
    await backup(store.db, path);
  } catch (error) {
    await unlink(path).catch(() => {});
    throw error;
  }
  const stream = createReadStream(path);
  stream.once('close', () => {
    void unlink(path).catch(() => {});
  });
  return stream;
}
