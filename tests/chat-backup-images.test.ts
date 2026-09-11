import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Connection, Content, ModelPreset } from '../core/product.js';
import { splitSource } from '../core/auxiliary.js';
import { exportChatBackup, importChatBackup } from '../server/chat-backup.js';
import {
  imageCatalog,
  putImageBlob,
  validateImageCatalog,
  readerImageAssets,
} from '../server/package-images.js';
import {
  claimIllustration,
  completeIllustration,
  frozenIllustrationReferences,
  illustrationReferences,
  illustrationJob,
  illustrationsForChat,
  loadIllustrationReference,
  reserveIllustration,
  updateIllustrationReferences,
  updateIllustrationSettings,
} from '../server/illustrations.js';
import type { Store } from '../server/store.js';
import { createFixtureChat, fixtureBotInput } from './fixtures/chat.js';
import { updateTestProfile } from './fixtures/model-workspace.js';
import {
  completedSource,
  fixtureSettings,
  illustrationDatabases,
  PNG_BASE64,
} from './fixtures/illustration.js';

const databases = illustrationDatabases('uimori-backup-images-');
afterEach(() => databases.cleanup());
function upload(store: Store, chatId: string) {
  return store.product.createAsset(chatId, {
    title: 'Synthetic reference',
    mime: 'image/png',
    base64: PNG_BASE64,
    description: `Literal /api/assets/${chatId} stays in authored metadata.`,
    actor: '',
    outfit: '',
    location: '',
    allowedUse: 'both',
  });
}

test('package image blobs follow shared blobHash dependencies through export and repeated import', () => {
  const store = databases.create(),
    target = databases.create(),
    blob = putImageBlob(store.product, { mime: 'image/png', base64: PNG_BASE64 }),
    input = fixtureBotInput();
  input.package.images = [
    {
      id: 'portrait',
      title: 'Synthetic portrait',
      description: '',
      blobHash: blob.hash,
      mime: blob.mime,
      allowedUse: 'both',
    },
  ];
  const bot = store.product.content(input) as Content,
    chat = createFixtureChat(store, 'Package image backup', 'calm', { botId: bot.id }),
    original = store.product.export().tables,
    backup = exportChatBackup(store, chat.id);
  expect(backup.records.libraryVersions.filter((row) => row.kind === 'package-image')).toHaveLength(
    1
  );
  for (let index = 0; index < 2; index += 1) {
    const copied = importChatBackup(target, { backup, idempotencyKey: randomUUID() }).chat;
    expect(target.product.get('package-image', blob.hash, 1)).toEqual(blob);
    expect(target.product.snapshot(copied.id)!.packages![0].images).toEqual(input.package.images);
    expect(
      exportChatBackup(target, copied.id).records.libraryVersions.filter(
        (row) => row.kind === 'package-image'
      )
    ).toHaveLength(1);
  }
  expect(store.product.export().tables).toEqual(original);
});

