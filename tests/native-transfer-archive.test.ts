import { legacyChatBackupFixture, legacyChatBackupWithBot } from './fixtures/legacy-backup.js';
import { afterEach, expect, test } from 'vitest';
import Fastify from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';
import { Store } from '../server/store.js';
import { transferRoutes } from '../server/transfer-routes.js';
import { uploadDirectory } from '../server/uploads.js';
import { putImageBlob } from '../server/package-images.js';
import { processImage } from '../server/image-processing.js';
import { readImage } from '../server/image-storage.js';
import { prepareNativeArchive } from '../server/native-transfer-archive.js';
import { bundleDigest } from '../server/resource-bundle.js';
import type { ChatCopy } from '../core/chat-backup.js';
import { readNativeArchive } from '../server/native-transfer-archive-codec.js';
import {
  exportChatBackupArchive,
  importChatBackupArchiveRequest,
  importChatBackup,
} from '../server/chat-backup.js';
import { nativeContent } from './fixtures/native-content.js';
import { createFixtureChat } from './fixtures/chat.js';
import { softDeleteLibraryItem } from './fixtures/soft-delete.js';
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
import { remapIllustrationPackageReferences } from '../server/illustration-reference-copy.js';
import { saveChatGenerationDefaults } from '../server/chat-generation-defaults.js';
import { ChatOptionsStore } from '../server/chat-options.js';
import { nativePrompt } from './fixtures/native-prompt.js';
import { createPackageStart } from '../server/package-start.js';
import { completedSource } from './fixtures/illustration.js';
import { readerDetail } from '../server/reader.js';
import { exportManuscript } from '../server/manuscript-export.js';
import { ManuscriptSearch } from '../server/manuscript-search.js';
import type { ManuscriptSearchInput } from '#contracts/operations';
import type { ReaderRun } from '../core/types.js';

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
async function bot(
  store: Store,
  imageCount = 1,
  kind: 'bot' | 'module' = 'bot',
  modules: { id: string; revision: number }[] = []
) {
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
      modules,
    },
    kind
  );
  return store.product.content({
    kind,
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
  transferRoutes(app, source, () => {});
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
  transferRoutes(destination, target, () => {});
  const preview = await prepareNativeArchive(target, upload(target, archive), 'resources');
  const command = {
    preparedId: preview.preparedId,
    digest: preview.digest,
    idempotencyKey: 'stable-native',
  };
  const imported = await destination.inject({
    method: 'POST',
    url: '/api/native-transfers/apply-archive',
    payload: command,
  });
  expect(imported.statusCode).toBe(200);
  const receipt = imported.json(),
    saved = target.product.stored<Content>('content', receipt.items[0].id);
  expect(saved.package.images).toHaveLength(12_288);
  expect(saved.package.images!.at(-1)!.title).toBe('Name 12287');
  expect(readImage(target.db, saved.package.images![0].blobHash).bytes).toEqual(
    (await processImage(png)).bytes
  );
  expect(
    existsSync(join(uploadDirectory(target.path), 'native-prepared', preview.preparedId))
  ).toBe(false);
  for (let index = 0; index < 260; index++)
    saveImportReceipt(target, `unrelated-${index}`, 'digest', { index });
  const retry = await destination.inject({
    method: 'POST',
    url: '/api/native-transfers/apply-archive',
    payload: command,
  });
  expect(retry.statusCode).toBe(200);
  expect(retry.json().created).toBe(false);
  expect(retry.json().items).toEqual(receipt.items);

  const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const legacyStored = { ...receipt, created: true };
  saveImportReceipt(
    target,
    'archive:legacy-ui-archive',
    sha({ id: preview.preparedId, digest: preview.digest, modelBindings: [] }),
    legacyStored
  );
  const legacyReplay = await destination.inject({
    method: 'POST',
    url: '/api/native-transfers/apply-archive',
    payload: { ...command, idempotencyKey: 'legacy-ui-archive' },
  });
  expect(legacyReplay.statusCode, legacyReplay.body).toBe(200);
  expect(legacyReplay.json()).toEqual({ ...legacyStored, created: false });
  const legacyConflict = await destination.inject({
    method: 'POST',
    url: '/api/native-transfers/apply-archive',
    payload: {
      ...command,
      idempotencyKey: 'legacy-ui-archive',
      digest: '0'.repeat(64),
    },
  });
  expect(legacyConflict.statusCode).toBe(409);
  await destination.close();
  await app.close();
});

