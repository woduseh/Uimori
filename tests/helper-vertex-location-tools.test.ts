import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { Store } from '../server/store.js';
import type { Connection, ModelPreset } from '../core/product.js';
import { supportedModels } from '../core/model-capabilities.js';
import { createConnectionTestRunner } from '../server/provider-connection-test.js';
import {
  compareVertexLocations,
  readVertexLocations,
  updateVertexLocation,
} from '../server/helper-vertex-location-tools.js';

const owned: { path: string; store: Store }[] = [];
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network'));
});
afterEach(() => {
  for (const { path, store } of owned.splice(0)) {
    store.close();
    const within = relative(resolve(tmpdir()), resolve(path));
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(path).startsWith('uimori-helper-vertex-location-')
    )
      throw new Error('Unsafe cleanup');
    rmSync(path, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});
const globalEndpoint =
  'https://aiplatform.googleapis.com/v1/projects/synthetic-project/locations/global/publishers/google/models';
function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-helper-vertex-location-'));
  const store = new Store(join(path, 'story.sqlite'));
  owned.push({ path, store });
  const connection = store.product.connection({
    title: 'Synthetic Vertex',
    protocol: 'vertex-gemini-v1',
    endpoint: globalEndpoint,
    enabled: true,
    apiKey: 'synthetic-vertex-token',
  }) as Connection;
  const model = store.product.model({
    title: 'Synthetic Vertex model',
    connectionId: connection.id,
    modelId: supportedModels('vertex-gemini-v1')[0].id,
    maxOutputTokens: 1024,
    temperature: null,
  }) as ModelPreset;
  const other = store.product.connection({
    title: 'Other provider',
    protocol: 'openai-chat-v1',
    endpoint: 'https://private.example/v1',
    enabled: true,
  }) as Connection;
  return { store, connection, model, other };
}

test('read lists each Vertex connection with its location and models but no endpoint or project', () => {
  const { store, connection, model } = fixture();
  const view = readVertexLocations(store, {});
  expect(view.connections).toEqual([
    {
      connectionId: connection.id,
      title: connection.title,
      revision: connection.revision,
      enabled: true,
      location: 'global',
      models: [
        {
          modelId: model.id,
          title: model.title,
          providerModelId: model.modelId,
          enabled: true,
        },
      ],
    },
  ]);
  expect(JSON.stringify(view)).not.toContain('synthetic-project');
  expect(JSON.stringify(view)).not.toContain(connection.credentialRef);
});

test('update moves only the location and keeps the credential and model catalog', () => {
  const { store, connection, other } = fixture();
  store.db
    .prepare("UPDATE provider_settings SET body=json_set(body,'$.catalog',json(?)) WHERE id=?")
    .run(JSON.stringify([{ id: 'gemini-x', name: 'gemini-x', capabilities: {} }]), connection.id);
  const moved = updateVertexLocation(store, {
    connectionId: connection.id,
    location: 'us',
    expectedRevision: connection.revision,
  });
  expect(moved).toMatchObject({ previousLocation: 'global', location: 'us' });
  const saved = store.product.get<Connection>('connection', connection.id);
  expect(saved).toMatchObject({
    endpoint:
      'https://aiplatform.us.rep.googleapis.com/v1/projects/synthetic-project/locations/us/publishers/google/models',
    credentialRef: connection.credentialRef,
    revision: connection.revision + 1,
  });
  expect(saved.catalog.map((item) => item.id)).toEqual(['gemini-x']);
  expect(
    updateVertexLocation(store, {
      connectionId: connection.id,
      location: 'us',
      expectedRevision: saved.revision,
    })
  ).toMatchObject({ revision: saved.revision, previousLocation: 'us' });
  for (const [args, message] of [
    [{ location: 'eu', expectedRevision: connection.revision }, 'Revision conflict'],
    [{ location: 'us_central1', expectedRevision: saved.revision }, 'INVALID_VERTEX_LOCATION'],
    [
      { connectionId: other.id, location: 'us', expectedRevision: other.revision },
      'VERTEX_CONNECTION_REQUIRED',
    ],
  ] as const)
    expect(() => updateVertexLocation(store, { connectionId: connection.id, ...args })).toThrow(
      message
    );
});

test('compare reports each location once and a replayed operation sends nothing new', async () => {
  const { store, model } = fixture();
  const fetch = vi.mocked(globalThis.fetch).mockImplementation(async (url) => {
    const target = String(url);
    if (target.includes('aiplatform.us.rep.googleapis.com'))
      return new Response(
        `data: ${JSON.stringify({
          candidates: [
            { index: 0, content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP' },
          ],
          usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 1, totalTokenCount: 9 },
        })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } }
      );
    if (target.includes('://aiplatform.googleapis.com'))
      return new Response('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}', { status: 429 });
    return new Response('{"error":{"code":404,"status":"NOT_FOUND"}}', { status: 404 });
  });
  const runner = createConnectionTestRunner(store, {
    signal: new AbortController().signal,
    track: () => {},
    resolveCredential: async () => 'synthetic-vertex-token',
  });
  const compare = () =>
    compareVertexLocations(
      store,
      runner,
      { modelId: model.id, locations: ['global', 'us', 'us-central1'] },
      'task-1:call-1',
      () => {},
      new AbortController().signal
    );
  const result = await compare();
  expect(result).toMatchObject({ currentLocation: 'global', fastest: 'us' });
  expect(result.results.map(({ location, outcome }) => [location, outcome])).toEqual([
    ['global', 'busy'],
    ['us', 'responded'],
    ['us-central1', 'not_offered'],
  ]);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(await compare()).toEqual(result);
  expect(fetch).toHaveBeenCalledTimes(3);
  await expect(
    compareVertexLocations(
      store,
      runner,
      { modelId: model.id, locations: ['us', 'us'] },
      'task-1:call-2',
      () => {},
      new AbortController().signal
    )
  ).rejects.toThrow('INVALID_VERTEX_LOCATIONS');
});
