import { legacyChatBackupFixture, legacyChatBackupWithBot } from './fixtures/legacy-backup.js';
import { afterEach, expect, test } from 'vitest';
import Fastify from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
  utimesSync,
} from 'node:fs';
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
import {
  exportChatBackupArchive,
  importChatBackupArchiveRequest,
  importChatBackup,
} from '../server/chat-backup.js';
import { nativeContent } from './fixtures/native-content.js';
import { createFixtureChat } from './fixtures/chat.js';
import { exportChatTranscript, importChatTranscript } from '../server/chat-transcript.js';
import { restoreIllustrations } from '../server/illustration-copy.js';
import type { Content } from '../core/product.js';
import { prepareStoredRisuImport } from '../server/risu-import-prepared.js';
import { saveImportReceipt } from '../server/import-operations.js';
import { startImportStagingCleanup } from '../server/import-staging-cleanup.js';
import { captureChatCopy, restoreChatCopy } from '../server/chat-copy.js';
import {
  frozenIllustrationReferences,
  illustrationReferences,
  updateIllustrationReferences,
} from '../server/illustrations.js';

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
  for (let index = 0; index < 260; index++)
    saveImportReceipt(target, `other-import-${index}`, 'digest', { index });
  expect(importChatBackupArchiveRequest(target, command).created).toBe(false);
  expect(target.chats()).toHaveLength(1);
});

test('chat copies and backups preserve character appearances and remap only their owned images', async () => {
  const source = database();
  const original = await bot(source);
  const chat = createFixtureChat(source, 'Character references', { botId: original.id });
  const local = source.product.createAsset(chat.id, {
    title: '채팅 초상',
    mime: 'image/png',
    base64: png.toString('base64'),
    description: '',
    actor: '',
    outfit: '',
    location: '',
    allowedUse: 'both',
  });
  const packageRef = `package:${original.id}:bot:asset-0`;
  const profiles = [
    { id: 'one', name: '하나', appearance: '푸른 눈과 긴 머리', referenceRef: local.id },
    { id: 'two', name: '둘', appearance: '은빛 머리', referenceRef: packageRef },
    { id: 'three', name: '셋', appearance: '주근깨' },
  ];
  updateIllustrationReferences(source, chat.id, {
    expectedRevision: 0,
    references: [{ ref: packageRef, role: 'style' }],
    characterProfiles: profiles,
  });
  const copy = captureChatCopy(source, chat.id);
  expect(copy.state.illustrationReferences?.images).toHaveLength(1);
  const localCopy = restoreChatCopy(source, copy, 'character-local-copy');
  const localSaved = illustrationReferences(source, localCopy.id);
  expect(localSaved.characterProfiles[0].referenceRef).not.toBe(local.id);
  expect(localSaved.characterProfiles[1].referenceRef).toBe(packageRef);
  expect(source.product.assets(localCopy.id)).toHaveLength(1);

  const archive = await bytes(exportChatBackupArchive(source, chat.id));
  const target = database();
  const preview = await prepareNativeArchive(target, upload(target, archive), 'chat');
  const restored = importChatBackupArchiveRequest(target, {
    preparedId: preview.preparedId,
    digest: preview.digest,
    idempotencyKey: 'characters-archive',
  }).chat;
  const jsonTarget = database();
  const jsonChat = (
    await importChatBackup(jsonTarget, {
      backup: legacyChatBackupFixture(source, chat.id),
      idempotencyKey: 'characters-json',
    })
  ).chat;
  for (const [owner, result] of [
    [target, restored],
    [jsonTarget, jsonChat],
  ] as const) {
    const saved = illustrationReferences(owner, result.id);
    const importedBot = owner.product
      .profile(result.id)
      .packageAttachments!.find((item) => item.role === 'bot')!;
    const importedPackageRef = `package:${importedBot.id}:bot:asset-0`;
    const assets = owner.product.assets(result.id);
    expect(assets).toHaveLength(1);
    expect(assets[0].title).toBe('채팅 초상');
    expect(saved.characterProfiles).toEqual([
      { ...profiles[0], referenceRef: assets[0].id },
      { ...profiles[1], referenceRef: importedPackageRef },
      profiles[2],
    ]);
    expect(saved.references).toEqual([{ ref: importedPackageRef, role: 'style' }]);
    expect(frozenIllustrationReferences(owner, result.id)).toMatchObject([
      { ref: importedPackageRef, role: 'character' },
      { ref: assets[0].id, role: 'character' },
    ]);
  }
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
  const preparedRoot = join(uploadDirectory(target.path), 'native-prepared');
  const activePath = join(preparedRoot, readdirSync(preparedRoot)[0]);
  const expired = new Date(Date.now() - 25 * 60 * 60 * 1000);
  utimesSync(activePath, expired, expired);
  const stopCleanup = startImportStagingCleanup(target);
  expect(existsSync(activePath)).toBe(true);
  stopCleanup();
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

test('an explicit v1 JSON backup still restores without a JSON output endpoint', async () => {
  const source = database();
  const chat = createFixtureChat(source, 'Legacy input');
  const botId = source.product
    .profile(chat.id)
    .packageAttachments!.find((ref) => ref.role === 'bot')!.id;
  const owner = source.product.get<Content>('content', botId);
  const backup = legacyChatBackupWithBot(owner, chat.settings, {
    title: 'Archived JSON conversation',
    text: 'The old manuscript stays readable.',
    translation: '예전 원고를 계속 읽을 수 있어요.',
  });
  const target = database();
  const command = { backup, idempotencyKey: 'legacy-json-input' };
  const restored = await importChatBackup(target, command);
  expect(restored.created).toBe(true);
  expect(exportChatTranscript(target, restored.chat.id).entries).toEqual([
    {
      request: 'Write',
      text: 'The old manuscript stays readable.',
      translation: '예전 원고를 계속 읽을 수 있어요.',
    },
  ]);
  expect((await importChatBackup(target, command)).created).toBe(false);
  expect(target.chats()).toHaveLength(1);
});
