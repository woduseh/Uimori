import { updateTestProfile } from './fixtures/model-workspace.js';
import { injectWithFixtureBot, createFixtureChat } from './fixtures/chat.js';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp, type App } from '../server/app.js';
import {
  VERTEX_GEMINI_MODEL_ID,
  VERTEX_GEMINI_MAX_OUTPUT_TOKENS,
  type Connection,
  type ModelPreset,
} from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';

const owned: { directory: string; app?: App }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const item of owned.splice(0).reverse()) {
    await item.app?.close();
    const target = resolve(item.directory);
    const within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('Uimori vertex settings ')
    )
      throw new Error('Refusing cleanup outside owned test directory');
    await rm(target, { recursive: true, force: true });
  }
});
async function application() {
  const directory = await mkdtemp(join(tmpdir(), 'Uimori vertex settings '));
  const item: (typeof owned)[number] = { directory };
  owned.push(item);
  item.app = await createApp({
    dbPath: join(directory, 'story.sqlite'),
    buildId: 'vertex-settings-local',
    instanceId: randomUUID(),
    testMode: true,
  });
  await item.app.ready();
  return item.app;
}
async function request<T>(
  app: App,
  path: string,
  payload: unknown,
  status = 200,
  method: 'POST' | 'PUT' = 'POST'
): Promise<T> {
  const response = await injectWithFixtureBot(app, {
    method,
    url: `/api${path}`,
    payload: JSON.stringify(payload),
    headers: { host: '127.0.0.1', 'content-type': 'application/json' },
  });
  expect(response.statusCode, response.body).toBe(status);
  return response.json() as T;
}
const endpoint =
  'https://aiplatform.googleapis.com/v1/projects/synthetic-project/locations/global/publishers/google/models';
const vertexConnection = (changes: Record<string, unknown> = {}) => ({
  title: 'Synthetic Vertex',
  protocol: 'vertex-gemini-v1',
  endpoint,
  enabled: true,
  ...changes,
});
const modelBody = (connection: Connection, changes: Record<string, unknown> = {}) => ({
  title: 'Synthetic model',
  connectionId: connection.id,
  modelId: VERTEX_GEMINI_MODEL_ID,
  maxOutputTokens: 8192,
  temperature: null,
  ...changes,
});
const ref = ({ id }: { id: string }) => ({ id });

