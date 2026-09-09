import { afterEach, describe, expect, test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
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
  illustrationsForChat,
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
import { forkChat } from '../server/chat-fork.js';
import { chatDeletionImpact, deleteChat } from '../server/chat-deletion.js';
import type { Connection, ModelPreset } from '../core/product.js';
import {
  chatWithSource,
  completedSource,
  fixtureSettings,
  illustrationDatabases,
  PNG_BASE64,
} from './fixtures/illustration.js';
import { comfyUIFixture, FIXTURE_WORKFLOW } from './fixtures/comfyui-server.js';
import { loopbackProvider, writeSse } from './fixtures/loopback-provider.js';
import { runIllustrationJob } from '../server/illustration-runner.js';

const databases = illustrationDatabases('uimori-illustration-store-');
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  databases.cleanup();
});
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

async function executedComfyIllustration() {
  const store = databases.create();
  const { chat, source } = chatWithSource(store);
  const comfy = await comfyUIFixture({ authorization: 'Bearer synthetic' });
  cleanups.push(comfy.close);
  const provider = await loopbackProvider(async (_request, response) => {
    await writeSse(response, [
      {
        type: 'text_delta',
        delta: JSON.stringify({ prompt: 'synthetic lantern', caption: '등불' }),
      },
      { type: 'done', reason: 'stop' },
    ]);
  });
  cleanups.push(provider.close);
  const connection = store.product.connection({
    title: 'Archive prompt provider',
    protocol: 'fixture-sse-v1',
    endpoint: provider.endpoint,
    enabled: true,
  }) as Connection;
  const model = store.product.model({
    title: 'Archive prompt model',
    connectionId: connection.id,
    modelId: 'archive-prompt',
    maxOutputTokens: 512,
    temperature: null,
  }) as ModelPreset;
  const { revision, ...body } = fixtureSettings({
    generator: 'comfyui',
    automatic: true,
    comfyui: {
      baseUrl: comfy.origin,
      authorizationEnv: 'UIMORI_AUDIT_COMFY_SECRET',
      workflow: FIXTURE_WORKFLOW,
      promptModel: { id: model.id },
      timeoutMs: 10_000,
      pollIntervalMs: 250,
    },
  });
  updateIllustrationSettings(store, { expectedRevision: revision, ...body }, true);
  const job = reserveIllustration(store, source, 'manual');
  const result = await runIllustrationJob(store, job.id, 'archive-worker', {
    signal: new AbortController().signal,
    approvedOrigins: [provider.origin],
    resolveCredential: () => 'Bearer synthetic',
    resolveComfyCredential: () => 'Bearer synthetic',
    authorize: (value) => store.product.authorize(value),
    onAttemptStart: (wire) => store.product.startAttempt(chat.id, null, null, wire),
    onAttemptFinish: (id, value) => store.product.finishAttempt(id, value),
  });
  expect(result).toMatchObject({ status: 'completed', images: 1 });
  expect(provider.requests).toHaveLength(1);
  expect(comfy.prompts).toHaveLength(1);
  return { store, chat, source, job: illustrationJob(store, job.id) };
}

