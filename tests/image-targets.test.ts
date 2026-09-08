import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Store, type Job, type Source } from '../server/store.js';
import { splitSource, validatePresentation } from '../core/auxiliary.js';
import { Controls } from '../server/controls.js';
import { auxiliaryBridge } from '../server/auxiliary-bridge.js';
import { runAuxiliaryJob } from '../server/product-auxiliary.js';
import { forkChat } from '../server/chat-fork.js';
import { putImageBlob, requestImages } from '../server/package-images.js';
import { imageCatalog, imageJobInput } from '../server/package-images.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { createFixtureChat, fixtureBotInput } from './fixtures/chat.js';
import { updateTestProfile } from './fixtures/model-workspace.js';

const owned: { directory: string; store: Store }[] = [];
afterEach(() => {
  for (const { directory, store } of owned.splice(0)) {
    store.close();
    const path = resolve(directory),
      rel = relative(resolve(tmpdir()), path);
    if (isAbsolute(rel) || rel.startsWith('..') || !rel.startsWith('uimori-image-targets-'))
      throw new Error('Unsafe synthetic fixture cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
function database() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-image-targets-'));
  const store = new Store(join(directory, 'synthetic.sqlite'));
  owned.push({ directory, store });
  return store;
}
function fixture(
  options: {
    images?: boolean;
    image?: boolean;
    imageTranslation?: boolean;
    portraitOnly?: boolean;
  } = {}
) {
  const store = database();
  const bot = fixtureBotInput('Synthetic image target owner');
  if (options.images !== false) {
    const blob = putImageBlob(store.product, {
      mime: 'image/png',
      base64:
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG1sAAAAASUVORK5CYII=',
    });
    bot.package.images = [
      {
        id: 'window',
        title: 'Window',
        description: 'A sunny window',
        blobHash: blob.hash,
        mime: blob.mime,
        allowedUse: options.portraitOnly ? 'both' : 'inline',
      },
    ];
    if (options.portraitOnly) bot.package.portraitImageId = 'window';
  }
  const content = store.product.content(bot);
  const chat = createFixtureChat(store, 'Synthetic image targets', 'calm', { botId: content.id });
  {
    const { chatId: _id, revision, ...profile } = store.product.profile(chat.id);
    updateTestProfile(store.product, chat.id, {
      ...profile,
      expectedRevision: revision,
      packageAttachments: [{ id: content.id, revision: content.revision, role: 'bot' }],
      ...(options.image !== undefined ? { image: options.image } : {}),
      ...(options.imageTranslation !== undefined
        ? { imageTranslation: options.imageTranslation }
        : {}),
    });
  }
  const profile = store.product.snapshot(chat.id)!;
  const run = store.createRun(
    chat.id,
    {
      request: 'Synthetic scene',
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (selected) => ({
      chatId: chat.id,
      parentRevision: selected.headRevision,
      settingsRevision: selected.settingsRevision,
      settings: { ...selected.settings, status: false },
      request: 'Synthetic scene',
      history: [],
      profile,
      resources: store.product.resources(chat.id, profile),
    })
  ).run;
  store.startRun(run.id);
  const source = store.source(
    store.completeRun(
      run.id,
      'Original window.\n\nOriginal garden.',
      { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
      run.snapshot.settings
    ).id
  );
  return { store, source, chat };
}
const translated = '번역된 창가 장면.\n\n번역된 정원 장면.';
function translate(store: Store, source: Source) {
  const job = store.requestTranslation(source.id);
  const claimed = store.claimJob(job.id, 'translation-fixture', {})!;
  expect(
    store.completeJob(job.id, claimed.generation, 'translation-fixture', {
      mock: true,
      sourceRevision: source.id,
      sourceHash: source.hash,
      text: translated,
    })
  ).toBe(true);
  return store.job(job.id);
}
function images(store: Store, source: Source) {
  return store.detail(source.chatId).jobs.filter((job) => job.kind === 'image');
}
function target(job: Job) {
  return (
    job.input as {
      imageTarget?: {
        mode: string;
        textHash: string;
        translationJobId?: string;
        translationRevision?: number;
      };
    }
  ).imageTarget;
}
function selectTranslation(store: Store, source: Source, translation: Job, expectedRevision = 0) {
  return requestImages(store, source.id, {
    target: 'translation',
    expectedSourceHash: source.hash,
    expectedRevision,
    expectedTranslationJobId: translation.id,
    expectedTranslationRevision: translation.revision,
  });
}
async function finishImage(store: Store, job: Job) {
  const bundle = await auxiliaryBridge(store, new Controls(), new AbortController().signal).load(
    job.id
  );
  const selected = bundle.imageSource!;
  const asset = bundle.assets![0];
  const presentation = validatePresentation(
    selected,
    {
      sourceRevision: selected.id,
      sourceHash: selected.hash,
      entries: [
        {
          blockAnchor: splitSource(selected)[0].anchor,
          assetRef: asset.ref,
          assetRevision: asset.revision,
          assetHash: asset.hash,
          presentationIntent: 'inline',
        },
      ],
    },
    bundle.assets
  );
  const claimed = store.claimJob(job.id, 'image-fixture', {})!;
  expect(
    store.completeJob(job.id, claimed.generation, 'image-fixture', {
      mock: true,
      sourceRevision: job.sourceRevision,
      sourceHash: job.sourceHash,
      imageTarget: target(job),
      annotations: presentation.entries,
    })
  ).toBe(true);
  expect(store.job(job.id).status).toBe('completed');
  return store.job(job.id);
}

test('defaults reserve images only after generated translation, never on original completion', () => {
  const { store, source, chat } = fixture();
  expect(store.product.profile(chat.id)).toMatchObject({ image: false, imageTranslation: true });
  expect(images(store, source)).toHaveLength(0);
  const translation = translate(store, source);
  expect(images(store, source)).toHaveLength(1);
  expect(target(images(store, source)[0])).toMatchObject({
    mode: 'translation',
    translationJobId: translation.id,
    translationRevision: translation.revision,
  });
});

test('the synthetic image worker preserves original provenance with a translation target', async () => {
  const { store, source } = fixture({ imageTranslation: false });
  const translation = translate(store, source);
  const job = selectTranslation(store, source, translation);
  await runAuxiliaryJob(
    auxiliaryBridge(store, new Controls(), new AbortController().signal),
    job.id,
    'synthetic-worker',
    {
      signal: new AbortController().signal,
      approvedOrigins: [],
      authorize: (connection) => connection,
      onAttemptStart: () => {
        throw new Error('Live calls forbidden');
      },
      onAttemptFinish: () => {},
    }
  );
  expect(store.job(job.id)).toMatchObject({
    status: 'completed',
    result: {
      sourceRevision: source.id,
      sourceHash: source.hash,
      imageTarget: target(job),
    },
  });
});

test('automatic translation placement respects its switch, catalog availability and direct edit boundary', () => {
  for (const options of [{ imageTranslation: false }, { images: false }]) {
    const { store, source } = fixture(options);
    translate(store, source);
    expect(images(store, source)).toHaveLength(0);
  }
  const { store, source } = fixture();
  store.editTranslation(source.id, {
    text: translated,
    expectedRevision: 0,
    expectedSourceHash: source.hash,
  });
  expect(images(store, source)).toHaveLength(0);
});

test('each view reads its own text and retains the other view when images are placed again', async () => {
  const { store, source } = fixture({ imageTranslation: false });
  const translation = translate(store, source);
  const original = requestImages(store, source.id, {
    expectedSourceHash: source.hash,
    expectedRevision: 0,
  });
  const localized = selectTranslation(store, source, translation);
  expect(localized.id).not.toBe(original.id);
  const bridge = auxiliaryBridge(store, new Controls(), new AbortController().signal);
  expect((await bridge.load(original.id)).imageSource?.text).toBe(source.text);
  expect((await bridge.load(localized.id)).imageSource?.text).toBe(translated);
  const originalCompleted = await finishImage(store, original);
  const translationCompleted = await finishImage(store, localized);
  expect(originalCompleted.result?.annotations?.length).toBeGreaterThan(0);
  expect(translationCompleted.result?.annotations?.length).toBeGreaterThan(0);
  selectTranslation(store, source, translation, translationCompleted.revision);
  expect(store.job(original.id)).toEqual(originalCompleted);
  expect(() =>
    selectTranslation(store, source, translation, translationCompleted.revision)
  ).toThrow();
});

test('translation edits invalidate only translated placement and fence an already running worker', async () => {
  const { store, source } = fixture({ imageTranslation: false });
  const translation = translate(store, source);
  const original = await finishImage(
    store,
    requestImages(store, source.id, {
      expectedSourceHash: source.hash,
      expectedRevision: 0,
    })
  );
  const localized = selectTranslation(store, source, translation);
  const claimed = store.claimJob(localized.id, 'late-worker', {})!;
  const manual = store.editTranslation(source.id, {
    text: '수정한 번역문.',
    expectedRevision: translation.revision!,
    expectedSourceHash: source.hash,
  });
  expect(store.job(localized.id).status).toBe('stale');
  expect(
    store.completeJob(localized.id, claimed.generation, 'late-worker', {
      mock: true,
      sourceRevision: source.id,
      sourceHash: source.hash,
      annotations: [],
    })
  ).toBe(false);
  expect(store.job(original.id)).toEqual(original);
  expect(images(store, source)).toHaveLength(2);
  expect(() => selectTranslation(store, source, translation, localized.revision)).toThrow();
  expect(target(selectTranslation(store, source, manual, localized.revision))).toMatchObject({
    mode: 'translation',
    translationJobId: manual.id,
    translationRevision: manual.revision,
  });
});

test('archive restores both views and fork remaps translation dependencies to copied jobs', async () => {
  const { store, source } = fixture({ imageTranslation: false });
  const translation = translate(store, source);
  const original = await finishImage(
    store,
    requestImages(store, source.id, {
      expectedSourceHash: source.hash,
      expectedRevision: 0,
    })
  );
  const localized = await finishImage(store, selectTranslation(store, source, translation));
  const archive = store.product.export();
  const restored = database();
  restored.product.import(archive);
  expect(restored.job(original.id)).toEqual(original);
  expect(restored.job(localized.id)).toEqual(localized);
  const fork = forkChat(store, source.chatId, {
    fromRevision: source.id,
    idempotencyKey: randomUUID(),
  });
  const detail = store.detail(fork.id);
  const copiedTranslation = detail.jobs.find((job) => job.kind === 'translation')!;
  const copiedImages = detail.jobs.filter((job) => job.kind === 'image');
  expect(copiedImages).toHaveLength(2);
  const copiedLocalized = copiedImages.find((job) => target(job)?.mode === 'translation')!;
  expect(target(copiedLocalized)).toMatchObject({
    translationJobId: copiedTranslation.id,
    translationRevision: copiedTranslation.revision,
  });
  expect(copiedTranslation.id).not.toBe(translation.id);
  const bridge = auxiliaryBridge(store, new Controls(), new AbortController().signal);
  expect((await bridge.load(copiedLocalized.id)).imageSource?.text).toBe(translated);
});

test('an unavailable image model records an image failure without rolling back translated text', () => {
  const { store, source } = fixture();
  const connection = store.product.connection({
    title: 'Synthetic image connection',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = store.product.model({
    title: 'Synthetic image model',
    connectionId: connection.id,
    modelId: 'synthetic-fixture',
    maxOutputTokens: 10000,
    temperature: 1,
  });
  const current = modelWorkspace(store);
  updateModelWorkspace(store, {
    expectedRevision: current.revision,
    routes: { ...current.routes, image: { id: model.id } },
    translationPolicy: current.translationPolicy,
  });
  store.product.model(
    {
      title: model.title,
      connectionId: model.connectionId,
      modelId: model.modelId,
      maxOutputTokens: 10000,
      temperature: 1,
      enabled: false,
      expectedRevision: model.revision,
    },
    model.id
  );
  const translation = translate(store, source);
  expect(translation).toMatchObject({ status: 'completed', result: { text: translated } });
  expect(images(store, source)).toHaveLength(1);
  expect(images(store, source)[0]).toMatchObject({
    status: 'failed',
    error: 'IMAGE_MODEL_UNAVAILABLE',
  });
});

test('pending and failed retranslations retain images until a successful replacement invalidates them', async () => {
  const { store, source } = fixture({ imageTranslation: false });
  const previous = translate(store, source);
  const image = await finishImage(store, selectTranslation(store, source, previous));
  const pending = store.retranslate(source.id);
  expect(store.job(image.id)).toEqual(image);
  const claimed = store.claimJob(pending.id, 'retry-fixture', {})!;
  store.failJob(pending.id, claimed.generation, 'retry-fixture', 'Synthetic translation failure');
  expect(store.job(image.id)).toEqual(image);
  const replacement = translate(store, source);
  expect(replacement.id).not.toBe(previous.id);
  expect(store.job(image.id).status).toBe('stale');
});

test('source edits preserve stale image evidence in archives and reject forged target hashes atomically', async () => {
  const { store, source } = fixture({ imageTranslation: false });
  const translation = translate(store, source);
  const original = await finishImage(
    store,
    requestImages(store, source.id, {
      expectedSourceHash: source.hash,
      expectedRevision: 0,
    })
  );
  const localized = await finishImage(store, selectTranslation(store, source, translation));
  store.editSource(source.id, {
    text: 'Changed original.',
    expectedRevision: source.editRevision!,
  });
  expect(store.job(original.id).status).toBe('stale');
  expect(store.job(localized.id).status).toBe('stale');
  const archive = store.product.export();
  const restored = database();
  restored.product.import(archive);
  expect(restored.job(localized.id).result).toEqual(localized.result);
  const corrupted: any = structuredClone(archive);
  const row = corrupted.tables.jobs.find((job: any) => job.id === localized.id);
  const input = JSON.parse(row.input);
  input.imageTarget.textHash = '0'.repeat(64);
  row.input = JSON.stringify(input);
  const rejected = database();
  expect(() => rejected.product.import(corrupted)).toThrow();
  expect(rejected.chats()).toHaveLength(0);
});

test('representative portraits and profile-only assets never enter the placement catalog', () => {
  const { store, source, chat } = fixture({ portraitOnly: true });
  store.product.createAsset(chat.id, {
    title: 'Synthetic portrait',
    mime: 'image/png',
    base64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64'),
    description: 'Profile only',
    actor: '',
    outfit: '',
    location: '',
    allowedUse: 'profile',
  });
  expect(imageCatalog(imageJobInput(store, store.run(source.runId).snapshot))).toHaveLength(0);
  translate(store, source);
  expect(images(store, source)).toHaveLength(0);
});
