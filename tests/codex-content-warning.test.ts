import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test, vi } from 'vitest';
import type { ProviderResult } from '../core/transport.js';
import { createApp, type App } from '../server/app.js';
import type { CodexRuntimeService } from '../server/codex-runtime.js';
import { injectWithFixtureBot, setFixtureModelRoutes } from './fixtures/chat.js';
import { installJevFixture } from './fixtures/jev.js';

const owned: { directory: string; app?: App }[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const item of owned.splice(0).reverse()) {
    await item.app?.close();
    const target = resolve(item.directory);
    const within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('uimori-codex-warning-')
    )
      throw new Error('Unsafe cleanup');
    await rm(target, { recursive: true, force: true });
  }
});

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ref = (value: { id: string }) => ({ id: value.id });

async function api(
  app: App,
  url: string,
  body?: unknown,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' = body === undefined ? 'GET' : 'POST'
): Promise<any> {
  const response = await injectWithFixtureBot(app, {
    method,
    url,
    headers: { host: '127.0.0.1', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

function runtime(): CodexRuntimeService {
  const status = async () => ({
    available: true,
    authenticated: true,
    authMode: 'chatgpt' as const,
    error: null,
    login: null,
    planType: null,
    limits: [],
  });
  return {
    status,
    login: status,
    cancelLogin: status,
    logout: status,
    catalog: async () => [],
    close: async () => {},
    generateImage: async () => {
      throw new Error('Unexpected generateImage');
    },
    executeAgent: async () => {
      throw new Error('Unexpected executeAgent');
    },
    execute: async (connection, request, options) => {
      const body = { method: 'turn/start', role: request.role, model: request.modelId };
      await options.onWire?.({
        connectionId: connection.id,
        protocol: connection.protocol,
        role: request.role,
        modelId: request.modelId,
        method: 'RPC',
        url: 'codex://local',
        headers: {},
        body,
        bodySha256: hash(body),
        stablePrefixSha256: hash(request.stable),
      });
      return {
        status: 'completed',
        text: request.role === 'main' ? 'A quiet completed scene.' : '',
        toolCalls: [],
        refusal: null,
        error: null,
        usage: {
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          raw: { modelCalls: null },
          priceRevision: null,
        },
        opaqueState: null,
      } satisfies ProviderResult;
    },
  };
}

test('Codex preflight warns through JEV for main and translation while remaining advisory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'uimori-codex-warning-'));
  const item = { directory } as (typeof owned)[number];
  owned.push(item);
  const app = await createApp({
    dbPath: join(directory, 'test.sqlite'),
    buildId: 'codex-warning-test',
    instanceId: randomUUID(),
    testMode: true,
    codexRuntime: runtime(),
  });
  item.app = app;
  await app.ready();

  const connection = await api(app, '/api/connections', {
    title: 'Codex',
    protocol: 'codex-app-server-v1',
    endpoint: 'codex://local',
    enabled: true,
  });
  const model = await api(app, '/api/model-presets', {
    title: 'Synthetic Codex',
    connectionId: connection.id,
    modelId: 'synthetic',
    maxOutputTokens: 1024,
    temperature: null,
  });
  await setFixtureModelRoutes(app, {
    main: ref(model),
    translation: ref(model),
    status: null,
  });
  const chat = await api(app, '/api/chats', { title: 'Content preflight' });

  const judgments = installJevFixture();
  const withoutKey = await api(app, `/api/chats/${chat.id}/codex-content-preflight`, {
    role: 'main',
    text: 'Continue the scene.',
  });
  expect(withoutKey).toEqual({ warning: false });
  expect(judgments).toHaveLength(0);

  app.store.credentials.set('jev', 'synthetic-jev-test-key');
  const main = await api(app, `/api/chats/${chat.id}/codex-content-preflight`, {
    role: 'main',
    text: 'Continue the scene.',
  });
  expect(main).toEqual({ warning: true });
  expect(judgments.at(-1)?.state).toEqual({ request: 'Continue the scene.' });
  expect(judgments.at(-1)?.questions.explicitSexualContent?.type).toBe('noul');

  const inputTranslation = await api(app, `/api/chats/${chat.id}/codex-content-preflight`, {
    role: 'translation',
    text: 'Synthetic source text.',
  });
  expect(inputTranslation).toEqual({ warning: true });
  expect(judgments.at(-1)?.state).toEqual({ source: 'Synthetic source text.' });

  const live = app.store.chat(chat.id);
  const run = await api(app, `/api/chats/${chat.id}/runs`, {
    request: 'Write one quiet scene.',
    expectedRevision: live.headRevision,
    expectedSettingsRevision: live.settingsRevision,
    idempotencyKey: randomUUID(),
  });
  await expect.poll(() => app.store.run(run.id).status, { timeout: 4000 }).toBe('completed');
  const source = app.store.source(app.store.chat(chat.id).headRevision!);

  const translation = await api(app, `/api/sources/${source.id}/codex-content-preflight`, {});
  expect(translation).toEqual({ warning: true });
  expect(judgments.at(-1)?.state).toEqual({ source: 'A quiet completed scene.' });

  const nextMain = await api(app, `/api/chats/${chat.id}/codex-content-preflight`, {
    role: 'main',
    text: 'Continue.',
  });
  expect(nextMain).toEqual({ warning: true });
  expect(judgments.at(-1)?.state).toEqual({
    request: 'Continue.',
    recentContext: 'A quiet completed scene.',
  });
});
