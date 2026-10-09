import { afterEach, expect, test } from 'vitest';
import Fastify from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';
import { Store } from '../server/store.js';
import { nativeTransferRoutes } from '../server/native-transfer.js';
import { uploadDirectory } from '../server/uploads.js';
import { putImageBlob } from '../server/package-images.js';
import { processImage } from '../server/image-processing.js';
import { readImage } from '../server/image-storage.js';
import { prepareNativeArchive } from '../server/native-transfer-archive.js';
import { readNativeArchive } from '../server/native-transfer-archive-codec.js';
import { exportChatBackupArchive, importChatBackupArchiveRequest } from '../server/chat-backup.js';
import { nativeContent } from './fixtures/native-content.js';
import { createFixtureChat } from './fixtures/chat.js';
import { exportChatTranscript, importChatTranscript } from '../server/chat-transcript.js';
import { restoreIllustrations } from '../server/illustration-copy.js';
import type { Content } from '../core/product.js';
import { prepareStoredRisuImport } from '../server/risu-import-prepared.js';

const owned: { directory: string; store: Store }[] = [];
afterEach(() => {
  for (const item of owned.splice(0)) {
    item.store.close();
    const path = resolve(item.directory),
      within = relative(resolve(tmpdir()), path);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(path).startsWith('uimori-native-archive-')
    )
      throw new Error('Unsafe fixture cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
function database() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-native-archive-')),
    store = new Store(join(directory, 'test.sqlite'));
  owned.push({ directory, store });
  return store;
}
function upload(store: Store, bytes: Buffer) {
  const id = randomBytes(16).toString('hex');
  mkdirSync(uploadDirectory(store.path), { recursive: true });
  writeFileSync(join(uploadDirectory(store.path), `${id}.bin`), bytes);
  return id;
}
async function bytes(stream: AsyncIterable<unknown>) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNIK1/1HwAFVQKH+f6iOwAAAABJRU5ErkJggg==',
  'base64'
);
async function bot(store: Store, imageCount = 1) {
  const processed = await processImage(png),
    image = putImageBlob(store.product, {
      mime: processed.mime,
      base64: processed.bytes.toString('base64'),
    });
  const pkg = nativeContent(
    { name: 'Archive card', description: 'Authored original' },
    {
      images: Array.from({ length: imageCount }, (_, index) => ({
        id: `asset-${index}`,
        title: `Name ${index}`,
        description: '',
        blobHash: image.hash,
        mime: image.mime,
        allowedUse: 'both',
      })),
    }
  );
  return store.product.content({
    kind: 'bot',
    title: pkg.title,
    description: pkg.description,
    text: pkg.body,
    loading: 'pinned',
    relatedIds: [],
    package: pkg,
  }) as Content;
}

test('12,288 logical assets export as one binary image and reimport preserves names and durable retry', async () => {
  const source = database(),
    original = await bot(source, 12_288),
    app = Fastify();
  nativeTransferRoutes(app, source);
  const exported = await app.inject({
    method: 'POST',
    url: '/api/native-transfers/export-archive',
    payload: { items: [{ kind: 'content', id: original.id }] },
  });
  expect(exported.statusCode).toBe(200);
  const archive = exported.rawPayload,
    members = readNativeArchive(archive.length, (offset, length) =>
      archive.subarray(offset, offset + length)
    );
  const manifest = JSON.parse(members.get('manifest.json')!().toString());
  expect(manifest.images).toHaveLength(1);
  expect(manifest.resources.images[0]).not.toHaveProperty('base64');
  expect(members.size).toBe(2);
  const target = database(),
    destination = Fastify();
  nativeTransferRoutes(destination, target);
  const preview = await prepareNativeArchive(target, upload(target, archive), 'resources');
  const command = {
    preparedId: preview.preparedId,
    digest: preview.digest,
    idempotencyKey: 'stable-native',
    modelBindings: [],
  };
  const imported = await destination.inject({
    method: 'POST',
    url: '/api/native-transfers/apply-archive',
    payload: command,
  });
  expect(imported.statusCode).toBe(200);
  const receipt = imported.json(),
    saved = target.product.get<Content>('content', receipt.items[0].id);
  expect(saved.package.images).toHaveLength(12_288);
  expect(saved.package.images!.at(-1)!.title).toBe('Name 12287');
  expect(readImage(target.db, saved.package.images![0].blobHash).bytes).toEqual(
    (await processImage(png)).bytes
  );
  expect(
    existsSync(join(uploadDirectory(target.path), 'native-prepared', preview.preparedId))
  ).toBe(false);
  const retry = await destination.inject({
    method: 'POST',
    url: '/api/native-transfers/apply-archive',
    payload: command,
  });
  expect(retry.statusCode).toBe(200);
  expect(retry.json().created).toBe(false);
  expect(retry.json().items).toEqual(receipt.items);
  await destination.close();
  await app.close();
});

test('corrupt archive image is rejected before any resource or blob registration', async () => {
  const source = database(),
    original = await bot(source),
    app = Fastify();
  nativeTransferRoutes(app, source);
  const result = await app.inject({
    method: 'POST',
    url: '/api/native-transfers/export-archive',
    payload: { items: [{ kind: 'content', id: original.id }] },
  });
  const archive = Buffer.from(result.rawPayload);
  const firstLength = archive.readUInt32LE(18),
    firstName = archive.readUInt16LE(26),
    secondOffset = 30 + firstName + firstLength;
  const dataOffset = secondOffset + 30 + archive.readUInt16LE(secondOffset + 26);
  archive[dataOffset + 10] ^= 1;
  const target = database();
  await expect(prepareNativeArchive(target, upload(target, archive), 'resources')).rejects.toThrow(
    '자료 백업 파일'
  );
  expect(target.product.all('content')).toHaveLength(0);
  expect(target.db.prepare('SELECT count(*) AS n FROM image_blobs').get()!.n).toBe(0);
  await app.close();
});

test('chat archive restores authored resources without execution and recovers receipt after staging expires', async () => {
  const source = database(),
    original = await bot(source),
    empty = createFixtureChat(source, 'Archive conversation', { botId: original.id });
  const transcript = exportChatTranscript(source, empty.id);
  transcript.entries = [
    {
      request: 'Continue',
      text: `Scene with ![image](/api/package-image-blobs/${original.package.images![0].blobHash})`,
      translation: null,
    },
  ];
  const chat = importChatTranscript(source, { transcript, idempotencyKey: 'source-chat' }).chat;
  const image = readImage(source.db, original.package.images![0].blobHash);
  source.transaction(() =>
    restoreIllustrations(source, source.history(chat.headRevision), [
      {
        entry: 0,
        mime: 'image/webp',
        base64: image.bytes.toString('base64'),
        title: 'Displayed illustration',
      },
    ])
  );
  const archive = await bytes(exportChatBackupArchive(source, chat.id)),
    target = database();
  const preview = await prepareNativeArchive(target, upload(target, archive), 'chat');
  expect(preview.backup?.title).toBe('Archive conversation');
  const command = {
    preparedId: preview.preparedId,
    digest: preview.digest,
    idempotencyKey: 'stable-chat',
  };
  const restored = importChatBackupArchiveRequest(target, command);
  expect(restored.chat.title).toBe(chat.title);
  expect(restored.chat.id).not.toBe(chat.id);
  expect(target.history(restored.chat.headRevision)[0].text).toBe(transcript.entries[0].text);
  expect(target.db.prepare('SELECT count(*) AS n FROM illustration_images').get()!.n).toBe(1);
  const illustration = target.db.prepare('SELECT hash,body FROM illustration_images').get()!;
  expect(illustration.hash).toBe(image.hash);
  expect(JSON.parse(String(illustration.body)).caption).toBe('Displayed illustration');
  expect(target.product.all('content')).toHaveLength(1);
  const saved = target.product.all('content')[0] as Content;
  expect(saved.package.nativeRisu.card.description).toBe('Authored original');
  expect(
    createHash('sha256')
      .update(readImage(target.db, saved.package.images![0].blobHash).bytes)
      .digest('hex')
  ).toBe(saved.package.images![0].blobHash);
  expect(
    existsSync(join(uploadDirectory(target.path), 'native-prepared', preview.preparedId))
  ).toBe(false);
  expect(importChatBackupArchiveRequest(target, command).created).toBe(false);
  expect(target.chats()).toHaveLength(1);
});

test('native archive cancellation releases the shared preparation budget before another Risu worker starts', async () => {
  const source = database(),
    original = await bot(source),
    app = Fastify();
  nativeTransferRoutes(app, source);
  const exported = await app.inject({
    method: 'POST',
    url: '/api/native-transfers/export-archive',
    payload: { items: [{ kind: 'content', id: original.id }] },
  });
  const target = database(),
    other = database(),
    id = upload(target, exported.rawPayload);
  const controller = new AbortController();
  const running = prepareNativeArchive(target, id, 'resources', controller.signal);
  const risuSource = {
    name: 'next.json',
    base64: Buffer.from(
      JSON.stringify({
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: { name: 'After cancellation', description: '', assets: [] },
      })
    ).toString('base64'),
  };
  await expect(prepareStoredRisuImport(other.path, { source: risuSource })).rejects.toThrow(
    'RISU_IMPORT_BUSY'
  );
  controller.abort();
  await expect(running).rejects.toThrow('RISU_IMPORT_CANCELLED');
  expect(readdirSync(join(uploadDirectory(target.path), 'native-prepared'))).toEqual([]);
  expect(target.product.all('content')).toHaveLength(0);
  expect((await prepareStoredRisuImport(other.path, { source: risuSource })).summary.images).toBe(
    0
  );
  await app.close();
});