describe('Vertex connection and model settings with file SQLite', () => {
  test('accepts ADC and named Bearer references, normalizes the global base path and rejects unsupported authority', async () => {
    const app = await application();
    const adc = await request<Connection>(
      app,
      '/connections',
      vertexConnection({ endpoint: endpoint + '/' })
    );
    expect(adc).toMatchObject({
      protocol: 'vertex-gemini-v1',
      endpoint,
      enabled: true,
      catalog: [],
    });
    expect(adc).not.toHaveProperty('credentialEnv');
    const bearer = await request<Connection>(
      app,
      '/connections',
      vertexConnection({ credentialEnv: 'NARRATIVE_PROVIDER_VERTEX_TEST' })
    );
    expect(bearer.credentialEnv).toBe('NARRATIVE_PROVIDER_VERTEX_TEST');
    for (const invalid of [
      endpoint.replace('https:', 'http:'),
      endpoint.replace('aiplatform.googleapis.com', 'example.invalid'),
      endpoint.replace('aiplatform.googleapis.com', 'aiplatform.googleapis.com:444'),
      endpoint.replace('/global/', '/us-central1/'),
      endpoint.replace('synthetic-project', 'synthetic%2Fproject'),
      endpoint + '/gemini-3.8-flash:generateContent',
      endpoint + '?key=synthetic',
      endpoint + '#fragment',
      endpoint.replace('https://', 'https://synthetic@'),
    ])
      await request(app, '/connections', vertexConnection({ endpoint: invalid }), 400);
    const generic = await request<Connection>(
      app,
      '/connections',
      vertexConnection({ credentialEnv: 'GOOGLE_APPLICATION_CREDENTIALS' })
    );
    expect(generic.credentialEnv).toBe('GOOGLE_APPLICATION_CREDENTIALS');
    for (const credentialEnv of [null, false, 0])
      await request(app, '/connections', vertexConnection({ credentialEnv }), 400);
    await request(
      app,
      '/connections',
      vertexConnection({ apiKey: 'SYNTHETIC_NOT_A_CREDENTIAL' }),
      400
    );
    expect(app.store.product.all('connection')).toHaveLength(3);
  });

  test('stores the selected model defaults and bounds while keeping fixture rows unchanged', async () => {
    const app = await application();
    const connection = await request<Connection>(app, '/connections', vertexConnection());
    const defaults = await request<ModelPreset>(app, '/model-presets', modelBody(connection));
    expect(defaults).toMatchObject({
      modelId: VERTEX_GEMINI_MODEL_ID,
      temperature: null,
      timeoutMs: 300000,
    });
    expect(defaults).not.toHaveProperty('thinkingLevel');
    const maximum = await request<ModelPreset>(
      app,
      '/model-presets',
      modelBody(connection, {
        maxOutputTokens: VERTEX_GEMINI_MAX_OUTPUT_TOKENS,
        thinkingLevel: 'HIGH',
        timeoutMs: 600000,
      })
    );
    expect(maximum).toMatchObject({
      maxOutputTokens: 65536,
      thinkingLevel: 'HIGH',
      timeoutMs: 600000,
    });
    const minimum = await request<ModelPreset>(
      app,
      '/model-presets',
      modelBody(connection, { maxOutputTokens: 1, thinkingLevel: 'LOW', timeoutMs: 1 })
    );
    expect(minimum).toMatchObject({ maxOutputTokens: 1, thinkingLevel: 'LOW', timeoutMs: 1 });
    for (const invalid of [
      { maxOutputTokens: 500001 },
      { maxOutputTokens: 0 },
      { thinkingLevel: 'medium' },
      { thinkingLevel: null },
      { timeoutMs: 0 },
      { timeoutMs: 1800001 },
      { timeoutMs: 1.5 },
      { timeoutMs: null },
      { topP: 1.5 },
      { reasoningEffort: 'high' },
    ])
      await request(app, '/model-presets', modelBody(connection, invalid), 400);
    const fixture = await request<Connection>(app, '/connections', {
      title: 'Synthetic fixture',
      protocol: 'fixture-sse-v1',
      endpoint: 'http://127.0.0.1:9/turn',
      enabled: false,
    });
    const legacy = await request<ModelPreset>(
      app,
      '/model-presets',
      modelBody(fixture, {
        modelId: 'manual-fixture-id',
        maxOutputTokens: 200000,
        temperature: 0.6,
      })
    );
    expect(legacy).not.toHaveProperty('thinkingLevel');
    expect(legacy).not.toHaveProperty('timeoutMs');
    expect(legacy).toMatchObject({
      modelId: 'manual-fixture-id',
      maxOutputTokens: 200000,
      temperature: 0.6,
    });
    expect(app.store.product.all('model')).toHaveLength(4);
  });

  test('returns only the local Vertex support manifest without fetching or requiring credentials', async () => {
    const app = await application();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('No network expected for local support manifest');
    });
    vi.stubEnv('NARRATIVE_PROVIDER_VERTEX_TEST', '');
    const connection = await request<Connection>(
      app,
      '/connections',
      vertexConnection({ enabled: false, credentialEnv: 'NARRATIVE_PROVIDER_VERTEX_TEST' })
    );
    const catalog = await request<Connection>(app, `/connections/${connection.id}/catalog`, {});
    expect(catalog).toMatchObject({
      id: connection.id,
      revision: 2,
      enabled: false,
      credentialEnv: connection.credentialEnv,
      catalogError: null,
    });
    expect(catalog.catalog).toEqual([
      {
        id: 'gemini-3.5-flash-lite',
        name: 'Gemini 3.5 Flash-Lite',
        capabilities: { tools: true, structuredOutput: null },
        priceRevision: null,
      },
      {
        id: VERTEX_GEMINI_MODEL_ID,
        name: 'Gemini 3.8 Flash',
        capabilities: { tools: true, structuredOutput: null },
        priceRevision: null,
      },
      {
        id: 'gemini-3.1-pro-preview',
        name: 'Gemini 3.1 Pro (Preview)',
        capabilities: { tools: true, structuredOutput: null },
        priceRevision: null,
      },
    ]);
    const fixture = await request<Connection>(app, '/connections', {
      title: 'Disabled fixture',
      protocol: 'fixture-sse-v1',
      endpoint: 'http://127.0.0.1:9/turn',
      enabled: false,
    });
    const denied = await request<Connection>(app, `/connections/${fixture.id}/catalog`, {});
    expect(denied).toMatchObject({
      catalog: [],
      catalogError: 'CATALOG_UNAVAILABLE',
      enabled: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('lists Gemini models through a Developer API key when a catalog credential is set, and keeps the list when the key is missing', async () => {
    const app = await application();
    vi.stubEnv('NARRATIVE_PROVIDER_GEMINI_LIST_TEST', 'SYNTHETIC_LIST_KEY');
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init });
      const second = new URL(String(url)).searchParams.get('pageToken') === 'next';
      const body = second
        ? {
            models: [
              {
                name: 'models/gemini-3.9-pro',
                displayName: 'Gemini 3.9 Pro',
                inputTokenLimit: 1048576,
                outputTokenLimit: 65536,
                supportedGenerationMethods: ['generateContent'],
              },
            ],
          }
        : {
            models: [
              {
                name: 'models/gemini-3.8-flash',
                displayName: 'Gemini 3.8 Flash',
                inputTokenLimit: 1048576,
                outputTokenLimit: 65536,
                supportedGenerationMethods: ['generateContent', 'countTokens'],
              },
              { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
            ],
            nextPageToken: 'next',
          };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const connection = await request<Connection>(
      app,
      '/connections',
      vertexConnection({
        enabled: false,
        credentialEnv: 'NARRATIVE_PROVIDER_VERTEX_TEST',
        catalogCredentialEnv: 'NARRATIVE_PROVIDER_GEMINI_LIST_TEST',
      })
    );
    expect(connection.catalogCredentialEnv).toBe('NARRATIVE_PROVIDER_GEMINI_LIST_TEST');
    const listed = await request<Connection>(app, `/connections/${connection.id}/catalog`, {});
    expect(listed.catalogError).toBeNull();
    expect(listed.catalog).toEqual([
      {
        id: 'gemini-3.8-flash',
        name: 'Gemini 3.8 Flash',
        capabilities: { tools: null, structuredOutput: null },
        priceRevision: null,
        limits: { maxOutputTokens: 65536, inputTokenLimit: 1048576 },
      },
      {
        id: 'gemini-3.9-pro',
        name: 'Gemini 3.9 Pro',
        capabilities: { tools: null, structuredOutput: null },
        priceRevision: null,
        limits: { maxOutputTokens: 65536, inputTokenLimit: 1048576 },
      },
    ]);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const address = new URL(call.url);
      expect(address.origin + address.pathname).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models'
      );
      expect(new Headers(call.init?.headers).get('x-goog-api-key')).toBe('SYNTHETIC_LIST_KEY');
      expect(call.init).toMatchObject({ method: 'GET', redirect: 'error' });
    }
    expect(new URL(calls[1].url).searchParams.get('pageToken')).toBe('next');
    expect(JSON.stringify(listed)).not.toContain('SYNTHETIC_LIST_KEY');
    vi.stubEnv('NARRATIVE_PROVIDER_GEMINI_LIST_TEST', '');
    const failed = await request<Connection>(app, `/connections/${connection.id}/catalog`, {});
    expect(failed.catalogError).toBe('CATALOG_UNAVAILABLE');
    expect(failed.catalog).toEqual(listed.catalog);
    expect(calls).toHaveLength(2);
    // The list key is Gemini-only and never a service-account file reference.
    await request(
      app,
      '/connections',
      {
        title: 'Not Gemini',
        protocol: 'openai-responses-v1',
        endpoint: 'https://api.openai.com/v1',
        enabled: false,
        catalogCredentialEnv: 'NARRATIVE_PROVIDER_GEMINI_LIST_TEST',
      },
      400
    );
    await request(
      app,
      '/connections',
      vertexConnection({
        enabled: false,
        catalogCredentialEnv: 'NARRATIVE_PROVIDER_VERTEX_FILE_' + 'A'.repeat(32),
      }),
      400
    );
    const archive = app.store.product.export();
    const target = await application();
    expect(target.store.product.import(archive)).toMatchObject({ restored: true });
    expect(
      target.store.product.get<Connection>('connection', connection.id).catalogCredentialEnv
    ).toBe('NARRATIVE_PROVIDER_GEMINI_LIST_TEST');
  });

  test('exports and restores optional settings and immutable snapshots, with every connection disabled and credential reference removed', async () => {
    const source = await application();
    const product = source.store.product;
    const connection = await request<Connection>(
      source,
      '/connections',
      vertexConnection({ credentialEnv: 'NARRATIVE_PROVIDER_VERTEX_TEST' })
    );
    const model = await request<ModelPreset>(
      source,
      '/model-presets',
      modelBody(connection, { thinkingLevel: 'HIGH', timeoutMs: 123456 })
    );
    const fixture = await request<Connection>(source, '/connections', {
      title: 'Legacy fixture',
      protocol: 'fixture-sse-v1',
      endpoint: 'http://127.0.0.1:9/turn',
      credentialEnv: 'NARRATIVE_PROVIDER_FIXTURE_TEST',
      enabled: true,
    });
    const oldModel = await request<ModelPreset>(
      source,
      '/model-presets',
      modelBody(fixture, { modelId: 'fixture-only' })
    );
    const chat = createFixtureChat(source.store, 'Synthetic Vertex snapshot');
    const initial = product.profile(chat.id);
    const profile = updateTestProfile(product, chat.id, {
      expectedRevision: initial.revision,
      attachments: [],

      routes: { main: ref(model), translation: ref(model), status: ref(oldModel), image: null },
      image: false,
    });
    const captured = product.snapshot(chat.id)!;
    const prompt = 'Synthetic snapshot, never sent to a provider';
    const run = source.store.createRun(
      chat.id,
      {
        request: prompt,
        expectedRevision: null,
        expectedSettingsRevision: chat.settingsRevision,
        expectedProfileRevision: profile.revision,
        idempotencyKey: randomUUID(),
      },
      (current) =>
        ({
          chatId: chat.id,
          parentRevision: null,
          settingsRevision: current.settingsRevision,
          settings: current.settings,
          request: prompt,
          history: [],
          resources: product.resources(chat.id, captured),
          profile: captured,
        }) satisfies RunSnapshot
    ).run;
    await request<ModelPreset>(
      source,
      `/model-presets/${model.id}`,
      {
        ...modelBody(connection, { thinkingLevel: 'LOW', timeoutMs: 1 }),
        expectedRevision: model.revision,
      },
      200,
      'PUT'
    );
    expect(source.store.run(run.id).snapshot.profile!.models.main).toMatchObject({
      revision: 1,
      thinkingLevel: 'HIGH',
      timeoutMs: 123456,
    });
    const archive = product.export();
    const originalArchive = JSON.stringify(archive);
    const target = await application();
    expect(target.store.product.import(archive)).toMatchObject({ restored: true, chats: 1 });
    expect(JSON.stringify(archive)).toBe(originalArchive);
    const restored = target.store.product;
    expect(() => restored.get<ModelPreset>('model', model.id, model.revision)).toThrow(
      'Setting not found'
    );
    expect(restored.get<ModelPreset>('model', model.id)).toMatchObject({
      thinkingLevel: 'LOW',
      timeoutMs: 1,
    });
    expect(restored.get<ModelPreset>('model', oldModel.id)).toEqual(oldModel);
    expect(
      target.store.db
        .prepare("SELECT COUNT(*) AS count FROM provider_settings WHERE kind='model' AND id=?")
        .get(model.id)?.count
    ).toBe(1);
    for (const id of [connection.id, fixture.id]) {
      const value = restored.get<Connection>('connection', id);
      expect(value.enabled).toBe(false);
      expect(value).not.toHaveProperty('credentialEnv');
    }
    const frozen = target.store.run(run.id).snapshot.profile!;
    expect(frozen.models.main).toMatchObject({
      thinkingLevel: 'HIGH',
      timeoutMs: 123456,
      connection: { protocol: 'vertex-gemini-v1', enabled: false },
    });
    expect(frozen.models.main!.connection).not.toHaveProperty('credentialEnv');
    expect(frozen.models.status).not.toHaveProperty('thinkingLevel');
    expect(target.store.run(run.id).status).toBe('interrupted');
    expect(target.store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  test('rejects forged Vertex archive model options against its referenced connection and rolls back every row', async () => {
    const source = await application();
    const connection = await request<Connection>(source, '/connections', vertexConnection());
    await request<ModelPreset>(source, '/model-presets', modelBody(connection));
    const archive = source.store.product.export();
    for (const changes of [
      { temperature: 2.5 },
      { maxOutputTokens: 500001 },
      { thinkingLevel: 'medium' },
      { structuredOutput: true },
      { timeoutMs: 1800001 },
    ]) {
      const forged = structuredClone(archive);
      const row = forged.tables.provider_settings.find((row) => row.kind === 'model')!;
      row.body = JSON.stringify({ ...JSON.parse(row.body), ...changes });
      const unchanged = JSON.stringify(forged);
      const target = await application();
      expect(() => target.store.product.import(forged)).toThrow();
      expect(JSON.stringify(forged)).toBe(unchanged);
      expect(target.store.product.library()).toMatchObject({
        connections: [],
        models: [],
        contents: [],
      });
      expect(target.store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    }
  });
});
