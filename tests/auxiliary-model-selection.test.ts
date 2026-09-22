import { readStoredRunSnapshot } from '../server/run-projections.js';
import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { validateModelSnapshot } from '../server/provider-archive.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { frozenImageSelection } from '../server/package-images.js';
import { auxiliaryBridge } from '../server/auxiliary-bridge.js';
import { Controls } from '../server/controls.js';
import { createFixtureChat } from './fixtures/chat.js';

const owned: { path: string; store: Store }[] = [];
afterEach(() => {
  for (const { path, store } of owned.splice(0)) {
    store.close();
    const within = relative(tmpdir(), path);
    if (isAbsolute(within) || within.startsWith('..') || !within.startsWith('uimori-aux-model-'))
      throw new Error('Unsafe cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
function database() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-aux-model-'));
  const store = new Store(join(path, 'story.sqlite'));
  owned.push({ path, store });
  return store;
}

test('new auxiliary reservations use current generation models while JEV judgments stay separate and prior Runs remain frozen', async () => {
  const store = database();
  const chat = createFixtureChat(store, 'Auxiliary model projection');
  const profile = store.product.snapshot(chat.id);
  const run = store.createRun(
    chat.id,
    {
      request: 'Synthetic request before auxiliary models are selected',
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    () => ({
      chatId: chat.id,
      parentRevision: chat.headRevision,
      settingsRevision: chat.settingsRevision,
      settings: chat.settings,
      request: 'Synthetic request before auxiliary models are selected',
      history: [],
      resources: [],
      profile,
    })
  ).run;
  store.startRun(run.id);
  const source = store.completeRun(
    run.id,
    'Synthetic source with no external provider call.',
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
  const priorRun = store.run(run.id);
  const persisted = readStoredRunSnapshot(store, run.id);
  expect(priorRun.snapshot.profile?.models).toEqual({});
  const connection = store.product.connection({
    title: 'Synthetic Vertex connection',
    protocol: 'vertex-gemini-v1',
    endpoint:
      'https://aiplatform.googleapis.com/v1/projects/synthetic-project/locations/global/publishers/google/models',
    enabled: true,
  });
  const models = Object.fromEntries(
    ['translation', 'status'].map((role) => {
      const model = store.product.model({
        title: role,
        connectionId: connection.id,
        modelId: 'gemini-3.5-flash',
        maxOutputTokens: 2048,
        temperature: null,
      });
      return [role, model];
    })
  );
  const storedModels = store.db.prepare('SELECT * FROM provider_settings ORDER BY kind,id').all();
  const workspace = modelWorkspace(store);
  updateModelWorkspace(store, {
    expectedRevision: workspace.revision,
    routes: {
      main: null,
      translation: { id: models.translation.id },
      status: { id: models.status.id },
    },
    translationPolicy: { judgment: { threshold: 0.9 }, maxRetries: 1, maxCalls: 16 },
  });
  const translation = store.requestTranslation(source.id);
  const status = store.requestStatus(source.id, source.hash, null);
  const imageInput = frozenImageSelection(store, priorRun.snapshot);
  const imageSnapshot = store.product.resolveJobPrompt(priorRun.snapshot, imageInput);
  const bridge = auxiliaryBridge(store, new Controls(), new AbortController().signal);
  const translationBundle = await bridge.load(translation.id);
  const statusBundle = await bridge.load(status.id);
  const targets = {
    translation: translationBundle.snapshot.profile?.models.translation,
    status: statusBundle.snapshot.profile?.models.status,
  };
  for (const [role, target] of Object.entries(targets)) {
    expect(target).toEqual({ ...models[role], connection });
    expect(target).not.toHaveProperty('capabilityRevision');
    expect(validateModelSnapshot(target)).toEqual(target);
  }
  expect(translationBundle.translationPolicy?.judgment).toMatchObject({ threshold: 0.9 });
  expect(Object.keys(imageSnapshot.profile?.models ?? {})).not.toContain('image');
  expect(translationBundle.snapshot.profile?.models.main).toBeUndefined();
  expect(statusBundle.snapshot.profile?.models.main).toBeUndefined();
  expect(imageSnapshot.profile?.models.main).toBeUndefined();
  expect(readStoredRunSnapshot(store, run.id)).toEqual(persisted);
  expect(store.db.prepare('SELECT * FROM provider_settings ORDER BY kind,id').all()).toEqual(
    storedModels
  );
});
