import { updateTestProfile } from './fixtures/model-workspace.js';
import { createFixtureChat, injectWithFixtureBot } from './fixtures/chat.js';
import { resolveInlineImage } from '../web/image-placement.js';
import { afterEach, expect, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { Controls } from '../server/controls.js';
import { auxiliaryBridge } from '../server/auxiliary-bridge.js';
import { forkChat } from '../server/chat-fork.js';
import {
  catalogReaderAssets,
  readerImageAssets,
  decodeImage,
  imageCatalog,
  imageJobInput,
  packageImageRoutes,
  putImageBlob,
  requestImages,
  validateImageBlob,
} from '../server/package-images.js';
import { packageImages, type PackageImage } from '../core/package-images.js';
import type { ContentPackage, PackageRole } from '../core/content-package.js';
import type { Content } from '../core/product.js';
import { splitSource } from '../core/auxiliary.js';
import { readerDetail } from '../server/reader.js';

const owned: { directory: string; store: Store; app: FastifyInstance }[] = [];
afterEach(async () => {
  for (const item of owned.splice(0).reverse()) {
    await item.app.close();
    item.store.close();
    const path = resolve(item.directory),
      rel = relative(resolve(tmpdir()), path);
    if (
      isAbsolute(rel) ||
      rel.startsWith('..') ||
      !basename(path).startsWith('uimori-package-images-')
    )
      throw new Error('Unsafe fixture cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-package-images-'));
  const store = new Store(join(directory, 'synthetic.sqlite')),
    app = Fastify();
  packageImageRoutes(app, store, { publish: () => {}, pump: () => {} });
  owned.push({ directory, store, app });
  return { store, app };
}
// Small synthetic byte fixtures; no artwork or user files.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG1sAAAAASUVORK5CYII=',
  'base64'
);
const jpeg = Buffer.from([255, 216, 255, 217]);
const webp = Buffer.from([82, 73, 70, 70, 12, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 76, 0, 0, 0, 0]);
function image(store: Store): PackageImage {
  const blob = putImageBlob(store.product, { mime: 'image/png', base64: png.toString('base64') });
  return {
    id: 'smile',
    title: '미소',
    description: '창가에서 웃는 모습',
    blobHash: blob.hash,
    mime: blob.mime,
    allowedUse: 'both',
  };
}
function save(store: Store, images: PackageImage[], previous?: Content): Content {
  const pkg: ContentPackage = {
    version: 1,
    id: previous?.id ?? 'draft',
    revision: previous?.revision ?? 1,
    title: 'Synthetic sword',
    description: '',
    body: 'An ego sword.',
    lore: [],
    instructions: [],
    controls: [],
    transforms: [],
    images,
  };
  return store.product.content(
    {
      kind: 'persona',
      title: pkg.title,
      description: pkg.description,
      text: pkg.body,
      loading: 'pinned',
      relatedIds: [],
      package: pkg,
      ...(previous ? { expectedRevision: previous.revision } : {}),
    },
    previous?.id
  ) as Content;
}
function attach(
  store: Store,
  chatId: string,
  content: Content,
  roles: PackageRole[] = ['bot', 'persona', 'module']
) {
  const { chatId: _id, revision, ...profile } = store.product.profile(chatId);
  return updateTestProfile(store.product, chatId, {
    ...profile,
    expectedRevision: revision,
    image: true,
    packageAttachments: roles.map((role) => ({ id: content.id, revision: content.revision, role })),
  });
}
function begin(store: Store, chatId: string) {
  const chat = store.chat(chatId),
    profile = store.product.snapshot(chatId)!;
  const run = store.createRun(
    chatId,
    {
      request: 'Synthetic scene.',
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (selected) => ({
      chatId,
      parentRevision: selected.headRevision,
      settingsRevision: selected.settingsRevision,
      settings: { ...selected.settings, status: false },
      request: 'Synthetic scene.',
      history: store.history(selected.headRevision),
      resources: store.product.resources(chatId, profile),
      profile,
    })
  ).run;
  store.startRun(run.id);
  return run;
}
function finish(store: Store, run: ReturnType<typeof begin>) {
  return store.source(
    store.completeRun(
      run.id,
      'A smile by the window.',
      { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
      run.snapshot.settings
    ).id
  );
}
function imageJob(store: Store, sourceId: string) {
  const row = store.db
    .prepare(
      "SELECT id FROM jobs WHERE source_revision=? AND kind='image' ORDER BY revision DESC LIMIT 1"
    )
    .get(sourceId) as { id: string };
  return store.job(row.id);
}
function completeImage(store: Store, source: ReturnType<typeof finish>) {
  const job = imageJob(store, source.id),
    entries = imageCatalog(job.input),
    asset = entries.find((entry) => entry.ref.startsWith('package:'))!;
  const claimed = store.claimJob(job.id, 'worker', {})!;
  expect(
    store.completeJob(job.id, claimed.generation, 'worker', {
      mock: true,
      sourceRevision: source.id,
      sourceHash: source.hash,
      imageTarget: job.imageTarget,
      annotations: [
        {
          blockAnchor: splitSource(source)[0].anchor,
          assetRef: asset.ref,
          assetRevision: asset.revision,
          assetHash: asset.hash,
          presentationIntent: 'inline',
          caption: asset.caption,
        },
      ],
    })
  ).toBe(true);
  return store.job(job.id);
}

test('one reusable package supplies distinct bot, persona and module IDs without embedding image bytes', () => {
  const { store } = fixture(),
    item = image(store),
    content = save(store, [item]),
    chat = createFixtureChat(store, 'Synthetic', 'calm', { botId: content.id });
  attach(store, chat.id, content);
  const profile = store.product.snapshot(chat.id)!;
  const assets = packageImages(profile);
  expect(assets.map((asset) => asset.id)).toEqual(
    ['bot', 'persona', 'module'].map((role) => `package:${content.id}:${role}:${item.id}`)
  );
  expect(new Set(assets.map((asset) => asset.hash)).size).toBe(1);
  const input = imageJobInput(store, begin(store, chat.id).snapshot);
  expect(imageCatalog(input).filter((asset) => asset.ref.startsWith('package:'))).toHaveLength(3);
  expect(JSON.stringify({ profile, input })).not.toContain(png.toString('base64'));
  expect(JSON.stringify(input)).not.toContain('data:image');
});

test('source reservation and delayed worker keep old names and removed images; explicit reselection uses CAS', async () => {
  const { store } = fixture(),
    item = image(store),
    first = save(store, [item]),
    chat = createFixtureChat(store, 'Synthetic', 'calm', { botId: first.id });
  attach(store, chat.id, first);
  const run = begin(store, chat.id),
    renamed = save(store, [{ ...item, title: '새 이름' }], first);
  attach(store, chat.id, renamed);
  const source = finish(store, run),
    initial = imageJob(store, source.id),
    frozen = imageCatalog(initial.input);
  expect(
    frozen.filter((asset) => asset.ref.startsWith('package:')).map((asset) => asset.alt)
  ).toEqual(['미소', '미소', '미소']);
  const removed = save(store, [], renamed);
  attach(store, chat.id, removed);
  const loaded = await auxiliaryBridge(store, new Controls(), new AbortController().signal).load(
    initial.id
  );
  expect(loaded.assets).toEqual(frozen);
  const command = { expectedSourceHash: source.hash, expectedRevision: initial.revision };
  expect(requestImages(store, source.id, command).id).toBe(initial.id);
  expect(() =>
    requestImages(store, source.id, { ...command, expectedSourceHash: 'wrong' })
  ).toThrow();
  expect(() => requestImages(store, source.id, { ...command, expectedRevision: 0 })).toThrow();
  completeImage(store, source);
  const next = requestImages(store, source.id, command);
  expect(next).toMatchObject({
    id: initial.id,
    status: 'queued',
    revision: initial.revision! + 1,
    result: null,
  });
  expect(imageCatalog(next.input).some((asset) => asset.ref.startsWith('package:'))).toBe(false);
  expect(store.product.get<Content>('content', first.id, first.revision).package!.images).toEqual([
    item,
  ]);
  expect(() => requestImages(store, source.id, command)).toThrow();
});

test('blob decoding enforces allowed signatures, canonical encoding and the per-file size limit', () => {
  for (const [mime, bytes] of [
    ['image/png', png],
    ['image/jpeg', jpeg],
    ['image/webp', webp],
  ] as const)
    expect(decodeImage(mime, bytes.toString('base64')).bytes).toEqual(bytes);
  expect(() => decodeImage('image/svg+xml', png.toString('base64'))).toThrow();
  expect(() => decodeImage('image/jpeg', png.toString('base64'))).toThrow();
  expect(() => decodeImage('image/png', png.toString('base64') + '\n')).toThrow();
  const oversized = Buffer.alloc(2_000_001);
  png.copy(oversized);
  expect(() => decodeImage('image/png', oversized.toString('base64'))).toThrow();
  const broken = Buffer.from(webp);
  broken.writeUInt32LE(13, 4);
  expect(() => decodeImage('image/webp', broken.toString('base64'))).toThrow();
  const { store } = fixture(),
    blob = putImageBlob(store.product, { mime: 'image/png', base64: png.toString('base64') });
  expect(() => validateImageBlob({ ...blob, hash: '0'.repeat(64) })).toThrow();
  expect(() => validateImageBlob({ ...blob, revision: 2 })).toThrow();
  expect(
    putImageBlob(store.product, { mime: 'image/png', base64: png.toString('base64') })
  ).toEqual(blob);
});

test('bundle prepare validates every reference and rolls back inserted blobs on a later mismatch', async () => {
  const original = fixture(),
    content = save(original.store, [image(original.store)]);
  const exported = await injectWithFixtureBot(original.app, {
    method: 'POST',
    url: '/api/package-bundles/export',
    payload: { package: content.package },
  });
  expect(exported.statusCode).toBe(200);
  const bundle = exported.json(),
    target = fixture();
  for (const forge of [
    (b: any) => {
      b.images = [];
    },
    (b: any) => {
      b.images[0].hash = '0'.repeat(64);
    },
    (b: any) => {
      b.images[0].revision = 2;
    },
    (b: any) => {
      b.package.images[0].mime = 'image/jpeg';
    },
  ]) {
    const corrupted = structuredClone(bundle);
    forge(corrupted);
    const before = target.store.product.export().tables;
    const response = await injectWithFixtureBot(target.app, {
      method: 'POST',
      url: '/api/package-bundles/prepare',
      payload: corrupted,
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(target.store.product.export().tables).toEqual(before);
  }
  const prepared = await injectWithFixtureBot(target.app, {
    method: 'POST',
    url: '/api/package-bundles/prepare',
    payload: bundle,
  });
  expect(prepared.statusCode).toBe(200);
  expect(prepared.json().package).toEqual(content.package);
  expect(() => save(fixture().store, content.package!.images!)).toThrow();
});

test('completed package images survive fork and archive, and forged or missing blob records roll back', () => {
  const { store } = fixture(),
    item = image(store),
    content = save(store, [item]),
    chat = createFixtureChat(store, 'Synthetic', 'calm', { botId: content.id });
  attach(store, chat.id, content);
  const source = finish(store, begin(store, chat.id));
  const before = completeImage(store, source);
  const copied = forkChat(store, chat.id, {
    fromRevision: source.id,
    idempotencyKey: 'image-fork',
  });
  const detail = store.detail(copied.id),
    copiedSource = detail.sources[0],
    copiedJob = detail.jobs.find((job) => job.kind === 'image')!;
  expect(copiedJob.result?.annotations?.[0]).toMatchObject({
    assetRef: before.result!.annotations![0].assetRef,
    assetHash: item.blobHash,
    blockAnchor: splitSource(copiedSource)[0].anchor,
  });
  expect(
    catalogReaderAssets(copied.id, store.job(copiedJob.id).input).find(
      (asset) => asset.id === before.result!.annotations![0].assetRef
    )
  ).toMatchObject({ chatId: copied.id, hash: item.blobHash, revision: content.revision });
  const archive = store.product.export(),
    restored = fixture();
  expect(restored.store.product.import(archive)).toEqual({ restored: true, chats: 2 });
  expect(restored.store.detail(copied.id)).toEqual(detail);
  for (const forge of [
    (a: any) => {
      a.tables.versions = a.tables.versions.filter((row: any) => row.kind !== 'package-image');
    },
    (a: any) => {
      const row = a.tables.versions.find((r: any) => r.kind === 'package-image');
      const body = JSON.parse(row.body);
      body.hash = '0'.repeat(64);
      row.body = JSON.stringify(body);
    },
    (a: any) => {
      const row = a.tables.versions.find((r: any) => r.kind === 'package-image');
      row.revision = 2;
    },
  ]) {
    const target = fixture(),
      corrupted = structuredClone(archive);
    forge(corrupted);
    const baseline = target.store.product.export().tables;
    expect(() => target.store.product.import(corrupted)).toThrow();
    expect(target.store.product.export().tables).toEqual(baseline);
  }
});

test('one Reader page retains different revisions of the same package image ref and resolves exact hashes', () => {
  const { store } = fixture(),
    oldImage = image(store),
    first = save(store, [oldImage]),
    chat = createFixtureChat(store, 'Synthetic', 'calm', { botId: first.id });
  attach(store, chat.id, first, ['bot']);
  const older = finish(store, begin(store, chat.id));
  completeImage(store, older);
  const newBlob = putImageBlob(store.product, {
    mime: 'image/webp',
    base64: webp.toString('base64'),
  });
  const newImage = { ...oldImage, title: '새 모습', blobHash: newBlob.hash, mime: newBlob.mime };
  const second = save(store, [newImage], first);
  attach(store, chat.id, second, ['bot']);
  const newer = finish(store, begin(store, chat.id));
  completeImage(store, newer);
  const ref = `package:${first.id}:bot:${oldImage.id}`,
    assets = readerImageAssets(store, chat.id, [older.id, newer.id]).filter(
      (asset) => asset.id === ref
    );
  expect(assets).toHaveLength(2);
  expect(assets.map((asset) => asset.revision).sort()).toEqual([first.revision, second.revision]);
  expect(
    resolveInlineImage(assets, chat.id, {
      assetRef: ref,
      assetRevision: first.revision,
      assetHash: oldImage.blobHash,
      presentationIntent: 'inline',
    })
  ).toMatchObject({ title: oldImage.title, hash: oldImage.blobHash });
  expect(
    resolveInlineImage(assets, chat.id, {
      assetRef: ref,
      assetRevision: second.revision,
      assetHash: newImage.blobHash,
      presentationIntent: 'inline',
    })
  ).toMatchObject({ title: newImage.title, hash: newImage.blobHash });
  expect(
    resolveInlineImage(assets, chat.id, {
      assetRef: ref,
      assetRevision: first.revision,
      assetHash: newImage.blobHash,
      presentationIntent: 'inline',
    })
  ).toBeUndefined();
});

test('Reader and detail expose each explicitly selected fixture module, chat and bot image version once', () => {
  const { store } = fixture(),
    content = save(store, [image(store)]),
    chat = createFixtureChat(store, 'Synthetic image projection', 'calm', { botId: content.id });
  attach(store, chat.id, content, ['bot']);
  const fixtureModule = save(store, [
    { ...image(store), id: 'synthetic-scene', title: 'Explicit fixture scene' },
  ]);
  const { chatId: _id, revision, ...profile } = store.product.profile(chat.id);
  updateTestProfile(store.product, chat.id, {
    ...profile,
    expectedRevision: revision,
    packageAttachments: [
      ...(profile.packageAttachments ?? []),
      { id: fixtureModule.id, revision: fixtureModule.revision, role: 'module' },
    ],
  });
  const uploaded = store.product.createAsset(chat.id, {
    title: 'Uploaded scene',
    description: 'Synthetic',
    mime: 'image/png',
    base64: png.toString('base64'),
    actor: '',
    outfit: '',
    location: '',
    allowedUse: 'inline',
  });
  const source = finish(store, begin(store, chat.id)),
    job = imageJob(store, source.id);
  const chosen = imageCatalog(job.input).filter(
    (asset) => asset.ref === uploaded.id || asset.ref.startsWith('package:')
  );
  expect(chosen).toHaveLength(3);
  const annotations = chosen.map((asset) => ({
    blockAnchor: splitSource(source)[0].anchor,
    assetRef: asset.ref,
    assetRevision: asset.revision,
    assetHash: asset.hash,
    presentationIntent: 'inline' as const,
  }));
  const claimed = store.claimJob(job.id, 'projection-worker', {})!;
  expect(
    store.completeJob(job.id, claimed.generation, 'projection-worker', {
      mock: true,
      sourceRevision: source.id,
      sourceHash: source.hash,
      imageTarget: job.imageTarget,
      annotations,
    })
  ).toBe(true);
  for (const assets of [store.detail(chat.id).assets!, readerDetail(store, chat.id, {}).assets!]) {
    expect(
      new Set(assets.map((asset) => JSON.stringify([asset.id, asset.revision, asset.hash]))).size
    ).toBe(assets.length);
    for (const annotation of annotations)
      expect(resolveInlineImage(assets, chat.id, annotation)).toBeDefined();
  }
});
