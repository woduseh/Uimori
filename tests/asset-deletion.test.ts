import { createFixtureChat, injectWithFixtureBot } from './fixtures/chat.js';
import { afterEach, expect, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { Store } from '../server/store.js';
import { deleteChatAsset } from '../server/asset-deletion.js';
import { chatAssetRoutes } from '../server/chat-asset-routes.js';
import { imageJobInput } from '../server/package-images.js';
import { updateAssetMetadata } from '../server/asset-metadata.js';

const owned: { directory: string; store: Store; app: FastifyInstance }[] = [];
afterEach(async () => {
  for (const { directory, store, app } of owned.splice(0)) {
    await app.close();
    store.close();
    const target = resolve(directory),
      inside = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(inside) ||
      inside.startsWith('..') ||
      !basename(target).startsWith('uimori-asset-deletion-')
    )
      throw new Error('Unsafe fixture cleanup');
    rmSync(target, { recursive: true, force: true });
  }
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-asset-deletion-')),
    store = new Store(join(directory, 'synthetic.sqlite')),
    app = Fastify();
  owned.push({ directory, store, app });
  app.setErrorHandler((error, _request, reply) =>
    reply
      .code((error as { statusCode?: number }).statusCode ?? 500)
      .send({ message: (error as Error).message })
  );
  const published: string[] = [];
  chatAssetRoutes(app, store, (id) => published.push(id));
  const chat = createFixtureChat(store, 'Synthetic image deletion');
  const asset = store.product.createAsset(chat.id, {
    title: 'Unused synthetic image',
    mime: 'image/png',
    base64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64'),
    description: 'Synthetic',
    actor: '',
    outfit: '',
    location: '',
    allowedUse: 'both' as const,
  });
  return { store, app, chat, asset, published };
}
function begin(store: Store, chatId: string) {
  const chat = store.chat(chatId),
    profile = store.product.snapshot(chatId);
  return store.createRun(
    chatId,
    {
      request: 'Synthetic',
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: 'asset-run',
    },
    (selected) => ({
      chatId,
      parentRevision: selected.headRevision,
      settingsRevision: selected.settingsRevision,
      settings: selected.settings,
      request: 'Synthetic',
      history: [],
      resources: [],
      profile,
    })
  ).run;
}

test('a deletion through another chat preserves the uploaded bytes', async () => {
  const { store, app, asset, published } = fixture(),
    other = createFixtureChat(store, 'Other');
  expect(
    (
      await injectWithFixtureBot(app, {
        method: 'DELETE',
        url: `/api/chats/${other.id}/assets/${asset.id}`,
        payload: {},
      })
    ).statusCode
  ).toBe(409);
  expect(store.product.asset(asset.id).bytes).toHaveLength(8);
  expect(published).toEqual([]);
});

test('a screen that still shows a deleted image gets REVISION_CONFLICT for deletion and edits', () => {
  const { store, chat, asset } = fixture();
  const target = { chatId: chat.id, assetId: asset.id };
  deleteChatAsset(store, target);
  expect(() => deleteChatAsset(store, target)).toThrow('REVISION_CONFLICT');
  expect(() =>
    updateAssetMetadata(store, {
      ...target,
      expectedRevision: asset.revision,
      title: 'Renamed from a stale screen',
      description: '',
    })
  ).toThrow('REVISION_CONFLICT');
});

test('deletion preserves active execution and immutable completed image catalogs', () => {
  const { store, chat, asset } = fixture(),
    run = begin(store, chat.id);
  const input = imageJobInput(store, run.snapshot);
  expect(() => deleteChatAsset(store, { chatId: chat.id, assetId: asset.id })).not.toThrow();
  expect(store.product.assets(chat.id)).toEqual([]);
  store.startRun(run.id);
  const source = store.completeRun(run.id, 'Synthetic source.', {
    modelCalls: 0,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  });
  const now = new Date().toISOString();
  store.db
    .prepare(
      "INSERT INTO jobs(id,chat_id,source_revision,source_hash,kind,status,input,created_at,updated_at) VALUES(?,?,?,?,?,'completed',?,?,?)"
    )
    .run(
      'frozen-image-job',
      chat.id,
      source.id,
      source.hash,
      'image',
      JSON.stringify(input),
      now,
      now
    );
  expect(store.job('frozen-image-job').input).toEqual(input);
  expect(imageJobInput(store, run.snapshot)).not.toEqual(input);
  expect(store.product.asset(asset.id).bytes).toHaveLength(8);
});

test('the image bytes route answers a missing image with a refusal no cache keeps', async () => {
  const { app, asset } = fixture();
  const missing = await app.inject({ method: 'GET', url: '/api/assets/missing-image' });
  expect(missing.statusCode).toBe(404);
  expect(missing.headers['cache-control']).toBe('no-store');
  const served = await app.inject({ method: 'GET', url: `/api/assets/${asset.id}` });
  expect(served.statusCode).toBe(200);
  expect(served.headers['cache-control']).toBe('private, max-age=86400');
});