test('corrupt archive image is rejected before any resource or blob registration', async () => {
  const source = database(),
    original = await bot(source),
    app = Fastify();
  transferRoutes(app, source, () => {});
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
    'NATIVE_TRANSFER_FILE_INVALID'
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
  const chat = importChatTranscript(
    source,
    { transcript, idempotencyKey: 'source-chat' },
    'library'
  ).chat;
  const originalSettings = {
    maxCalls: 128,
    storyUi: true,
    storyUiStyle: 'theme:archive-theme',
  } as const;
  source.settings(chat.id, chat.settingsRevision, originalSettings);
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
  saveChatGenerationDefaults(target, {
    expectedRevision: 0,
    maxCalls: 1,
    storyUi: false,
    storyUiStyle: 'modern',
    autoRefusalRetryEnabled: true,
    autoRefusalMaxRetries: 2,
  });
  const preview = await prepareNativeArchive(target, upload(target, archive), 'chat');
  expect(preview.backup?.title).toBe('Archive conversation');
  const command = {
    preparedId: preview.preparedId,
    digest: preview.digest,
    idempotencyKey: 'stable-chat'.padEnd(100, '-'),
  };
  const restored = importChatBackupArchiveRequest(target, command);
  expect(restored.chat.title).toBe(chat.title);
  expect(restored.chat.id).not.toBe(chat.id);
  expect(restored.chat.settings).toEqual(originalSettings);
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

test('a restored authored opening reads, numbers, exports and searches like the original across repeated archive round trips', async () => {
  const source = database();
  const pkg = nativeContent({ name: 'Ari', first_mes: 'Ari opens the observatory door.' });
  const content = source.product.content({
    kind: 'bot',
    title: pkg.title,
    description: '',
    text: '',
    loading: 'pinned',
    relatedIds: [],
    package: pkg,
  }) as Content;
  const chat = createFixtureChat(source, 'Authored opening', { botId: content.id });
  createPackageStart(source, chat.id, {
    packageId: content.id,
    packageRevision: content.revision,
    startId: 'start-0',
    expectedSettingsRevision: chat.settingsRevision,
    expectedProfileRevision: source.product.profile(chat.id).revision,
    idempotencyKey: 'authored-opening',
  });
  completedSource(source, chat.id, 'The telescope turned toward the comet.');

  async function reading(store: Store, chatId: string) {
    const detail = readerDetail(store, chatId, {});
    const runs = new Map((detail.runs as ReaderRun[]).map((run) => [run.id, run]));
    const head = store.chat(chatId).headRevision;
    const search = new ManuscriptSearch(store);
    try {
      return {
        scenes: detail.reader.navigation.map((item) => {
          const run = runs.get(store.source(item.id).runId)!;
          return {
            number: item.number,
            opening: item.opening ?? false,
            runOpening: run.opening ?? false,
            modelTitle: run.modelTitle ?? null,
          };
        }),
        firstScene: exportManuscript(store, chatId, {
          mode: 'source',
          fromScene: 1,
          toScene: 1,
          expectedHeadRevision: head,
        }).markdown,
        search: (
          await search.search({
            query: 'comet',
            scope: 'chat',
            chatId,
            kinds: ['original'],
          } as ManuscriptSearchInput)
        ).items.map((item) => item.sceneNumber),
      };
    } finally {
      await search.close();
    }
  }
  async function restore(from: Store, chatId: string, key: string) {
    expect(captureChatCopy(from, chatId, undefined, true).state.messages?.[0].opening).toBe(true);
    const archive = await bytes(exportChatBackupArchive(from, chatId)),
      target = database();
    const preview = await prepareNativeArchive(target, upload(target, archive), 'chat');
    const restored = importChatBackupArchiveRequest(target, {
      preparedId: preview.preparedId,
      digest: preview.digest,
      idempotencyKey: key.padEnd(100, '-'),
    });
    return { store: target, chatId: restored.chat.id };
  }

  const original = await reading(source, chat.id);
  expect(original).toEqual({
    scenes: [
      { number: 0, opening: true, runOpening: true, modelTitle: null },
      expect.objectContaining({ number: 1, opening: false, runOpening: false }),
    ],
    firstScene: 'The telescope turned toward the comet.\n',
    search: [1],
  });
  const once = await restore(source, chat.id, 'first-restore');
  const restoredOpening = once.store.run(
    once.store.source(once.store.history(once.store.chat(once.chatId).headRevision)[0].revision)
      .runId
  ).snapshot;
  expect(restoredOpening.packageStart).toBeUndefined();
  expect(restoredOpening.nativeRisuAuthored).toMatchObject({
    action: 'copied-opening',
    greeting: true,
  });
  expect(await reading(once.store, once.chatId)).toEqual(original);
  const twice = await restore(once.store, once.chatId, 'second-restore');
  expect(await reading(twice.store, twice.chatId)).toEqual(original);
  const usage = twice.store.db
    .prepare(
      "SELECT COALESCE(SUM(json_extract(usage,'$.modelCalls')),0) AS calls FROM runs WHERE chat_id=?"
    )
    .get(twice.chatId) as { calls: number };
  expect(usage.calls).toBe(0);
});

test('chat copies and backups preserve character appearances and remap only their owned images', async () => {
  const source = database();
  const descendant = await bot(source, 1, 'module');
  const intermediate = await bot(source, 0, 'module', [
    { id: descendant.id, revision: descendant.revision },
  ]);
  const original = await bot(source, 1, 'bot', [
    { id: intermediate.id, revision: intermediate.revision },
  ]);
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
  const descendantRef = `package:${descendant.id}:module:asset-0`;
  const profiles = [
    { id: 'one', name: '하나', appearance: '푸른 눈과 긴 머리', referenceRef: local.id },
    { id: 'two', name: '둘', appearance: '은빛 머리', referenceRef: packageRef },
    { id: 'three', name: '셋', appearance: '주근깨' },
    { id: 'four', name: '넷', appearance: '검은 곱슬머리', referenceRef: descendantRef },
  ];
  updateIllustrationReferences(source, chat.id, {
    expectedRevision: 0,
    references: [
      { ref: packageRef, role: 'style' },
      { ref: descendantRef, role: 'style' },
    ],
    characterProfiles: profiles,
  });
  const copy = captureChatCopy(source, chat.id);
  expect(copy.transcript.packageAttachments.some((item) => item.id === descendant.id)).toBe(false);
  expect(copy.state.illustrationReferences?.images).toHaveLength(1);
  const localCopy = restoreChatCopy(source, copy, 'character-local-copy');
  const localSaved = illustrationReferences(source, localCopy.id);
  expect(localSaved.characterProfiles[0].referenceRef).not.toBe(local.id);
  expect(localSaved.characterProfiles[1].referenceRef).toBe(packageRef);
  expect(localSaved.characterProfiles[3].referenceRef).toBe(descendantRef);
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
    const importedBotContent = owner.product.stored<Content>('content', importedBot.id);
    const importedIntermediate = owner.product.stored<Content>(
      'content',
      importedBotContent.package.modules![0].id
    );
    const importedDescendantId = importedIntermediate.package.modules![0].id;
    expect(importedDescendantId).not.toBe(descendant.id);
    const importedDescendantRef = `package:${importedDescendantId}:module:asset-0`;
    const assets = owner.product.assets(result.id);
    expect(assets).toHaveLength(1);
    expect(assets[0].title).toBe('채팅 초상');
    expect(saved.characterProfiles).toEqual([
      { ...profiles[0], referenceRef: assets[0].id },
      { ...profiles[1], referenceRef: importedPackageRef },
      profiles[2],
      { ...profiles[3], referenceRef: importedDescendantRef },
    ]);
    expect(saved.references).toEqual([
      { ref: importedPackageRef, role: 'style' },
      { ref: importedDescendantRef, role: 'style' },
    ]);
    expect(frozenIllustrationReferences(owner, result.id)).toMatchObject([
      { ref: importedPackageRef, role: 'character' },
      { ref: importedDescendantRef, role: 'character' },
      { ref: assets[0].id, role: 'character' },
    ]);
  }
});

test('package reference remapping matches the complete owner, role and image shape', () => {
  const copy = {
    references: [
      { ref: 'package:owner:part:module:portrait', role: 'style' as const },
      { ref: 'package:owner:part:unknown:portrait', role: 'style' as const },
      { ref: 'package:missing:module:portrait', role: 'style' as const },
    ],
    characterProfiles: [
      {
        id: 'one',
        name: '인물',
        appearance: '외형',
        referenceRef: 'package:owner:part:module:portrait',
      },
    ],
    images: [],
  };
  remapIllustrationPackageReferences(copy, new Map([['owner:part', 'new-owner']]));
  expect(copy.references.map((item) => item.ref)).toEqual([
    'package:new-owner:module:portrait',
    'package:owner:part:unknown:portrait',
    'package:missing:module:portrait',
  ]);
  expect(copy.characterProfiles[0].referenceRef).toBe('package:new-owner:module:portrait');
});

test('native archive cancellation releases the shared preparation budget before another Risu worker starts', async () => {
  const source = database(),
    original = await bot(source),
    app = Fastify();
  transferRoutes(app, source, () => {});
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
  const owner = source.product.stored<Content>('content', botId);
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

test('a chat backup carries the deleted library items its chat holds and restores them live', async () => {
  const source = database();
  const chat = createFixtureChat(source, 'Held items');
  const glossary = source.product.content({
    kind: 'module',
    title: 'Held glossary',
    description: 'Synthetic test data',
    text: 'terms',
    loading: 'pinned',
    relatedIds: [],
  }) as Content;
  const profile = source.product.profile(chat.id);
  source.product.updateProfile(chat.id, {
    expectedRevision: profile.revision,
    image: profile.image,
    packageAttachments: [
      ...profile.packageAttachments!,
      { id: glossary.id, revision: glossary.revision, role: 'module' },
    ],
  });
  const bot = source.product.stored<Content>(
    'content',
    profile.packageAttachments!.find((item) => item.role === 'bot')!.id
  );
  softDeleteLibraryItem(source, 'content', bot);
  softDeleteLibraryItem(source, 'content', glossary);

  const archive = await bytes(exportChatBackupArchive(source, chat.id));
  const target = database();
  const preview = await prepareNativeArchive(target, upload(target, archive), 'chat');
  const restored = importChatBackupArchiveRequest(target, {
    preparedId: preview.preparedId,
    digest: preview.digest,
    idempotencyKey: 'held-items-archive',
  }).chat;
  const attachments = target.product.profile(restored.id).packageAttachments!;
  expect(attachments.map((item) => item.role)).toEqual(['bot', 'module']);
  expect(attachments.every((item) => target.product.isLive('content', item.id))).toBe(true);
  expect(target.product.stored<Content>('content', attachments[1].id).title).toBe('Held glossary');
});

test('a chat backup carries a deleted pinned prompt and its fixed options and restores them live', async () => {
  const source = database();
  const chat = createFixtureChat(source, 'Held prompt');
  const prompt = source.product.promptPreset({
    title: 'Held pinned prompt',
    role: 'main',
    program: nativePrompt('Write', { customPromptTemplateToggle: 'tone=Tone=text' }),
  }) as { id: string; revision: number };
  const profile = source.product.profile(chat.id);
  source.product.updateProfile(chat.id, {
    expectedRevision: profile.revision,
    image: profile.image,
    pinned: { mainPromptPresetId: prompt.id },
  });
  const options = new ChatOptionsStore(source);
  const state = options.get(chat.id);
  options.fixed(
    chat.id,
    {
      expectedRevision: state.revision,
      binding: state.binding,
      values: { tone: 'bold' },
      operationId: 'fix-tone',
    },
    'held-prompt-options'
  );
  softDeleteLibraryItem(source, 'prompt-preset', prompt);

  const archive = await bytes(exportChatBackupArchive(source, chat.id));
  const target = database();
  const preview = await prepareNativeArchive(target, upload(target, archive), 'chat');
  const restored = importChatBackupArchiveRequest(target, {
    preparedId: preview.preparedId,
    digest: preview.digest,
    idempotencyKey: 'held-prompt-archive',
  }).chat;
  const pinned = target.product.profile(restored.id).pinned!.mainPromptPresetId!;
  expect(target.product.isLive('prompt-preset', pinned)).toBe(true);
  expect(target.product.stored<{ title: string }>('prompt-preset', pinned).title).toBe(
    'Held pinned prompt'
  );
  expect(new ChatOptionsStore(target).get(restored.id).fixedValues).toEqual({ tone: 'bold' });
});

test('a chat archive with a prompt preset in a bot slot is refused whole, a bot in the pin slot is not pinned, and the untouched copy restores', async () => {
  const source = database();
  const chat = createFixtureChat(source, 'Swapped slots');
  const prompt = source.product.promptPreset({
    title: 'Pinned prompt',
    role: 'main',
    program: nativePrompt('Write'),
  }) as { id: string };
  const profile = source.product.profile(chat.id);
  source.product.updateProfile(chat.id, {
    expectedRevision: profile.revision,
    image: profile.image,
    pinned: { mainPromptPresetId: prompt.id },
  });
  const archive = await bytes(exportChatBackupArchive(source, chat.id));
  const target = database();
  const prepare = async (edit?: (copy: ChatCopy, botId: string, promptId: string) => void) => {
    const preview = await prepareNativeArchive(target, upload(target, archive), 'chat');
    const path = join(
      uploadDirectory(target.path),
      'native-prepared',
      preview.preparedId,
      'prepared.json'
    );
    const staged = JSON.parse(readFileSync(path, 'utf8'));
    const { resources, backup } = staged.manifest;
    edit?.(backup.chats[0], resources.contents[0].source.id, resources.prompts[0].source.id);
    writeFileSync(path, JSON.stringify(staged));
    return { preparedId: preview.preparedId, digest: bundleDigest(staged.manifest) };
  };

  const promptAsBot = await prepare((copy, _bot, promptId) => {
    copy.transcript.packageAttachments[0].id = promptId;
  });
  expect(() =>
    importChatBackupArchiveRequest(target, { ...promptAsBot, idempotencyKey: 'prompt-as-bot' })
  ).toThrow('CHAT_BACKUP_INVALID');
  expect(target.chats()).toEqual([]);
  expect(target.product.all('content')).toEqual([]);

  const botAsPrompt = await prepare((copy, botId) => {
    copy.state.profile.pinned = { mainPromptPresetId: botId };
  });
  const unpinned = importChatBackupArchiveRequest(target, {
    ...botAsPrompt,
    idempotencyKey: 'bot-as-prompt',
  }).chat;
  expect(target.product.profile(unpinned.id).pinned).toBeUndefined();

  const restored = importChatBackupArchiveRequest(target, {
    ...(await prepare()),
    idempotencyKey: 'untouched',
  }).chat;
  const restoredProfile = target.product.profile(restored.id);
  const pinned = restoredProfile.pinned!.mainPromptPresetId!;
  expect(target.product.stored<{ title: string }>('prompt-preset', pinned).title).toBe(
    'Pinned prompt'
  );
  const bot = restoredProfile.packageAttachments!.find((ref) => ref.role === 'bot')!;
  expect(target.product.isLive('content', bot.id)).toBe(true);
});
