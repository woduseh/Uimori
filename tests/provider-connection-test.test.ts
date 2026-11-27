import { injectWithFixtureBot } from './fixtures/chat.js';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { createApp, type App } from '../server/app.js';
import {
  providerConnectionTestRoutes,
  ProviderConnectionTestStore,
  CONNECTION_TEST_TIMEOUT_MS,
} from '../server/provider-connection-test.js';
import type { Connection, ModelPreset } from '../core/product.js';
import type { ProviderConnectionTest } from '../core/provider-connection-test.js';
import { supportedModels } from '../core/model-capabilities.js';
import { CodexProcess } from '../server/codex-process.js';

const owned: { directory: string; app?: App }[] = [];
const endpoint = 'http://127.0.0.1:9/turn';
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('Unexpected network in synthetic connection test')
  );
});
afterEach(async () => {
  for (const item of owned.splice(0).reverse()) {
    await item.app?.close();
    const target = resolve(item.directory),
      within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('uimori-connection-test-')
    )
      throw new Error('Unsafe test cleanup');
    await rm(target, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function setup(options: { accessToken?: string; credentialRef?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'uimori-connection-test-'));
  const item: (typeof owned)[number] = { directory };
  owned.push(item);
  const app = (item.app = await createApp({
    dbPath: join(directory, 'story.sqlite'),
    buildId: 'synthetic-test',

    accessToken: options.accessToken,
  }));
  await app.ready();
  const connection = app.store.product.connection({
    title: 'Synthetic fixture',
    protocol: 'fixture-sse-v1',
    endpoint,
    enabled: true,
    ...(options.credentialRef ? { apiKey: 'synthetic-connection-test-key' } : {}),
  }) as Connection;
  const model = app.store.product.model({
    title: 'Synthetic model',
    connectionId: connection.id,
    modelId: 'synthetic-fixture',
    maxOutputTokens: 10000,
    temperature: 1,
    thinkingLevel: 'HIGH',
  }) as ModelPreset;
  return { app, item, connection, model };
}
async function post(
  app: App,
  model: ModelPreset,
  key = randomUUID(),
  status = 202,
  extra: Record<string, unknown> = {},
  cookie?: string
) {
  const response = await injectWithFixtureBot(app, {
    method: 'POST',
    url: `/api/provider-management/models/${model.id}/test`,
    headers: { host: '127.0.0.1', ...(cookie ? { cookie } : {}) },
    payload: { expectedRevision: model.revision, idempotencyKey: key, ...extra },
  });
  expect(response.statusCode, response.body).toBe(status);
  expect(response.headers['cache-control']).toBe('no-store');
  return response.json() as ProviderConnectionTest;
}
async function terminal(app: App, id: string, cookie?: string) {
  let view: ProviderConnectionTest | undefined;
  await vi.waitFor(async () => {
    const response = await injectWithFixtureBot(app, {
      method: 'GET',
      url: `/api/provider-management/tests/${id}`,
      headers: { host: '127.0.0.1', ...(cookie ? { cookie } : {}) },
    });
    expect(response.statusCode).toBe(200);
    view = response.json() as ProviderConnectionTest;
    expect(view.status).not.toBe('running');
  });
  return view!;
}
const sse = (...events: unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
const modelUpdate = (model: ModelPreset, overrides: Record<string, unknown> = {}) => ({
  title: model.title,
  connectionId: model.connectionId,
  modelId: model.modelId,
  maxOutputTokens: model.maxOutputTokens,
  temperature: model.temperature,
  expectedRevision: model.revision,
  ...overrides,
});

describe('one-call provider connection diagnostics', () => {
  test('rejects stale or disabled models, disabled connections and user-supplied prompt fields', async () => {
    const { app, model, connection } = await setup({});
    await post(app, { ...model, revision: 2 }, randomUUID(), 409);
    await post(app, model, randomUUID(), 400, { prompt: 'Unrequested extra content' });
    const disabled = app.store.product.model(
      modelUpdate(model, { enabled: false }),
      model.id
    ) as ModelPreset;
    await post(app, disabled, randomUUID(), 403);
    const enabled = app.store.product.model(
      modelUpdate(disabled, { enabled: true }),
      model.id
    ) as ModelPreset;
    app.store.product.connection(
      {
        title: connection.title,
        protocol: connection.protocol,
        endpoint,
        enabled: false,
        expectedRevision: connection.revision,
      },
      connection.id
    );
    await post(app, enabled, randomUUID(), 403);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('rechecks the saved model after asynchronous credential resolution and never sends a changed model', async () => {
    let release!: (value: string) => void;
    const { app, model } = await setup({ credentialRef: 'SYNTHETIC_CONNECTION_TEST_KEY' });
    const probe = Fastify() as unknown as App;
    providerConnectionTestRoutes(probe, app.store, {
      signal: new AbortController().signal,
      authenticated: () => true,
      track: () => {},
      resolveCredential: () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    });
    try {
      const started = await post(probe, model);
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      app.store.product.model(modelUpdate(model, { title: 'Edited while authorizing' }), model.id);
      release('SYNTHETIC_NEVER_PERSISTED_SECRET');
      expect(await terminal(probe, started.id)).toMatchObject({
        status: 'error',
        error: 'CONNECTION_TEST_MODEL_CHANGED',
        text: '',
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(
        app.store.db.prepare('SELECT sent_at FROM provider_connection_tests').get()
      ).toMatchObject({ sent_at: null });
    } finally {
      await probe.close();
    }
  });

  test('never sends a paid connection test for a model deleted while it was authorizing', async () => {
    let release!: (value: string) => void;
    const { app, model } = await setup({ credentialRef: 'SYNTHETIC_CONNECTION_TEST_KEY' });
    const probe = Fastify() as unknown as App;
    providerConnectionTestRoutes(probe, app.store, {
      signal: new AbortController().signal,
      authenticated: () => true,
      track: () => {},
      resolveCredential: () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    });
    try {
      const started = await post(probe, model);
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      app.store.db.prepare("INSERT INTO library_hidden(kind,id) VALUES('model',?)").run(model.id);
      release('SYNTHETIC_NEVER_PERSISTED_SECRET');
      expect(await terminal(probe, started.id)).toMatchObject({
        status: 'error',
        error: 'CONNECTION_TEST_MODEL_CHANGED',
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await probe.close();
    }
  });

  test.each([
    [
      'refused',
      () =>
        sse({ type: 'refusal', message: 'Synthetic refusal' }, { type: 'done', reason: 'refusal' }),
      'Synthetic refusal',
      null,
    ],
    [
      'partial',
      () => sse({ type: 'text_delta', delta: 'Incomplete' }),
      'Incomplete',
      'UNEXPECTED_EOF',
    ],
    ['error', () => new Response('SENSITIVE_RAW_HTTP_ERROR', { status: 429 }), '', 'HTTP_429'],
    [
      'error',
      () =>
        sse(
          { type: 'tool_delta', index: 0, id: 'tool', name: 'forbidden', argumentsDelta: '{}' },
          { type: 'done', reason: 'tool_calls' }
        ),
      '',
      'CONNECTION_TEST_UNEXPECTED_TOOL',
    ],
  ] as const)(
    'retains safe %s results and never retries',
    async (status, response, text, error) => {
      const { app, model } = await setup();
      vi.mocked(fetch).mockResolvedValueOnce(response());
      const started = await post(app, model);
      expect(await terminal(app, started.id)).toMatchObject({
        status,
        text,
        error,
        usage: { costUsd: null },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(
        JSON.stringify(app.store.db.prepare('SELECT * FROM provider_connection_tests').all())
      ).not.toContain('SENSITIVE_RAW_HTTP_ERROR');
    }
  );

  test('uses a fixed 25 second deadline and returns TIMEOUT without retry', async () => {
    const deadline = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const { app, model } = await setup();
    vi.mocked(fetch).mockImplementation(
      async (_url, options) =>
        new Promise<Response>((_resolve, reject) =>
          options?.signal?.addEventListener(
            'abort',
            () => reject(new Error('PRIVATE_TIMEOUT_MESSAGE')),
            { once: true }
          )
        )
    );
    const started = await post(app, model);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(timeoutSpy).toHaveBeenCalledWith(CONNECTION_TEST_TIMEOUT_MS);
    deadline.abort();
    expect(await terminal(app, started.id)).toMatchObject({
      status: 'error',
      error: 'TIMEOUT',
      text: '',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('startup interrupts previously admitted work and repeated key returns it without replay', async () => {
    const { app, item, model } = await setup();
    const key = randomUUID();
    const admitted = new ProviderConnectionTestStore(app.store).create({
      id: model.id,
      expectedRevision: model.revision,
      idempotencyKey: key,
    });
    await app.close();
    item.app = undefined;
    const reopened = (item.app = await createApp({
      dbPath: join(item.directory, 'story.sqlite'),
      buildId: 'recovery-test',
    }));
    await reopened.ready();
    expect(await post(reopened, model, key)).toMatchObject({
      id: admitted.view.id,
      status: 'interrupted',
      error: 'SERVER_RESTARTED',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('server shutdown aborts an in-flight request and retains interrupted state on restart', async () => {
    const { app, item, model } = await setup();
    vi.mocked(fetch).mockImplementation(
      async (_url, options) =>
        new Promise<Response>((_resolve, reject) =>
          options?.signal?.addEventListener(
            'abort',
            () => reject(new Error('PRIVATE_STOP_MESSAGE')),
            { once: true }
          )
        )
    );
    const started = await post(app, model);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await app.close();
    item.app = undefined;
    const reopened = (item.app = await createApp({
      dbPath: join(item.directory, 'story.sqlite'),
      buildId: 'stop-test',
    }));
    await reopened.ready();
    expect(await terminal(reopened, started.id)).toMatchObject({
      status: 'interrupted',
      error: 'SERVER_STOPPING',
      text: '',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('both diagnostic endpoints require the existing access session', async () => {
    const { app, model } = await setup({ accessToken: 'synthetic-test-access-token-value-123456' });
    await post(app, model, randomUUID(), 401);
    expect(
      (
        await injectWithFixtureBot(app, {
          method: 'GET',
          url: '/api/provider-management/tests/unknown',
          headers: { host: '127.0.0.1' },
        })
      ).statusCode
    ).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each(['unchanged', 'model-edited', 'session-revoked'])(
    'checks Codex authority after thread setup: %s',
    async (change) => {
      const directory = await mkdtemp(join(tmpdir(), 'uimori-connection-test-'));
      const item: (typeof owned)[number] = { directory };
      owned.push(item);
      const log = join(directory, 'codex-requests.jsonl');
      const records = (): { method: string }[] =>
        existsSync(log)
          ? readFileSync(log, 'utf8')
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line))
          : [];
      let release!: () => void,
        waiting = false;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = CodexProcess.prototype.request;
      vi.spyOn(CodexProcess.prototype, 'request').mockImplementation(async function <T>(
        this: CodexProcess,
        method: string,
        params: unknown,
        options: { signal?: AbortSignal; timeoutMs?: number } = {}
      ): Promise<T> {
        const response = await original.call(this, method, params, options);
        if (method === 'thread/start') {
          waiting = true;
          await gate;
        }
        return response as T;
      });
      const sent = vi.spyOn(ProviderConnectionTestStore.prototype, 'sent');
      const token = 'synthetic-connection-test-session';
      const app = (item.app = await createApp({
        dbPath: join(directory, 'story.sqlite'),
        buildId: 'codex-connection-race',
        accessToken: token,
        codex: {
          enabled: true,
          launch: {
            command: process.execPath,
            args: [resolve('tests/fixtures/codex-app-server.mjs')],
            env: {
              UIMORI_CODEX_FIXTURE_LOG: log,
              UIMORI_CODEX_FIXTURE_OUTPUT: JSON.stringify({
                kind: 'final',
                text: 'OK',
                toolCalls: [],
              }),
            },
          },
        },
      }));
      await app.ready();
      const login = async () => {
        const response = await injectWithFixtureBot(app, {
          method: 'POST',
          url: '/api/session',
          headers: { host: '127.0.0.1' },
          payload: { token },
        });
        expect(response.statusCode, response.body).toBe(200);
        return String(response.headers['set-cookie']).split(';')[0];
      };
      let cookie = await login();
      const connection = app.store.product.connection({
        title: 'Synthetic Codex',
        protocol: 'codex-app-server-v1',
        endpoint: 'codex://local',
        enabled: true,
      }) as Connection;
      const model = app.store.product.model({
        title: 'Synthetic Codex model',
        connectionId: connection.id,
        modelId: 'gpt-5.4',
        maxOutputTokens: 8192,
        temperature: null,
      }) as ModelPreset;
      try {
        const key = randomUUID(),
          started = await post(app, model, key, 202, {}, cookie);
        await vi.waitFor(() => expect(waiting).toBe(true), { timeout: 5000 });
        expect(records().filter((row) => row.method === 'thread/start')).toHaveLength(1);
        expect(records().filter((row) => row.method === 'turn/start')).toHaveLength(0);
        expect(sent).toHaveBeenCalledTimes(1);
        const admitted = app.store.db
          .prepare('SELECT sent_at FROM provider_connection_tests WHERE id=?')
          .get(started.id);
        expect(admitted).toMatchObject({ sent_at: expect.any(String) });
        if (change === 'model-edited')
          app.store.product.model(
            modelUpdate(model, { title: 'Changed during thread setup' }),
            model.id
          );
        if (change === 'session-revoked') {
          const logout = await injectWithFixtureBot(app, {
            method: 'DELETE',
            url: '/api/session',
            headers: { host: '127.0.0.1', cookie },
          });
          expect(logout.statusCode).toBe(200);
          cookie = await login();
        }
        release();
        const done = await terminal(app, started.id, cookie);
        expect(done).toMatchObject(
          change === 'unchanged'
            ? { status: 'completed', text: 'OK', error: null }
            : {
                status: 'error',
                text: '',
                error:
                  change === 'model-edited'
                    ? 'CONNECTION_TEST_MODEL_CHANGED'
                    : 'SESSION_NOT_AUTHORIZED',
              }
        );
        expect(records().filter((row) => row.method === 'turn/start')).toHaveLength(
          change === 'unchanged' ? 1 : 0
        );
        expect(sent).toHaveBeenCalledTimes(1);
        expect(
          app.store.db
            .prepare('SELECT sent_at FROM provider_connection_tests WHERE id=?')
            .get(started.id)
        ).toEqual(admitted);
        expect(await post(app, model, key, 202, {}, cookie)).toEqual(done);
        expect(records().filter((row) => row.method === 'thread/start')).toHaveLength(1);
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        release();
      }
    }
  );

  test('Vertex location tests go to their locations with the saved credential and run beside each other', async () => {
    const { app, model: fixtureModel } = await setup();
    const saved =
      'https://aiplatform.googleapis.com/v1/projects/synthetic-project/locations/global/publishers/google/models';
    const connection = app.store.product.connection({
      title: 'Synthetic Vertex',
      protocol: 'vertex-gemini-v1',
      endpoint: saved,
      enabled: true,
      apiKey: 'synthetic-vertex-token',
    }) as Connection;
    const modelId = supportedModels('vertex-gemini-v1')[0].id;
    const model = app.store.product.model({
      title: 'Synthetic Vertex model',
      connectionId: connection.id,
      modelId,
      maxOutputTokens: 10000,
      temperature: null,
    }) as ModelPreset;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = vi.mocked(globalThis.fetch).mockImplementation(async () => {
      await gate;
      return sse({
        candidates: [
          { index: 0, content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP' },
        ],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 1, totalTokenCount: 9 },
      });
    });
    const located = await post(app, model, randomUUID(), 202, { location: 'us' });
    const elsewhere = await post(app, model, randomUUID(), 202, { location: 'eu' });
    const ordinary = await post(app, model);
    expect(await post(app, model, randomUUID(), 409, { location: 'us' })).toEqual({
      code: 'CONNECTION_TEST_RUNNING',
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    release();
    expect(await terminal(app, elsewhere.id)).toMatchObject({
      status: 'completed',
      location: 'eu',
    });
    expect(located.location).toBe('us');
    expect(ordinary).not.toHaveProperty('location');
    expect(await terminal(app, located.id)).toMatchObject({ status: 'completed', text: 'OK' });
    expect(await terminal(app, ordinary.id)).toMatchObject({ status: 'completed' });
    const sent = fetch.mock.calls.map(([url, init]) => ({
      url: String(url),
      authorization: new Headers(init?.headers).get('authorization'),
    }));
    expect(sent).toEqual(
      expect.arrayContaining([
        {
          url: `https://aiplatform.us.rep.googleapis.com/v1/projects/synthetic-project/locations/us/publishers/google/models/${modelId}:streamGenerateContent?alt=sse`,
          authorization: 'Bearer synthetic-vertex-token',
        },
        {
          url: `${saved}/${modelId}:streamGenerateContent?alt=sse`,
          authorization: 'Bearer synthetic-vertex-token',
        },
      ])
    );
    expect(app.store.product.stored<Connection>('connection', connection.id).endpoint).toBe(saved);
    await post(app, model, randomUUID(), 400, { location: 'us_central1' });
    await post(app, fixtureModel, randomUUID(), 400, { location: 'us' });
  });
});
