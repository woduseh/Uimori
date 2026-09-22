import { injectWithFixtureBot } from './fixtures/chat.js';
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
const _ref = ({ id }: { id: string }) => ({ id });

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
    expect(adc).not.toHaveProperty('credentialRef');
    const bearer = await request<Connection>(
      app,
      '/connections',
      vertexConnection({ credentialRef: 'UIMORI_PROVIDER_VERTEX_TEST' })
    );
    expect(bearer.credentialRef).toBe('UIMORI_PROVIDER_VERTEX_TEST');
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
      vertexConnection({ credentialRef: 'GOOGLE_APPLICATION_CREDENTIALS' })
    );
    expect(generic.credentialRef).toBe('GOOGLE_APPLICATION_CREDENTIALS');
    for (const credentialRef of [null, false, 0])
      await request(app, '/connections', vertexConnection({ credentialRef }), 400);
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
    vi.stubEnv('UIMORI_PROVIDER_VERTEX_TEST', '');
    const connection = await request<Connection>(
      app,
      '/connections',
      vertexConnection({ enabled: false, credentialRef: 'UIMORI_PROVIDER_VERTEX_TEST' })
    );
    const catalog = await request<Connection>(app, `/connections/${connection.id}/catalog`, {});
    expect(catalog).toMatchObject({
      id: connection.id,
      revision: 2,
      enabled: false,
      credentialRef: connection.credentialRef,
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
});
