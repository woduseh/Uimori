import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Store } from '../server/store.js';
import { PendingImageCleanup } from '../server/unused-data.js';
import { createFixtureChat } from './fixtures/chat.js';

const owned: { directory: string; store: Store }[] = [];
afterEach(() => {
  for (const { directory, store } of owned.splice(0)) {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-unused-'));
  const store = new Store(join(directory, 'app.sqlite'));
  owned.push({ directory, store });
  return store;
}
const blobCount = (store: Store, hash: string) =>
  Number(store.db.prepare('SELECT count(*) AS n FROM image_blobs WHERE hash=?').get(hash)!.n);
function orphan(store: Store, hash: string) {
  store.db.prepare("INSERT INTO image_blobs VALUES(?,'image/webp',?)").run(hash, Buffer.from([1]));
  store.db.prepare('INSERT INTO image_cleanup_candidates VALUES(?)').run(hash);
}

test('background cleanup removes an orphan but keeps an image referenced while the scan ran', async () => {
  const store = fixture();
  const chat = createFixtureChat(store, 'Images');
  const cleanup = new PendingImageCleanup(store);
  const orphaned = 'a'.repeat(64);
  orphan(store, orphaned);
  await cleanup.flush();
  expect(blobCount(store, orphaned)).toBe(0);
  expect(store.db.prepare('SELECT count(*) AS n FROM image_cleanup_candidates').get()!.n).toBe(0);

  const reused = 'b'.repeat(64);
  orphan(store, reused);
  const pending = cleanup.flush();
  store.db
    .prepare('INSERT INTO chat_variable_outputs VALUES(?,?)')
    .run(`${chat.id}-output`, JSON.stringify({ image: `/api/package-image-blobs/${reused}` }));
  await pending;
  expect(blobCount(store, reused)).toBe(1);
  await cleanup.flush();
  expect(blobCount(store, reused)).toBe(1);
  expect(store.db.prepare('SELECT count(*) AS n FROM image_cleanup_candidates').get()!.n).toBe(0);
  await cleanup.close();
});
