import { backup } from 'node:sqlite';
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';

const snapshots = new WeakMap<Store, Promise<void>>();

export async function createDatabaseSnapshot(store: Store, path: string) {
  const prior = snapshots.get(store) ?? Promise.resolve();
  const current = prior
    .catch(() => {})
    .then(async () => {
      await backup(store.db, path, { rate: 100 });
    });
  snapshots.set(store, current);
  try {
    await current;
  } finally {
    if (snapshots.get(store) === current) snapshots.delete(store);
  }
}

export async function databaseBackupStream(store: Store) {
  const path = `${store.path}.backup-${randomUUID()}.sqlite`;
  try {
    await createDatabaseSnapshot(store, path);
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
