import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ProviderConnectionTest } from '../core/provider-connection-test.js';
import { createApp, type App } from '../server/app.js';
import { CONNECTION_TEST_TIMEOUT_MS } from '../server/provider-connection-test.js';

type Status = {
  revision: number;
  configured: boolean;
  credentialSource: 'saved' | 'environment' | 'missing';
  hasSavedKey: boolean;
  modelId: string;
  endpoint: string;
  latestTest: ProviderConnectionTest | null;
};
const base = '/api/provider-management/jev';
const savedKey = 'synthetic-jev-saved-secret-never-export';
const envKey = 'synthetic-jev-environment-secret-never-export';
const owned: { directory: string; app?: App }[] = [];

beforeEach(() => {
  vi.stubEnv('TYPESAFE_API_KEY', '');
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected JEV network request'));
});
afterEach(async () => {
  for (const item of owned.splice(0).reverse()) {
    await item.app?.close();
    const target = resolve(item.directory),
      within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('uimori-jev-provider-')
    )
      throw new Error('Unsafe test cleanup');
    await rm(target, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function setup(options: { accessToken?: string; maintenance?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'uimori-jev-provider-'));
  const item: (typeof owned)[number] = { directory };
  owned.push(item);
  const app = (item.app = await createApp({
    dbPath: join(directory, 'story.sqlite'),
    buildId: 'jev-provider-test',
    ...options,
  }));
  await app.ready();
  return { app, item };
}
async function status(app: App) {
  const response = await app.inject({ method: 'GET', url: base });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as Status;
}
async function save(app: App, expectedRevision: number, apiKey = savedKey, code = 200) {
  const response = await app.inject({
    method: 'PUT',
    url: base,
    payload: { expectedRevision, apiKey },
  });
  expect(response.statusCode, response.body).toBe(code);
  expect(response.body).not.toContain(savedKey);
  expect(response.body).not.toContain(envKey);
  return response.json() as Status;
}
async function start(app: App, revision: number, key = randomUUID(), code = 202) {
  const response = await app.inject({
    method: 'POST',
    url: `${base}/test`,
    payload: { expectedRevision: revision, idempotencyKey: key },
  });
  expect(response.statusCode, response.body).toBe(code);
  return response.json() as ProviderConnectionTest;
}
async function terminal(app: App, id: string) {
  let view!: ProviderConnectionTest;
  await vi.waitFor(async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/provider-management/tests/${id}`,
    });
    expect(response.statusCode, response.body).toBe(200);
    view = response.json() as ProviderConnectionTest;
    expect(view.status).not.toBe('running');
  });
  return view;
}
function success(init?: RequestInit, score = 0.95) {
  const body = JSON.parse(String(init?.body));
  return Response.json({
    model: 'jev-latest',
    answers: Object.fromEntries(
      Object.keys(body.questions).map((name) => [name, { type: 'noul', noul: score }])
    ),
    usage: { input_tokens: 32, output_tokens: 2, hidden: 'PRIVATE_RAW_USAGE' },
    hidden: 'PRIVATE_RAW_RESPONSE',
  });
}

describe('JEV connection settings and explicit diagnostics', () => {
  test.each([
    ['whitespace', '   '],
    ['header injection', 'secret\r\nheader:value'],
    ['oversized', 'x'.repeat(4097)],
  ])('rejects an invalid key without changing settings: %s', async (_name, value) => {
    const { app } = await setup();
    const initial = await status(app);
    await save(app, initial.revision, value, 400);
    expect(await status(app)).toEqual(initial);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('JEV reads only the DB and deletion does not fall back to environment keys', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', envKey);
    const { app } = await setup();
    const initial = await status(app);
    expect(initial).toMatchObject({
      configured: false,
      credentialSource: 'missing',
      hasSavedKey: false,
    });
    vi.mocked(fetch).mockImplementation(async (_url, init) => success(init));
    const saved = await save(app, initial.revision);
    await terminal(app, (await start(app, saved.revision)).id);
    expect(new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).get('authorization')).toBe(
      `Bearer ${savedKey}`
    );
    const conflict = await app.inject({
      method: 'DELETE',
      url: base,
      payload: { expectedRevision: initial.revision },
    });
    expect(conflict.statusCode).toBe(409);
    const deleted = await app.inject({
      method: 'DELETE',
      url: base,
      payload: { expectedRevision: saved.revision },
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    const fallback = deleted.json() as Status;
    expect(fallback).toMatchObject({
      configured: false,
      credentialSource: 'missing',
      hasSavedKey: false,
    });
    expect(fallback.revision).toBeGreaterThan(saved.revision);
    await start(app, fallback.revision, randomUUID(), 400);
    expect(JSON.stringify(await status(app))).not.toContain(envKey);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('runs one tiny fixed judgment, deduplicates pending and completed requests, and retains only safe diagnostics', async () => {
    const { app } = await setup();
    const saved = await save(app, (await status(app)).revision);
    let release!: () => void;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      expect(url).toBe('https://api.typesafe.ai/v1/systemone');
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${savedKey}`);
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('jev-latest');
      expect(Object.keys(body.questions)).toHaveLength(1);
      expect(Object.values(body.questions)[0]).toMatchObject({ type: 'noul' });
      expect(String(init?.body).length).toBeLessThan(1500);
      const row = app.store.db
        .prepare('SELECT sent_at,body FROM provider_connection_tests')
        .get() as { sent_at: string; body: string };
      expect(row.sent_at).toBeTypeOf('string');
      expect(JSON.parse(row.body).status).toBe('running');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return success(init);
    });
    const key = randomUUID();
    const started = await start(app, saved.revision, key);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(await start(app, saved.revision, key)).toEqual(started);
    await start(app, saved.revision, randomUUID(), 409);
    release();
    const done = await terminal(app, started.id);
    expect(done).toMatchObject({
      status: 'completed',
      providerModelId: 'jev-latest',
      modelRevision: saved.revision,
      error: null,
      usage: { inputTokens: 32, outputTokens: 2, costUsd: null },
    });
    expect(done.text).toContain('0.95');
    expect(done.latencyMs).toBeGreaterThanOrEqual(0);
    expect(await start(app, saved.revision, key)).toEqual(done);
    await start(app, saved.revision + 1, key, 409);
    expect((await status(app)).latestTest).toEqual(done);
    expect(fetch).toHaveBeenCalledTimes(1);
    const stored = JSON.stringify(
      app.store.db.prepare('SELECT * FROM provider_connection_tests').all()
    );
    for (const secret of [savedKey, 'PRIVATE_RAW_USAGE', 'PRIVATE_RAW_RESPONSE', 'authorization'])
      expect(stored).not.toContain(secret);
    for (const table of ['chats', 'runs', 'sources', 'attempts', 'jobs'])
      expect(app.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toMatchObject({
        n: 0,
      });
  });

  test.each([
    ['401', () => new Response('PRIVATE_ERROR_RESPONSE', { status: 401 }), 'JEV_HTTP_401'],
    ['429', () => new Response('PRIVATE_ERROR_RESPONSE', { status: 429 }), 'JEV_HTTP_429'],
    [
      'malformed',
      () => Response.json({ model: 'jev-latest', answers: {} }),
      'JEV_RESPONSE_INVALID',
    ],
    [
      'network',
      () => {
        throw new Error('PRIVATE_ERROR_RESPONSE');
      },
      'JEV_EXECUTION_FAILED',
    ],
  ] as const)('retains a safe %s failure without retry', async (_name, response, error) => {
    const { app } = await setup();
    const saved = await save(app, (await status(app)).revision);
    vi.mocked(fetch).mockImplementation(async () => response());
    const key = randomUUID();
    const started = await start(app, saved.revision, key);
    const done = await terminal(app, started.id);
    expect(done).toMatchObject({ status: 'error', error, text: '' });
    expect(JSON.stringify(done)).not.toContain('PRIVATE_ERROR_RESPONSE');
    expect(await start(app, saved.revision, key)).toEqual(done);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('rejects caller-supplied judgment content and stale admission before dispatch', async () => {
    const { app } = await setup();
    const saved = await save(app, (await status(app)).revision);
    await start(app, saved.revision + 1, randomUUID(), 409);
    const injected = await app.inject({
      method: 'POST',
      url: `${base}/test`,
      payload: {
        expectedRevision: saved.revision,
        idempotencyKey: randomUUID(),
        state: 'private chat',
      },
    });
    expect(injected.statusCode).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('missing credentials cannot create a paid diagnostic or a journal attempt', async () => {
    const { app } = await setup();
    await start(app, (await status(app)).revision, randomUUID(), 400);
    expect(
      app.store.db.prepare('SELECT COUNT(*) AS n FROM provider_connection_tests').get()
    ).toEqual({
      n: 0,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('the connection deadline returns a safe timeout and never retries the attempted call', async () => {
    const { app } = await setup();
    const saved = await save(app, (await status(app)).revision);
    let expire!: () => void;
    const schedule = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay === CONNECTION_TEST_TIMEOUT_MS) expire = () => callback(...args);
      return schedule(callback, delay, ...args);
    }) as typeof setTimeout);
    vi.mocked(fetch).mockImplementation(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('PRIVATE_TIMEOUT')), {
            once: true,
          });
        })
    );
    const key = randomUUID();
    const started = await start(app, saved.revision, key);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(expire).toBeTypeOf('function');
    expire();
    const done = await terminal(app, started.id);
    expect(done).toMatchObject({ status: 'error', error: 'JEV_TIMEOUT', text: '' });
    expect(JSON.stringify(done)).not.toContain('PRIVATE_TIMEOUT');
    expect(await start(app, saved.revision, key)).toEqual(done);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('shutdown interrupts dispatched work and reopening never replays the same diagnostic', async () => {
    const { app, item } = await setup();
    const saved = await save(app, (await status(app)).revision);
    vi.mocked(fetch).mockImplementation(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('PRIVATE_STOP')), {
            once: true,
          });
        })
    );
    const key = randomUUID();
    const started = await start(app, saved.revision, key);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await app.close();
    item.app = undefined;
    const reopened = (item.app = await createApp({
      dbPath: join(item.directory, 'story.sqlite'),
      buildId: 'jev-provider-recovery',
    }));
    await reopened.ready();
    expect(await start(reopened, saved.revision, key)).toMatchObject({
      id: started.id,
      status: 'interrupted',
      error: 'SERVER_STOPPING',
      text: '',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('settings and tests require the existing access session', async () => {
    const { app } = await setup({ accessToken: 'synthetic-jev-session-token-123456789' });
    for (const method of ['GET', 'PUT', 'DELETE', 'POST'] as const) {
      const response = await app.inject({
        method,
        url: method === 'POST' ? `${base}/test` : base,
        ...(method !== 'GET' ? { payload: { expectedRevision: 0, apiKey: savedKey } } : {}),
      });
      expect(response.statusCode, `${method}: ${response.body}`).toBe(401);
      expect(response.body).not.toContain(savedKey);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  test('maintenance permits status reads and blocks credential changes and live tests', async () => {
    const { app } = await setup({ maintenance: true });
    const current = await status(app);
    for (const method of ['PUT', 'DELETE', 'POST'] as const) {
      const response = await app.inject({
        method,
        url: method === 'POST' ? `${base}/test` : base,
        payload: { expectedRevision: current.revision, apiKey: savedKey },
      });
      expect(response.statusCode, response.body).toBe(503);
      expect(response.json()).toMatchObject({ error: 'MAINTENANCE_CLOSED' });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