test('uploaded image catalogs and displayed annotations bind copied assets without changing prose or bytes', () => {
  const store = databases.create(),
    target = databases.create(),
    chat = createFixtureChat(store, 'Uploaded image backup'),
    asset = upload(store, chat.id),
    profile = store.product.profile(chat.id),
    { chatId: _chatId, revision, ...values } = profile;
  updateTestProfile(store.product, chat.id, { ...values, expectedRevision: revision, image: true });
  const source = completedSource(store, chat.id, `The source keeps this literal ${asset.url}.`),
    jobId = store.db
      .prepare("SELECT id FROM jobs WHERE source_revision=? AND kind='image'")
      .get(source.id)!.id as string,
    job = store.job(jobId),
    entry = imageCatalog(job.input)[0],
    claimed = store.claimJob(jobId, 'image-backup-worker', {})!;
  expect(
    store.completeJob(jobId, claimed.generation, 'image-backup-worker', {
      mock: true,
      sourceRevision: source.id,
      sourceHash: source.hash,
      imageTarget: job.imageTarget,
      annotations: [
        {
          blockAnchor: splitSource(source)[0].anchor,
          assetRef: entry.ref,
          assetRevision: entry.revision,
          assetHash: entry.hash,
          presentationIntent: 'inline',
          caption: entry.caption,
        },
      ],
    })
  ).toBe(true);
  const original = store.product.export().tables,
    backup = exportChatBackup(store, chat.id);
  for (let index = 0; index < 2; index += 1) {
    const copied = importChatBackup(target, { backup, idempotencyKey: randomUUID() }).chat,
      copiedAsset = target.product.assets(copied.id)[0],
      copiedJobId = target.db
        .prepare("SELECT id FROM jobs WHERE chat_id=? AND kind='image'")
        .get(copied.id)!.id as string,
      copiedJob = target.job(copiedJobId),
      copiedEntry = imageCatalog(copiedJob.input)[0];
    expect(copiedEntry).toEqual({ ...entry, ref: copiedAsset.id, url: copiedAsset.url });
    expect(copiedAsset.id).not.toBe(asset.id);
    expect(copiedAsset.description).toBe(asset.description);
    expect(target.product.asset(copiedAsset.id).bytes).toEqual(Buffer.from(PNG_BASE64, 'base64'));
    expect(target.source(copied.headRevision!).text).toBe(source.text);
    expect(readerImageAssets(target, copied.id)[0].id).toBe(copiedAsset.id);
    expect(() => validateImageCatalog(target, copied.id, copiedJob.input)).not.toThrow();
    expect(exportChatBackup(target, copied.id).records.auxiliaryJobs).toHaveLength(1);
  }
  expect(store.product.export().tables).toEqual(original);
});

test('current and frozen illustration references retain their images after repeated portable copies', () => {
  const store = databases.create(),
    target = databases.create(),
    chat = createFixtureChat(store, 'Illustration reference backup'),
    asset = upload(store, chat.id),
    source = completedSource(store, chat.id);
  updateIllustrationReferences(store, chat.id, {
    expectedRevision: 0,
    references: [{ ref: asset.id, role: 'character' }],
  });
  const connection = store.product.connection({
      title: 'Synthetic Codex',
      protocol: 'codex-app-server-v1',
      endpoint: 'codex://local',
      enabled: true,
    }) as Connection,
    model = store.product.model({
      title: 'Synthetic image model',
      connectionId: connection.id,
      modelId: 'synthetic-image',
      maxOutputTokens: 1024,
      temperature: null,
    }) as ModelPreset,
    { revision, ...settings } = fixtureSettings({
      generator: 'codex',
      codex: { model: { id: model.id }, useReferences: true },
    });
  updateIllustrationSettings(store, { expectedRevision: revision, ...settings }, true);
  const job = reserveIllustration(store, source, 'manual'),
    claimed = claimIllustration(store, job.id, 'illustration-backup-worker')!;
  expect(
    completeIllustration(
      store,
      job.id,
      claimed.job.generation,
      'illustration-backup-worker',
      [
        {
          mime: 'image/png',
          bytes: Buffer.from(PNG_BASE64, 'base64'),
          caption: `Literal ${asset.url}.`,
        },
      ],
      { stage: 'store', attempts: [], retries: [] }
    )
  ).toBe(true);
  const original = store.product.export().tables,
    backup = exportChatBackup(store, chat.id);
  for (let index = 0; index < 2; index += 1) {
    const copied = importChatBackup(target, { backup, idempotencyKey: randomUUID() }).chat,
      copiedAsset = target.product.assets(copied.id)[0],
      references = frozenIllustrationReferences(target, copied.id),
      copiedJob = illustrationsForChat(target, copied.id)[0],
      frozen = illustrationJob(target, copiedJob.id).input.codex!.references[0];
    expect(illustrationReferences(target, copied.id).references).toEqual([
      { ref: copiedAsset.id, role: 'character' },
    ]);
    expect(references).toHaveLength(1);
    expect(frozen).toEqual({
      ...job.input.codex!.references[0],
      ref: copiedAsset.id,
      url: copiedAsset.url,
    });
    expect(loadIllustrationReference(target, frozen)?.bytes).toEqual(
      Buffer.from(PNG_BASE64, 'base64')
    );
    expect(copiedJob.images[0].caption).toBe(`Literal ${asset.url}.`);
    expect(copiedJob.images[0].hash).toBe(asset.hash);
    expect(exportChatBackup(target, copied.id).records.illustrationImages).toHaveLength(1);
  }
  expect(store.product.export().tables).toEqual(original);
});
