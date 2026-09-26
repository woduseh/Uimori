import { afterEach, describe, expect, test } from 'vitest';
import { Store } from '../server/store.js';
import { DATABASE_SCHEMA_VERSION } from '../server/database-schema.js';
import { HttpError } from '../server/request-validation.js';
import {
  cancelIllustration,
  claimIllustration,
  claimIllustrationForReconcile,
  completeIllustration,
  failIllustration,
  frozenIllustrationReferences,
  illustrationJob,
  illustrationReferences,
  illustrationSettings,
  illustrationsForSources,
  illustrationSlots,
  loadIllustrationReference,
  recoverIllustrations,
  removeIllustration,
  requeueIllustration,
  reserveIllustration,
  retryIllustration,
  updateIllustrationReferences,
  updateIllustrationSettings,
} from '../server/illustrations.js';
import type { Connection, ModelPreset } from '../core/product.js';
import {
  chatWithSource,
  completedSource,
  fixtureSettings,
  illustrationDatabases,
  PNG_BASE64,
} from './fixtures/illustration.js';
import { FIXTURE_WORKFLOW } from './fixtures/comfyui-server.js';

const databases = illustrationDatabases('uimori-illustration-store-');
afterEach(() => databases.cleanup());
const PNG = Buffer.from(PNG_BASE64, 'base64');
const generated = (caption = '캡션') => [{ mime: 'image/png' as const, bytes: PNG, caption }];
const diagnostic = () => ({ stage: 'store' as const, attempts: [], retries: [] });
function complete(store: Store, id: string, owner = 'worker') {
  const claimed = claimIllustration(store, id, owner)!;
  expect(claimed).not.toBeNull();
  expect(
    completeIllustration(store, id, claimed.job.generation, owner, generated(), diagnostic())
  ).toBe(true);
  return illustrationJob(store, id);
}
function http(fn: () => unknown): HttpError {
  try {
    fn();
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error('Expected HttpError');
}
function codexModel(store: Store) {
  const connection = store.product.connection({
    title: 'Codex',
    protocol: 'codex-app-server-v1',
    endpoint: 'codex://local',
    enabled: true,
  }) as Connection;
  return store.product.model({
    title: 'Codex image model',
    connectionId: connection.id,
    modelId: 'gpt-5.4',
    maxOutputTokens: 1024,
    temperature: null,
  }) as ModelPreset;
}

describe('integrated illustration audit regressions', () => {
  test('reconcile recovers completed remote work at the generation limit without bypassing active work', () => {
    const store = databases.create();
    const { source } = chatWithSource(store);
    const { revision, ...body } = fixtureSettings({ maxPerSource: 1 });
    updateIllustrationSettings(store, { expectedRevision: revision, ...body }, true);
    const old = reserveIllustration(store, source, 'manual', { testMode: true });
    cancelIllustration(store, old.id);
    store.db
      .prepare(
        "UPDATE illustration_jobs SET input=json_set(input,'$.generator','comfyui','$.comfyui',json(?)),diagnostic=json(?) WHERE id=?"
      )
      .run(
        JSON.stringify({ baseUrl: 'http://comfy.example.test', authorizationEnv: '' }),
        JSON.stringify({ ...diagnostic(), comfyui: { promptId: 'accepted-prompt' } }),
        old.id
      );
    const active = reserveIllustration(store, source, 'manual', { testMode: true });
    expect(() => claimIllustrationForReconcile(store, old.id, 'reconcile')).toThrow(
      'ILLUSTRATION_ACTIVE'
    );
    complete(store, active.id);
    expect(() => retryIllustration(store, old.id)).toThrow('ILLUSTRATION_LIMIT_REACHED');
    const recovered = claimIllustrationForReconcile(store, old.id, 'reconcile');
    expect(recovered.job.status).toBe('running');
    expect(
      completeIllustration(
        store,
        old.id,
        recovered.job.generation,
        'reconcile',
        generated(),
        diagnostic()
      )
    ).toBe(true);
    expect(illustrationsForSources(store, [source.id]).flatMap((item) => item.images)).toHaveLength(
      2
    );
    expect(() => claimIllustrationForReconcile(store, old.id, 'reconcile')).toThrow(
      'ILLUSTRATION_NOT_RECONCILABLE'
    );
    expect(() => reserveIllustration(store, source, 'manual', { testMode: true })).toThrow(
      'ILLUSTRATION_LIMIT_REACHED'
    );
  });

  test('the final storage boundary rejects MIME mismatches and oversized bytes without partial storage', () => {
    const store = databases.create();
    const { source } = chatWithSource(store);
    const job = reserveIllustration(store, source, 'manual', {
      testMode: true,
      settings: fixtureSettings(),
    });
    const claimed = claimIllustration(store, job.id, 'worker')!;
    for (const invalid of [
      { mime: 'image/jpeg' as const, bytes: PNG, caption: '' },
      {
        mime: 'image/png' as const,
        bytes: Buffer.concat([PNG, Buffer.alloc(64 * 1024 * 1024)]),
        caption: '',
      },
    ]) {
      expect(() =>
        completeIllustration(
          store,
          job.id,
          claimed.job.generation,
          'worker',
          [...generated(), invalid],
          diagnostic()
        )
      ).toThrow('ILLUSTRATION_IMAGE_INVALID');
      expect(illustrationsForSources(store, [source.id])[0].images).toEqual([]);
    }
  });
});

describe('illustration storage on the current schema', () => {
  test('fresh databases create illustration tables and current databases reopen them', () => {
    const store = databases.create();
    const tables = () =>
      (
        store.db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'illustration_%' ORDER BY name"
          )
          .all() as { name: string }[]
      ).map((row) => row.name);
    expect(tables()).toEqual([
      'illustration_images',
      'illustration_jobs',
      'illustration_references',
      'illustration_settings',
    ]);
    expect(store.db.prepare('PRAGMA user_version').get()).toEqual({
      user_version: DATABASE_SCHEMA_VERSION,
    });
    expect(illustrationSettings(store)).toMatchObject({
      revision: 1,
      generator: 'none',
      automatic: false,
    });
    const path = store.path;
    store.close();
    const reopened = new Store(path);
    try {
      expect(reopened.db.prepare('PRAGMA user_version').get()).toEqual({
        user_version: DATABASE_SCHEMA_VERSION,
      });
      expect(illustrationSettings(reopened).generator).toBe('none');
      expect(reopened.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      reopened.close();
    }
  });
  test('settings save with CAS, reject unusable generators and check selected models', () => {
    const store = databases.create();
    const base = fixtureSettings();
    const { revision: _revision, ...body } = base;
    expect(
      http(() => updateIllustrationSettings(store, { expectedRevision: 5, ...body }, true))
        .statusCode
    ).toBe(409);
    expect(
      http(() => updateIllustrationSettings(store, { expectedRevision: 1, ...body }, false)).message
    ).toBe('Fixture generator requires test mode');
    const saved = updateIllustrationSettings(store, { expectedRevision: 1, ...body }, true);
    expect(saved.revision).toBe(2);
    expect(illustrationSettings(store)).toEqual(saved);
    const comfy = {
      ...body,
      generator: 'comfyui' as const,
      comfyui: { ...body.comfyui, baseUrl: 'http://10.0.0.5:8188/', workflow: '{"nodes":[]}' },
    };
    expect(
      http(() => updateIllustrationSettings(store, { expectedRevision: 2, ...comfy }, true)).message
    ).toBe('COMFYUI_WORKFLOW_UI_FORMAT');
    const valid = updateIllustrationSettings(
      store,
      { expectedRevision: 2, ...comfy, comfyui: { ...comfy.comfyui, workflow: FIXTURE_WORKFLOW } },
      true
    );
    expect(valid.comfyui.baseUrl).toBe('http://10.0.0.5:8188');
    expect(
      http(() =>
        updateIllustrationSettings(
          store,
          { expectedRevision: 3, ...body, comfyui: { ...body.comfyui, baseUrl: 'ftp://x' } },
          true
        )
      ).message
    ).toBe('COMFYUI_BASE_URL_INVALID');
    const other = store.product.connection({
      title: 'Chat',
      protocol: 'openai-chat-v1',
      endpoint: 'https://api.openai.com/v1',
      enabled: true,
    }) as Connection;
    const text = store.product.model({
      title: 'Text',
      connectionId: other.id,
      modelId: 'gpt-x',
      maxOutputTokens: 512,
      temperature: null,
    }) as ModelPreset;
    expect(
      http(() =>
        updateIllustrationSettings(
          store,
          {
            expectedRevision: 3,
            ...body,
            generator: 'codex',
            codex: { model: { id: text.id }, useReferences: true },
          },
          true
        )
      ).message
    ).toContain('Codex 연결의 모델 프리셋');
    const codex = codexModel(store);
    const withCodex = updateIllustrationSettings(
      store,
      {
        expectedRevision: 3,
        ...body,
        generator: 'codex',
        codex: { model: { id: codex.id }, useReferences: false },
      },
      true
    );
    expect(withCodex.codex).toEqual({ model: { id: codex.id }, useReferences: false });
    expect(
      http(() =>
        updateIllustrationSettings(store, { expectedRevision: 4, ...body, extra: 1 }, true)
      ).statusCode
    ).toBe(400);
  });
  test('reservation freezes the generator, allows one active job per response and enforces the per-response limit', () => {
    const store = databases.create();
    const { source } = chatWithSource(store);
    const settings = fixtureSettings({ maxPerSource: 2, maxAutoRetries: 3, styleGuidance: 'ink' });
    expect(
      http(() =>
        reserveIllustration(store, source, 'manual', {
          settings: fixtureSettings({ generator: 'none' }),
        })
      ).message
    ).toBe('ILLUSTRATION_GENERATOR_UNCONFIGURED');
    expect(http(() => reserveIllustration(store, source, 'manual', { settings })).message).toBe(
      'ILLUSTRATION_GENERATOR_UNCONFIGURED'
    );
    const first = reserveIllustration(store, source, 'manual', {
      settings,
      testMode: true,
      fixture: { failures: 2 },
    });
    expect(first).toMatchObject({ status: 'queued', origin: 'manual', attempt: 1, generation: 0 });
    expect(first.input).toEqual({
      version: 1,
      generator: 'fixture',
      settingsRevision: 1,
      styleGuidance: 'ink',
      maxAutoRetries: 3,
      fixture: { failures: 2, delayMs: 0 },
    });
    expect(
      http(() => reserveIllustration(store, source, 'manual', { settings, testMode: true })).message
    ).toBe('ILLUSTRATION_ACTIVE');
    complete(store, first.id);
    expect(illustrationSlots(store, source.id)).toEqual({ total: 1, active: 0 });
    const second = reserveIllustration(store, source, 'manual', { settings, testMode: true });
    complete(store, second.id);
    expect(
      http(() => reserveIllustration(store, source, 'manual', { settings, testMode: true })).message
    ).toBe('ILLUSTRATION_LIMIT_REACHED');
    const projected = illustrationsForSources(store, [source.id]);
    expect(projected).toHaveLength(2);
    expect(projected[0].images[0]).toMatchObject({
      mime: 'image/png',
      caption: '캡션',
      position: 0,
    });
    expect(projected[0].images[0].url).toBe(
      `/api/illustration-images/${projected[0].images[0].id}`
    );
    removeIllustration(store, first.id);
    expect(illustrationsForSources(store, [source.id])).toHaveLength(1);
    expect(reserveIllustration(store, source, 'manual', { settings, testMode: true }).status).toBe(
      'queued'
    );
    expect(store.events(source.chatId, 0).map((event) => (event as { kind: string }).kind)).toEqual(
      expect.arrayContaining([
        'illustration.queued',
        'illustration.running',
        'illustration.completed',
        'source.illustrations',
      ])
    );
  });
  test('automatic scheduling reserves one job per completed response and records configuration failures as visible jobs', () => {
    const store = databases.create();
    const { chat, source: manualOnly } = chatWithSource(store);
    expect(illustrationsForSources(store, [manualOnly.id])).toEqual([]);
    const { revision, ...body } = fixtureSettings({ automatic: true });
    updateIllustrationSettings(store, { expectedRevision: revision, ...body }, true);
    const automatic = completedSource(store, chat.id, 'Second scene.');
    expect(illustrationsForSources(store, [automatic.id])).toMatchObject([
      { origin: 'automatic', status: 'queued', generator: 'fixture' },
    ]);
    const codex = codexModel(store);
    updateIllustrationSettings(
      store,
      {
        expectedRevision: 2,
        ...body,
        generator: 'codex',
        codex: { model: null, useReferences: true },
      },
      true
    );
    const misconfigured = completedSource(store, chat.id, 'Third scene.');
    expect(illustrationsForSources(store, [misconfigured.id])).toMatchObject([
      {
        origin: 'automatic',
        status: 'failed',
        error: 'ILLUSTRATION_MODEL_REQUIRED',
        generator: 'codex',
      },
    ]);
    updateIllustrationSettings(
      store,
      {
        expectedRevision: 3,
        ...body,
        generator: 'codex',
        codex: { model: { id: codex.id }, useReferences: true },
      },
      true
    );
    const frozen = completedSource(store, chat.id, 'Fourth scene.');
    const job = illustrationJob(store, illustrationsForSources(store, [frozen.id])[0].id);
    expect(job.input.codex?.model.modelId).toBe('gpt-5.4');
    expect(job.input.codex?.model.connection.protocol).toBe('codex-app-server-v1');
    updateIllustrationSettings(
      store,
      { expectedRevision: 4, ...body, generator: 'none', automatic: true },
      true
    );
    const disabled = completedSource(store, chat.id, 'Fifth scene.');
    expect(illustrationsForSources(store, [disabled.id])).toEqual([]);
  });
  test('retry, requeue, cancel, remove and recovery keep terminal states distinct and ignore late workers', () => {
    const store = databases.create();
    const { source } = chatWithSource(store);
    const settings = fixtureSettings({ maxPerSource: 4 });
    const job = reserveIllustration(store, source, 'manual', { settings, testMode: true });
    const first = claimIllustration(store, job.id, 'worker')!;
    expect(first.source.text).toBe(source.text);
    expect(claimIllustration(store, job.id, 'other')).toBeNull();
    expect(
      requeueIllustration(
        store,
        job.id,
        first.job.generation,
        'worker',
        'FIXTURE_FAILURE',
        diagnostic()
      )
    ).toBe(true);
    expect(illustrationJob(store, job.id)).toMatchObject({
      status: 'queued',
      attempt: 2,
      error: null,
    });
    expect(illustrationJob(store, job.id).diagnostic?.retries).toEqual([
      { attempt: 1, code: 'FIXTURE_FAILURE', at: expect.any(String) },
    ]);
    const second = claimIllustration(store, job.id, 'worker')!;
    expect(
      failIllustration(
        store,
        job.id,
        second.job.generation,
        'worker',
        'failed',
        'COMFYUI_UNREACHABLE',
        diagnostic()
      )
    ).toBe(true);
    removeIllustration(store, job.id);
    expect(http(() => illustrationJob(store, job.id)).statusCode).toBe(404);
    const again = reserveIllustration(store, source, 'manual', { settings, testMode: true });
    const claimed = claimIllustration(store, again.id, 'worker')!;
    expect(http(() => retryIllustration(store, again.id)).message).toBe(
      'ILLUSTRATION_NOT_RETRYABLE'
    );
    expect(http(() => removeIllustration(store, again.id)).message).toBe('ILLUSTRATION_ACTIVE');
    const cancelled = cancelIllustration(store, again.id);
    expect(cancelled).toMatchObject({ status: 'cancelled', error: 'ILLUSTRATION_CANCELLED' });
    // The worker finishing after cancellation neither stores images nor changes the state.
    expect(
      completeIllustration(
        store,
        again.id,
        claimed.job.generation,
        'worker',
        generated(),
        diagnostic()
      )
    ).toBe(false);
    expect(illustrationJob(store, again.id).status).toBe('cancelled');
    expect(
      illustrationsForSources(store, [source.id]).find((item) => item.id === again.id)?.images
    ).toEqual([]);
    const retried = retryIllustration(store, again.id);
    expect(retried).toMatchObject({ status: 'queued', attempt: 2 });
    expect(retried.diagnostic?.retries).toEqual([
      { attempt: 1, code: 'ILLUSTRATION_CANCELLED', at: expect.any(String) },
    ]);
    claimIllustration(store, again.id, 'worker');
    recoverIllustrations(store);
    expect(illustrationJob(store, again.id)).toMatchObject({
      status: 'interrupted',
      error: 'ILLUSTRATION_INTERRUPTED',
      owner: null,
    });
    expect(retryIllustration(store, again.id).status).toBe('queued');
    cancelIllustration(store, again.id);
    removeIllustration(store, again.id);
    expect(http(() => illustrationJob(store, again.id)).statusCode).toBe(404);
  });
  test('per-chat references save with CAS, freeze to hashes and load bytes for the worker', () => {
    const store = databases.create();
    const { chat, source } = chatWithSource(store);
    const asset = store.product.createAsset(chat.id, {
      title: 'Mira design',
      mime: 'image/png',
      base64: PNG_BASE64,
      description: '',
      actor: 'Mira',
      outfit: '',
      location: '',
      allowedUse: 'both',
    }) as { id: string; hash: string };
    expect(illustrationReferences(store, chat.id)).toEqual({
      chatId: chat.id,
      revision: 0,
      references: [],
    });
    expect(
      http(() =>
        updateIllustrationReferences(store, chat.id, {
          expectedRevision: 0,
          references: [{ ref: 'missing', role: 'character' }],
        })
      ).statusCode
    ).toBe(400);
    const saved = updateIllustrationReferences(store, chat.id, {
      expectedRevision: 0,
      references: [{ ref: asset.id, role: 'character' }],
    });
    expect(saved).toEqual({
      chatId: chat.id,
      revision: 1,
      references: [{ ref: asset.id, role: 'character' }],
    });
    expect(
      http(() =>
        updateIllustrationReferences(store, chat.id, { expectedRevision: 0, references: [] })
      ).statusCode
    ).toBe(409);
    const frozen = frozenIllustrationReferences(store, chat.id);
    expect(frozen).toEqual([
      {
        ref: asset.id,
        role: 'character',
        title: 'Mira design',
        mime: 'image/png',
        hash: asset.hash,
        url: `/api/assets/${asset.id}`,
      },
    ]);
    const loaded = loadIllustrationReference(store, frozen[0]);
    expect(loaded?.mime).toBe('image/png');
    expect(loaded?.bytes.equals(PNG)).toBe(true);
    expect(
      loadIllustrationReference(store, { ...frozen[0], hash: 'f'.repeat(64) })
    ).toBeUndefined();
    const codex = codexModel(store);
    const job = reserveIllustration(store, source, 'manual', {
      settings: fixtureSettings({
        generator: 'codex',
        codex: { model: { id: codex.id }, useReferences: true },
      }),
    });
    expect(job.input.codex?.references).toEqual(frozen);
    const withoutReferences = reserveIllustration(
      store,
      completedSource(store, chat.id, 'Next.'),
      'manual',
      {
        settings: fixtureSettings({
          generator: 'codex',
          codex: { model: { id: codex.id }, useReferences: false },
        }),
      }
    );
    expect(withoutReferences.input.codex?.references).toEqual([]);
  });
});
