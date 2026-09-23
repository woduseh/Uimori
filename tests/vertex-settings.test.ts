import {
  VERTEX_GEMINI_MODEL_ID,
  VERTEX_GEMINI_MAX_OUTPUT_TOKENS,
} from './fixtures/vertex-model.js';
import { injectWithFixtureBot } from './fixtures/chat.js';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import { createApp, type App } from '../server/app.js';
import { type Connection, type ModelPreset } from '../core/product.js';

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
const serviceAccount = {
  type: 'service_account',
  project_id: 'synthetic-project',
  client_email: 'synthetic@synthetic-project.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nSYNTHETIC\n-----END PRIVATE KEY-----',
  token_uri: 'https://oauth2.googleapis.com/token',
};
async function vertexCredential(app: App) {
  return (
    await request<{ credentialRef: string }>(app, '/provider-management/vertex-credentials', {
      serviceAccount,
    })
  ).credentialRef;
}
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
  test('accepts ADC and app-entered Bearer keys, normalizes the global base path and rejects unsupported authority', async () => {
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
      vertexConnection({ apiKey: 'synthetic-vertex-token' })
    );
    expect(app.store.credentials.get(bearer.credentialRef!)).toBe('synthetic-vertex-token');
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
    for (const apiKey of [false, 0, 'line\nbreak'])
      await request(app, '/connections', vertexConnection({ apiKey }), 400);
    expect(app.store.product.all('connection')).toHaveLength(2);
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

  test('refreshes Gemini models with the same uploaded Vertex credential used for generation', async () => {
    const app = await application();
    const token = vi
      .spyOn(GoogleAuth.prototype, 'getAccessToken')
      .mockResolvedValue('synthetic-oauth-token');
    const seen: { url: string; authorization: string | null }[] = [];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      seen.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return new Response(
        JSON.stringify({
          publisherModels: [
            { name: 'publishers/google/models/gemini-3.8-flash' },
            { name: 'publishers/google/models/gemini-4-pro-preview' },
            { name: 'publishers/google/models/embedding-001' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    const credentialRef = await vertexCredential(app);
    const connection = await request<Connection>(
      app,
      '/connections',
      vertexConnection({ credentialRef })
    );
    const catalog = await request<Connection>(app, `/connections/${connection.id}/catalog`, {});

    expect(catalog.catalog.map((item) => item.id)).toEqual([
      'gemini-3.8-flash',
      'gemini-4-pro-preview',
    ]);
    expect(catalog.catalogError).toBeNull();
    expect(seen).toEqual([
      expect.objectContaining({
        authorization: 'Bearer synthetic-oauth-token',
      }),
    ]);
    expect(seen[0].url).toContain('/v1beta1/publishers/google/models');
    expect(JSON.stringify(catalog)).not.toContain('synthetic-oauth-token');
    expect(token).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('keeps the last Vertex model catalog when a later refresh fails', async () => {
    const app = await application();
    vi.spyOn(GoogleAuth.prototype, 'getAccessToken').mockResolvedValue('synthetic-oauth-token');
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            publisherModels: [{ name: 'publishers/google/models/gemini-3.8-flash' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(new Response('temporary failure', { status: 503 }));
    const connection = await request<Connection>(
      app,
      '/connections',
      vertexConnection({ credentialRef: await vertexCredential(app) })
    );
    const listed = await request<Connection>(app, `/connections/${connection.id}/catalog`, {});
    const failed = await request<Connection>(app, `/connections/${connection.id}/catalog`, {});

    expect(listed.catalog.map((item) => item.id)).toEqual(['gemini-3.8-flash']);
    expect(failed.catalog).toEqual(listed.catalog);
    expect(failed.catalogUpdatedAt).toBe(listed.catalogUpdatedAt);
    expect(failed.catalogError).toBe('CATALOG_UNAVAILABLE');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
