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
  connectionTestRequest,
  providerConnectionTestRoutes,
  ProviderConnectionTestStore,
  CONNECTION_TEST_TIMEOUT_MS,
} from '../server/provider-connection-test.js';
import type { Connection, ModelPreset, ProviderProtocol } from '../core/product.js';
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
async function setup(
  options: { approvedOrigins?: string[]; accessToken?: string; credentialEnv?: string } = {}
) {
  const directory = await mkdtemp(join(tmpdir(), 'uimori-connection-test-'));
  const item: (typeof owned)[number] = { directory };
  owned.push(item);
  const app = (item.app = await createApp({
    dbPath: join(directory, 'story.sqlite'),
    buildId: 'synthetic-test',
    approvedOrigins: options.approvedOrigins ?? ['http://127.0.0.1:9'],
    accessToken: options.accessToken,
  }));
  await app.ready();
  const connection = app.store.product.connection({
    title: 'Synthetic fixture',
    protocol: 'fixture-sse-v1',
    endpoint,
    enabled: true,
    ...(options.credentialEnv ? { credentialEnv: options.credentialEnv } : {}),
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
const completed = () =>
  sse(
    { type: 'text_delta', delta: 'OK' },
    {
      type: 'usage',
      inputTokens: 12,
      outputTokens: 1,
      raw: { hidden: 'RAW_USAGE_MUST_NOT_SURVIVE' },
    },
    { type: 'opaque_state', state: 'OPAQUE_MUST_NOT_SURVIVE' },
    { type: 'done', reason: 'stop' }
  );
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
  test('persists before send, deduplicates pending and finished requests, and isolates diagnostics from story archives', async () => {
    const { app, model } = await setup();
    let release!: (value: Response) => void;
    vi.mocked(fetch).mockImplementation(async (_url, options) => {
      const row = app.store.db
        .prepare('SELECT sent_at,body FROM provider_connection_tests')
        .get() as { sent_at: string; body: string };
      expect(row.sent_at).toBeTypeOf('string');
      expect(JSON.parse(row.body).status).toBe('running');
      const body = JSON.parse(String(options?.body));
      expect(body).toMatchObject({
        stable: { tools: [] },
        generation: { maxOutputTokens: 256, temperature: null },
        input: { task: 'API 연결 테스트 중이니 OK만 답해주세요.', controls: {} },
      });
      for (const field of ['history', 'source', 'catalog', 'results'])
        expect(body.input).not.toHaveProperty(field);
      expect(body.generation).not.toHaveProperty('thinkingLevel');
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    const key = randomUUID(),
      started = await post(app, model, key);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(await post(app, model, key)).toEqual(started);
    await post(app, model, randomUUID(), 409);
    release(completed());
    const done = await terminal(app, started.id);
    expect(done).toMatchObject({
      status: 'completed',
      text: 'OK',
      truncated: false,
      modelId: model.id,
      modelRevision: model.revision,
      providerModelId: model.modelId,
      usage: { inputTokens: 12, outputTokens: 1, costUsd: null },
      error: null,
    });
    expect(done.latencyMs).toBeGreaterThanOrEqual(0);
    expect(await post(app, model, key)).toEqual(done);
    expect(fetch).toHaveBeenCalledTimes(1);
    const stored = JSON.stringify(
      app.store.db.prepare('SELECT * FROM provider_connection_tests').all()
    );
    expect(stored).not.toContain('OPAQUE_MUST_NOT_SURVIVE');
    expect(stored).not.toContain('RAW_USAGE_MUST_NOT_SURVIVE');
    expect(stored).not.toContain('authorization');
    for (const table of ['chats', 'runs', 'sources', 'attempts', 'jobs'])
      expect(app.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toMatchObject({
        n: 0,
      });
    expect(app.store.product.export().tables).not.toHaveProperty('provider_connection_tests');
    await post(app, { ...model, revision: 2 }, key, 409);
  });

  test('rejects stale or disabled models, disabled connections, unapproved origins, and user-supplied prompt fields', async () => {
    const { app, model, connection } = await setup({ approvedOrigins: [] });
    await post(app, { ...model, revision: 2 }, randomUUID(), 409);
    await post(app, model, randomUUID(), 400, { prompt: 'Unrequested extra content' });
    const attempt = await post(app, model);
    expect(await terminal(app, attempt.id)).toMatchObject({
      status: 'error',
      error: 'ENDPOINT_NOT_APPROVED',
    });
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
    const { app, model } = await setup({ credentialEnv: 'SYNTHETIC_CONNECTION_TEST_KEY' });
    const probe = Fastify() as unknown as App;
    providerConnectionTestRoutes(probe, app.store, {
      approvedOrigins: ['http://127.0.0.1:9'],
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

  test('bounds returned and persisted text to 2000 characters', async () => {
    const { app, model } = await setup();
    vi.mocked(fetch).mockResolvedValueOnce(
      sse({ type: 'text_delta', delta: 'a'.repeat(2100) }, { type: 'done', reason: 'stop' })
    );
    const started = await post(app, model);
    expect(await terminal(app, started.id)).toMatchObject({
      status: 'completed',
      text: 'a'.repeat(2000),
      truncated: true,
    });
  });

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
    const admitted = new ProviderConnectionTestStore(app.store).create(model.id, {
      expectedRevision: model.revision,
      idempotencyKey: key,
    });
    await app.close();
    item.app = undefined;
    const reopened = (item.app = await createApp({
      dbPath: join(item.directory, 'story.sqlite'),
      buildId: 'recovery-test',
      approvedOrigins: ['http://127.0.0.1:9'],
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

  test.each([
    'unchanged',
    'model-edited',
    'model-disabled',
    'connection-disabled',
    'session-revoked',
  ])('checks Codex authority after thread setup: %s', async (change) => {
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
      // Hold the real synthetic stdio thread response, after durable onWire and before turn/start.
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
      if (change === 'model-disabled')
        app.store.product.model(modelUpdate(model, { enabled: false }), model.id);
      if (change === 'connection-disabled')
        app.store.product.connection(
          {
            title: connection.title,
            protocol: connection.protocol,
            endpoint: connection.endpoint,
            enabled: false,
            expectedRevision: connection.revision,
          },
          connection.id
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
              error: change.startsWith('model-')
                ? 'CONNECTION_TEST_MODEL_CHANGED'
                : change === 'session-revoked'
                  ? 'SESSION_NOT_AUTHORIZED'
                  : 'CONNECTION_NOT_AUTHORIZED',
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
  });

  test('all registered models use valid minimum test effort, no tools, cache disabled, and the selected service tier', () => {
    for (const protocol of [
      'vertex-gemini-v1',
      'openai-responses-v1',
      'openai-chat-v1',
      'anthropic-messages-v1',
    ] as ProviderProtocol[]) {
      for (const cap of supportedModels(protocol)) {
        const connection: Connection = {
          id: 'c',
          revision: 1,
          title: 'c',
          protocol,
          endpoint:
            protocol === 'vertex-gemini-v1'
              ? 'https://aiplatform.googleapis.com/v1/projects/synthetic-project/locations/global/publishers/google/models'
              : protocol === 'anthropic-messages-v1'
                ? 'https://api.anthropic.com/v1'
                : 'https://api.openai.com/v1',
          enabled: true,
          catalog: [],
          catalogError: null,
        };
        const model: ModelPreset = {
          id: 'm',
          revision: 1,
          title: 'm',
          connectionId: 'c',
          modelId: cap.id,
          maxOutputTokens: 10000,
          temperature: null,
          serviceTier: cap.serviceTiers?.at(-1),
          capabilityRevision: cap.revision,
        };
        const request = connectionTestRequest(model, connection);
        expect(request.generation).toMatchObject({
          maxOutputTokens: 256,
          temperature: null,
          serviceTier: model.serviceTier,
        });
        expect(request.stable.tools).toEqual([]);
        if (cap.reasoningEfforts)
          expect(request.generation?.reasoningEffort).toBe(
            cap.reasoningEfforts.includes('none') ? 'none' : 'low'
          );
        if (cap.thinkingLevels)
          expect(request.generation?.thinkingLevel).toBe(cap.thinkingLevels[0]);
        if (cap.outputEfforts) expect(request.generation?.outputEffort).toBe('low');
        if (cap.cacheModes) expect(request.generation?.cacheMode).toBe('disabled');
      }
    }
  });
});
