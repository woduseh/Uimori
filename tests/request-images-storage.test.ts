import { legacyChatBackupFixture } from './fixtures/legacy-backup.js';
import { afterEach, expect, test } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { createFixtureChat } from './fixtures/chat.js';
import {
  prepareRequestImages,
  requestImageUploads,
  storeRequestImages,
  readRequestImage,
} from '../server/request-images.js';
import { storeUpload } from '../server/uploads.js';
import { readImage } from '../server/image-storage.js';
import { readStoredRunSnapshot } from '../server/run-projections.js';
import { readerDetail } from '../server/reader.js';
import { exportChatTranscript } from '../server/chat-transcript.js';
import { forkChat } from '../server/chat-fork.js';
import { deleteChat } from '../server/chat-deletion.js';
import { pruneUnusedData } from '../server/unused-data.js';
import {
  importChatBackup,
  exportChatBackupArchive,
  importChatBackupArchiveRequest,
} from '../server/chat-backup.js';
import { prepareNativeArchive } from '../server/native-transfer-archive.js';
import type { RequestImageUpload } from '../core/request-images.js';

const owned: { directory: string; store?: Store }[] = [];
function directory() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-request-images-'));
  owned.push({ directory });
  return directory;
}
function database() {
  const path = directory(),
    store = new Store(join(path, 'story.sqlite'));
  owned.at(-1)!.store = store;
  return store;
}
afterEach(() => {
  for (const item of owned.splice(0)) {
    item.store?.close();
    const target = resolve(item.directory),
      within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('uimori-request-images-')
    )
      throw new Error('Unsafe fixture cleanup');
    rmSync(target, { recursive: true, force: true });
  }
});
async function stage(
  store: Pick<Store, 'path'>,
  bytes: Buffer,
  name = 'reference.png'
): Promise<RequestImageUpload> {
  const upload = await storeUpload(store.path, Readable.from([bytes]));
  return { uploadId: upload.uploadId, sha256: upload.sha256, name };
}
async function png(width = 3, height = 2) {
  return sharp({
    create: { width, height, channels: 4, background: { r: 103, g: 45, b: 211, alpha: 0.65 } },
  })
    .png()
    .toBuffer();
}
async function collect(stream: AsyncIterable<unknown>) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

test('admission preserves decoded pixels and prepares a separate bounded transmission image without storing an unowned blob', async () => {
  const store = database(),
    bytes = await png(3000, 3),
    upload = await stage(store, bytes);
  const prepared = await prepareRequestImages(store, [upload]),
    image = prepared.images[0];
  expect(image).toMatchObject({
    name: 'reference.png',
    width: 3000,
    height: 3,
    input: { width: 2048, height: 2 },
  });
  expect(image.hash).not.toBe(image.input.hash);
  expect(store.db.prepare('SELECT count(*) AS n FROM image_blobs').get()!.n).toBe(0);
  store.transaction(() => storeRequestImages(store, prepared));
  const saved = readImage(store.db, image.hash);
  expect(await sharp(saved.bytes).raw().toBuffer()).toEqual(await sharp(bytes).raw().toBuffer());
  const input = readRequestImage(store, image);
  expect(input.width).toBe(2048);
  expect(Buffer.from(input.base64, 'base64').length).toBeLessThanOrEqual(2 * 1024 * 1024);
  expect(createHash('sha256').update(saved.bytes).digest('hex')).toBe(image.hash);
  await expect(
    prepareRequestImages(store, [{ ...upload, sha256: 'f'.repeat(64) }])
  ).rejects.toThrow('REQUEST_IMAGE_CHANGED');
  expect(() => requestImageUploads(Array(9).fill(upload))).toThrow('REQUEST_IMAGE_COUNT_INVALID');
  const gif = await sharp(await png())
    .gif()
    .toBuffer();
  await expect(prepareRequestImages(store, [await stage(store, gif)])).rejects.toThrow(
    'REQUEST_IMAGE_FORMAT_INVALID'
  );
});

