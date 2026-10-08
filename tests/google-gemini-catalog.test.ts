import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp, type App } from '../server/app.js';
import type { Connection } from '../core/product.js';
import { injectWithFixtureBot } from './fixtures/chat.js';

const owned: { directory: string; app?: App }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const item of owned.splice(0).reverse()) {
    await item.app?.close();
    const target = resolve(item.directory);
    const within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('Uimori Gemini catalog ')
    )
      throw new Error('Refusing cleanup outside owned test directory');
    await rm(target, { recursive: true, force: true });
  }
});
async function application() {
  const directory = await mkdtemp(join(tmpdir(), 'Uimori Gemini catalog '));
  const item: (typeof owned)[number] = { directory };
  owned.push(item);
  item.app = await createApp({
    dbPath: join(directory, 'story.sqlite'),
    buildId: 'gemini-catalog-local',
    instanceId: randomUUID(),
    testMode: true,
  });
  await item.app.ready();
  return item.app;
}
async function request(app: App, path: string, payload: unknown, status = 200) {
  const response = await injectWithFixtureBot(app, {
    method: 'POST',
    url: `/api${path}`,
    payload: JSON.stringify(payload),
    headers: { host: '127.0.0.1', 'content-type': 'application/json' },
  });
  expect(response.statusCode, response.body).toBe(status);
  return response.json() as Connection;
}
const connectionBody = {
  title: 'Synthetic AI Studio',
  protocol: 'google-gemini-v1',
  endpoint: 'https://generativelanguage.googleapis.com/v1beta',
  enabled: true,
  apiKey: 'synthetic-gemini-secret',
};
const model = {
  name: 'models/gemini-2.5-flash',
  displayName: 'Gemini 2.5 Flash',
  supportedGenerationMethods: ['generateContent'],
  inputTokenLimit: 1048576,
  outputTokenLimit: 65536,
};
const jsonResponse = (payload: unknown) =>
  new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });

test('AI Studio refresh uses header API key, follows page tokens, and persists model limits without automatic calls on save', async () => {
  const app = await application();
  const seen: { url: string; headers: Headers }[] = [];
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    seen.push({ url: String(input), headers: new Headers(init?.headers) });
    return seen.length === 1
      ? jsonResponse({
          models: [
            model,
            { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
          ],
          nextPageToken: 'second-page',
        })
      : jsonResponse({
          models: [
            model,
            { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-live', supportedGenerationMethods: ['bidiGenerateContent'] },
          ],
        });
  });
  const connection = await request(app, '/connections', connectionBody);
  expect(fetch).not.toHaveBeenCalled();
  const listed = await request(app, `/connections/${connection.id}/catalog`, {});
  expect(listed.catalog.map((entry) => entry.id)).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro']);
  expect(listed.catalog[0]).toMatchObject({
    name: 'Gemini 2.5 Flash',
    limits: { inputTokenLimit: 1048576, maxOutputTokens: 65536 },
    capabilities: { tools: null, structuredOutput: null },
  });
  expect(listed.catalogError).toBeNull();
  expect(seen).toHaveLength(2);
  for (const item of seen) {
    const url = new URL(item.url);
    expect(url.origin + url.pathname).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models'
    );
    expect(url.searchParams.get('pageSize')).toBe('1000');
    expect(url.searchParams.has('key')).toBe(false);
    expect(item.headers.get('x-goog-api-key')).toBe(connectionBody.apiKey);
    expect(item.headers.has('authorization')).toBe(false);
  }
  expect(new URL(seen[1].url).searchParams.get('pageToken')).toBe('second-page');
  expect(JSON.stringify(listed)).not.toContain(connectionBody.apiKey);
});

test.each([
  'invalid payload',
  'incomplete pagination',
  'oversized response',
  'too many models',
  'failed response',
])('AI Studio keeps its last catalog on %s', async (failure) => {
  const app = await application();
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(jsonResponse({ models: [model] }));
  const connection = await request(app, '/connections', connectionBody);
  const listed = await request(app, `/connections/${connection.id}/catalog`, {});
  fetch.mockImplementation(async () => {
    if (failure === 'invalid payload') return jsonResponse({ models: {} });
    if (failure === 'incomplete pagination')
      return jsonResponse({ models: [model], nextPageToken: 'again' });
    if (failure === 'oversized response')
      return jsonResponse({ models: [], padding: 'x'.repeat(1_000_001) });
    if (failure === 'too many models')
      return jsonResponse({
        models: Array.from({ length: 5001 }, () => ({ name: 'models/embedding-001' })),
      });
    return new Response(connectionBody.apiKey, { status: 403 });
  });
  const failed = await request(app, `/connections/${connection.id}/catalog`, {});
  expect(failed.catalog).toEqual(listed.catalog);
  expect(failed.catalogUpdatedAt).toBe(listed.catalogUpdatedAt);
  expect(failed.catalogError).toBe('CATALOG_UNAVAILABLE');
  expect(JSON.stringify(failed)).not.toContain(connectionBody.apiKey);
  if (failure === 'incomplete pagination') expect(fetch).toHaveBeenCalledTimes(6);
});

test('revoking AI Studio while reading prevents further pages and both success and failure saves', async () => {
  const app = await application();
  const fetch = vi.spyOn(globalThis, 'fetch');
  for (const payload of [
    { models: [model] },
    { models: {} },
    { models: [model], nextPageToken: 'second-page' },
  ]) {
    fetch.mockResolvedValue(jsonResponse({ models: [model] }));
    const connection = await request(app, '/connections', connectionBody);
    const listed = await request(app, `/connections/${connection.id}/catalog`, {});
    let reading!: () => void;
    const begun = new Promise<void>((resolve) => {
      reading = resolve;
    });
    let finish!: () => void;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reading();
          return new Promise<void>((resolve) => {
            finish = () => {
              controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
              controller.close();
              resolve();
            };
          });
        },
      },
      { highWaterMark: 0 }
    );
    fetch.mockClear();
    fetch.mockResolvedValue(new Response(stream));
    const refresh = request(app, `/connections/${connection.id}/catalog`, {}, 403);
    await begun;
    const disabled = app.store.product.connection(
      {
        title: listed.title,
        protocol: listed.protocol,
        endpoint: listed.endpoint,
        credentialRef: listed.credentialRef,
        enabled: false,
        expectedRevision: listed.revision,
      },
      listed.id
    );
    finish();
    await refresh;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(app.store.product.get('connection', listed.id)).toEqual(disabled);
    expect(disabled.catalog).toEqual(listed.catalog);
    expect(disabled.catalogUpdatedAt).toBe(listed.catalogUpdatedAt);
    expect(disabled.catalogError).toBeNull();
  }
});