describe('integrated illustration audit regressions', () => {
  test('real provider attempts round-trip with a fork without duplicate ownership or replaying remote work', async () => {
    const { store, chat, source, job } = await executedComfyIllustration();
    const forked = forkChat(store, chat.id, {
      fromRevision: source.id,
      idempotencyKey: randomUUID(),
    });
    const copied = illustrationsForChat(store, forked.id)[0];
    expect(copied.diagnostic?.attempts).toEqual([]);
    const archive = store.product.export();
    const restored = databases.create();
    expect(() => restored.product.import(archive)).not.toThrow();
    const attemptId = job.diagnostic!.attempts[0];
    expect(
      restored.db.prepare('SELECT role,status,cost_usd FROM attempts WHERE id=?').get(attemptId)
    ).toMatchObject({ role: 'illustration', status: 'completed', cost_usd: null });
    expect(illustrationsForChat(restored, chat.id)[0].images[0].hash).toBe(
      illustrationsForChat(store, chat.id)[0].images[0].hash
    );
    expect(illustrationsForChat(restored, forked.id)[0].status).toBe('completed');
    removeIllustration(restored, job.id);
    expect(
      restored.db.prepare('SELECT id FROM attempts WHERE id=?').get(attemptId)
    ).toBeUndefined();
    const again = databases.create();
    expect(() => again.product.import(restored.product.export())).not.toThrow();
  });

  test('a real illustration attempt can be restored even without a fork', async () => {
    const { store } = await executedComfyIllustration();
    expect(() => databases.create().product.import(store.product.export())).not.toThrow();
  });

  test('restore disables global automation and removes ComfyUI authentication and frozen remote authority', () => {
    const store = databases.create();
    const { source } = chatWithSource(store);
    const model = codexModel(store);
    const { revision, ...body } = fixtureSettings({
      generator: 'comfyui',
      automatic: true,
      comfyui: {
        baseUrl: 'http://comfy.example.test:8188',
        authorizationEnv: 'PRODUCTION_AUTH',
        workflow: FIXTURE_WORKFLOW,
        promptModel: { id: model.id },
      },
    });
    updateIllustrationSettings(store, { expectedRevision: revision, ...body }, true);
    const job = reserveIllustration(store, source, 'manual');
    const restored = databases.create();
    restored.product.import(store.product.export());
    expect(illustrationSettings(restored)).toMatchObject({
      generator: 'none',
      automatic: false,
      comfyui: { authorizationEnv: '' },
    });
    expect(illustrationJob(restored, job.id).input.comfyui).toMatchObject({
      authorizationEnv: '',
      disabled: true,
    });
  });

  test.each(['mime', 'oversize', 'chat'] as const)(
    'restore rejects illustration image %s tampering atomically',
    (fault) => {
      const store = databases.create();
      const { source } = chatWithSource(store);
      complete(
        store,
        reserveIllustration(store, source, 'manual', {
          testMode: true,
          settings: fixtureSettings(),
        }).id
      );
      const other = chatWithSource(store, 'Other source');
      const archive = store.product.export();
      const row = archive.tables.illustration_images[0];
      if (fault === 'mime') row.mime = 'image/jpeg';
      if (fault === 'chat') row.chat_id = other.chat.id;
      if (fault === 'oversize') {
        const bytes = Buffer.concat([PNG, Buffer.alloc(16_000_001)]);
        row.bytes = bytes.toString('base64');
        row.hash = createHash('sha256').update(bytes).digest('hex');
      }
      const restored = databases.create();
      expect(() => restored.product.import(archive)).toThrow();
      expect(restored.db.prepare('SELECT COUNT(*) AS n FROM illustration_images').get()).toEqual({
        n: 0,
      });
    }
  );

  test('retry and reconcile cannot bypass active work or the current per-source limit', () => {
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
    expect(() => claimIllustrationForReconcile(store, old.id, 'reconcile')).toThrow(
      'ILLUSTRATION_LIMIT_REACHED'
    );
    const current = illustrationSettings(store);
    const { revision: currentRevision, ...currentBody } = current;
    updateIllustrationSettings(
      store,
      { expectedRevision: currentRevision, ...currentBody, maxPerSource: 2 },
      true
    );
    expect(claimIllustrationForReconcile(store, old.id, 'reconcile').job.status).toBe('running');
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
        bytes: Buffer.concat([PNG, Buffer.alloc(16_000_001)]),
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

describe('illustration storage on schema 15', () => {
  test('fresh databases create the tables and an existing schema 15 database gains them on open without a version bump', () => {
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
    expect(store.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 15 });
    expect(illustrationSettings(store)).toMatchObject({ revision: 1, generator: 'none' });
    const path = store.path;
    store.close();
    const raw = new DatabaseSync(path);
    raw.exec(
      'DROP TABLE illustration_images; DROP TABLE illustration_jobs; DROP TABLE illustration_references; DROP TABLE illustration_settings;'
    );
    raw.close();
    const reopened = new Store(path);
    try {
      expect(reopened.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 15 });
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
  test('forks copy completed illustrations of the copied text, deletion removes rows and archives round-trip', () => {
    const store = databases.create();
    const { chat, source } = chatWithSource(store);
    const settings = fixtureSettings({ maxPerSource: 3 });
    const done = complete(
      store,
      reserveIllustration(store, source, 'manual', { settings, testMode: true }).id
    );
    const pending = reserveIllustration(store, source, 'manual', { settings, testMode: true });
    const forked = forkChat(store, chat.id, {
      fromRevision: source.id,
      idempotencyKey: randomUUID(),
    });
    const copied = illustrationsForChat(store, forked.id);
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatchObject({ status: 'completed', origin: 'manual', chatId: forked.id });
    expect(copied[0].id).not.toBe(done.id);
    expect(copied[0].images[0].hash).toBe(
      illustrationsForChat(store, chat.id).find((item) => item.id === done.id)!.images[0].hash
    );
    const bytes = store.db
      .prepare('SELECT bytes FROM illustration_images WHERE id=?')
      .get(copied[0].images[0].id) as { bytes: Uint8Array };
    expect(Buffer.from(bytes.bytes).equals(PNG)).toBe(true);
    expect(
      http(() => deleteChat(store, chat.id, chatDeletionImpact(store, chat.id).request)).statusCode
    ).toBe(409);
    cancelIllustration(store, pending.id);
    deleteChat(store, chat.id, chatDeletionImpact(store, chat.id).request);
    expect(
      store.db.prepare('SELECT COUNT(*) AS n FROM illustration_jobs WHERE chat_id=?').get(chat.id)
    ).toEqual({ n: 0 });
    expect(
      store.db.prepare('SELECT COUNT(*) AS n FROM illustration_images WHERE chat_id=?').get(chat.id)
    ).toEqual({ n: 0 });
    expect(illustrationsForChat(store, forked.id)).toHaveLength(1);
    const codex = codexModel(store);
    const { revision, ...body } = fixtureSettings({
      generator: 'codex',
      codex: { model: { id: codex.id }, useReferences: true },
    });
    updateIllustrationSettings(store, { expectedRevision: revision, ...body }, true);
    const frozen = reserveIllustration(
      store,
      completedSource(store, forked.id, 'Frozen scene.'),
      'manual'
    );
    const archive = store.product.export();
    expect(Object.keys(archive.tables)).toEqual(
      expect.arrayContaining([
        'illustration_settings',
        'illustration_jobs',
        'illustration_images',
        'illustration_references',
      ])
    );
    const restored = databases.create();
    restored.product.import(archive);
    expect(illustrationSettings(restored)).toEqual({
      ...illustrationSettings(store),
      generator: 'none',
      automatic: false,
      comfyui: { ...illustrationSettings(store).comfyui, authorizationEnv: '' },
    });
    const restoredJobs = illustrationsForChat(restored, forked.id);
    expect(restoredJobs.map((item) => item.status).sort()).toEqual(['completed', 'interrupted']);
    expect(restoredJobs.find((item) => item.status === 'completed')?.images[0].hash).toBe(
      copied[0].images[0].hash
    );
    const restoredFrozen = illustrationJob(restored, frozen.id);
    expect(restoredFrozen.input.codex?.model.connection.enabled).toBe(false);
    expect(restoredFrozen.input.codex?.model.connection).not.toHaveProperty('credentialEnv');
    const legacy = structuredClone(archive) as { tables: Record<string, unknown> };
    for (const table of [
      'illustration_settings',
      'illustration_jobs',
      'illustration_images',
      'illustration_references',
    ])
      delete legacy.tables[table];
    const older = databases.create();
    older.product.import(legacy);
    expect(illustrationSettings(older).generator).toBe('none');
    expect(illustrationsForChat(older, forked.id)).toEqual([]);
  });
});