test('image-only HTTP admission recovers after staging is consumed, binds image identity, and rolls back rejected reservations', async () => {
  const app = await createApp({
    dbPath: join(directory(), 'story.sqlite'),
    buildId: 'request-images-test',
    instanceId: randomUUID(),
    testMode: true,
  });
  const headers = { host: '127.0.0.1' };
  try {
    const chat = createFixtureChat(app.store, 'Image-only request');
    const staged = await app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: await png(),
    });
    expect(staged.statusCode, staged.body).toBe(200);
    const upload = staged.json(),
      payload = {
        request: '',
        requestImages: [{ uploadId: upload.uploadId, sha256: upload.sha256, name: 'portrait.png' }],
        expectedRevision: chat.headRevision,
        expectedSettingsRevision: chat.settingsRevision,
        idempotencyKey: 'image-only',
      };
    const result = await app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/runs`,
      headers,
      payload,
    });
    expect(result.statusCode, result.body).toBe(200);
    const run = result.json();
    expect(run.request).toBe('');
    expect(run.snapshot.requestImages).toHaveLength(1);
    const replay = await app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/runs`,
      headers,
      payload: {
        ...payload,
        requestImages: [{ ...payload.requestImages[0], uploadId: 'e'.repeat(32) }],
      },
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().id).toBe(run.id);
    const conflict = await app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/runs`,
      headers,
      payload: {
        ...payload,
        requestImages: [{ ...payload.requestImages[0], name: 'different.png' }],
      },
    });
    expect(conflict.statusCode).toBe(409);
    const count = app.store.db.prepare('SELECT count(*) AS n FROM image_blobs').get()!.n;
    const second = await stage(app.store, await png(11, 7));
    const rejected = await app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/runs`,
      headers,
      payload: {
        ...payload,
        idempotencyKey: 'stale',
        expectedSettingsRevision: chat.settingsRevision + 1,
        requestImages: [second],
      },
    });
    expect(rejected.statusCode).toBe(409);
    expect(app.store.db.prepare('SELECT count(*) AS n FROM image_blobs').get()!.n).toBe(count);
  } finally {
    await app.close();
  }
});

test('settlement, retry, independent copies, JSON and binary backups retain both authored and transmission bytes through deletion and GC', async () => {
  const store = database(),
    chat = createFixtureChat(store, 'Image history');
  const prepared = await prepareRequestImages(store, [await stage(store, await png(3000, 3))]);
  const profile = store.product.snapshot(chat.id);
  const { run } = store.transaction(() => {
    storeRequestImages(store, prepared);
    return store.createRunInTransaction(
      chat.id,
      {
        request: 'Read this image',
        expectedRevision: chat.headRevision,
        expectedSettingsRevision: chat.settingsRevision,
        idempotencyKey: 'with-image',
      },
      (current) => ({
        chatId: chat.id,
        parentRevision: current.headRevision,
        settingsRevision: current.settingsRevision,
        settings: current.settings,
        request: 'Read this image',
        requestImages: prepared.images,
        history: [],
        resources: [],
        profile,
      })
    );
  });
  store.startRun(run.id);
  const source = store.completeRun(run.id, 'The violet landscape.', {
    modelCalls: 0,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  });
  expect(readStoredRunSnapshot(store, run.id).requestImages).toEqual(prepared.images);
  expect(
    readerDetail(store, chat.id, {}).runs.find((item) => item.id === run.id)!.snapshot.requestImages
  ).toEqual(prepared.images);
  const copy = forkChat(store, chat.id, { fromRevision: source.id, idempotencyKey: 'image-copy' });
  expect(exportChatTranscript(store, copy.id).entries[0].requestImages).toEqual(prepared.images);
  const retried = store.retryRun(run.id, 'image-retry', undefined, 'Look again', 'copy').run;
  expect(retried.snapshot.requestImages).toEqual(prepared.images);
  store.finishRun(retried.id, 'cancelled', 'Test cancelled');
  deleteChat(store, retried.chatId, {});
  const json = legacyChatBackupFixture(store, chat.id),
    archive = await collect(exportChatBackupArchive(store, chat.id));
  expect(json.resources.images.map((image) => image.hash)).toEqual(
    expect.arrayContaining([prepared.images[0].hash, prepared.images[0].input.hash])
  );
  const jsonTarget = database(),
    jsonChat = await importChatBackup(jsonTarget, { backup: json, idempotencyKey: 'json-image' });
  expect(exportChatTranscript(jsonTarget, jsonChat.chat.id).entries[0].requestImages).toEqual(
    prepared.images
  );
  const zipTarget = database(),
    zipUpload = await stage(zipTarget, archive, 'backup.chat.uimori');
  const preview = await prepareNativeArchive(zipTarget, zipUpload.uploadId, 'chat');
  const zipped = importChatBackupArchiveRequest(zipTarget, {
    preparedId: preview.preparedId,
    digest: preview.digest,
    idempotencyKey: 'zip-image',
  });
  expect(exportChatTranscript(zipTarget, zipped.chat.id).entries[0].requestImages).toEqual(
    prepared.images
  );
  for (const target of [jsonTarget, zipTarget]) {
    for (const hash of [prepared.images[0].hash, prepared.images[0].input.hash])
      expect(readImage(target.db, hash).bytes).toEqual(readImage(store.db, hash).bytes);
  }
  deleteChat(store, chat.id, {});
  pruneUnusedData(store.db, null);
  expect(readRequestImage(store, prepared.images[0]).width).toBe(2048);
  deleteChat(store, copy.id, {});
  expect(store.db.prepare('SELECT count(*) AS n FROM image_blobs').get()!.n).toBe(0);
});
