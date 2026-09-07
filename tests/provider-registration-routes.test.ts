import { injectWithFixtureBot } from './fixtures/chat.js';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp, type App } from '../server/app.js';
import type { Connection, ModelPreset, ChatProfile, Library } from '../core/product.js';
import type { RegistrationView } from '../core/provider-registration.js';
import type { Chat } from '../core/types.js';
import {
  loopbackProvider,
  sse,
  writeSse,
  type CapturedRequest,
} from './fixtures/loopback-provider.js';
import type { ServerResponse } from 'node:http';

type Owned = { directory: string; app?: App; close?: () => Promise<void>; release?: () => void };
const owned: Owned[] = [];
afterEach(async () => {
  for (const item of owned.splice(0).reverse()) {
    item.release?.();
    await item.app?.close();
    await item.close?.();
    const path = resolve(item.directory);
    const within = relative(resolve(tmpdir()), path);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(path).startsWith('uimori-registration-routes-')
    )
      throw new Error('Unsafe fixture cleanup');
    await rm(path, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});
const path = '/api/provider-management/registrations';
const ref = ({ id, revision }: { id: string; revision: number }) => ({ id, revision });
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
async function raw(
  app: App,
  url: string,
  body?: unknown,
  method: Method = body === undefined ? 'GET' : 'POST',
  cookie = '',
  headers: Record<string, string> = {}
) {
  return injectWithFixtureBot(app, {
    method,
    url,
    headers: {
      host: '127.0.0.1',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}
async function api<T>(
  app: App,
  url: string,
  body?: unknown,
  method: Method = body === undefined ? 'GET' : 'POST',
  cookie = ''
): Promise<T> {
  const response = await raw(app, url, body, method, cookie);
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as T;
}
async function fixture(
  handler: (request: CapturedRequest, response: ServerResponse) => void | Promise<void>,
  authenticated = false
) {
  const item: Owned = { directory: await mkdtemp(join(tmpdir(), 'uimori-registration-routes-')) };
  owned.push(item);
  const credentialEnv = 'NARRATIVE_PROVIDER_REG_' + randomUUID().replaceAll('-', '').toUpperCase();
  const secret = 'CANARY_' + randomUUID();
  vi.stubEnv(credentialEnv, secret);
  const failures: unknown[] = [];
  const provider = await loopbackProvider(async (request, response) => {
    try {
      expect(request.headers.authorization).toBe(`Bearer ${secret}`);
      await handler(request, response);
    } catch (error) {
      failures.push(error);
      throw error;
    }
  });
  item.close = provider.close;
  const accessToken = authenticated ? 'local-app-token-' + randomUUID() : undefined;
  const launch = async () => {
    const app = await createApp({
      dbPath: join(item.directory, 'test.sqlite'),
      buildId: 'registration-routes-synthetic',
      instanceId: randomUUID(),
      testMode: true,
      approvedOrigins: [provider.origin],
      ...(accessToken ? { accessToken } : {}),
    });
    item.app = app;
    await app.listen({ port: 0, host: '127.0.0.1' });
    return app;
  };
  const app = await launch();
  const login = async (current = app) => {
    if (!accessToken) return '';
    const response = await raw(current, '/api/session', { token: accessToken });
    expect(response.statusCode).toBe(200);
    return String(response.headers['set-cookie']).split(';')[0];
  };
  const cookie = await login();
  const connection = await api<Connection>(
    app,
    '/api/connections',
    {
      title: 'Synthetic assistant',
      protocol: 'fixture-sse-v1',
      endpoint: provider.endpoint,
      credentialEnv,
      enabled: true,
    },
    'POST',
    cookie
  );
  const model = await api<ModelPreset>(
    app,
    '/api/model-presets',
    {
      title: 'Synthetic registration model',
      connectionId: connection.id,
      modelId: 'synthetic-registration',
      maxOutputTokens: 2048,
      temperature: null,
    },
    'POST',
    cookie
  );
  const chat = await api<Chat>(
    app,
    '/api/chats',
    { title: 'Unchanged role fixture' },
    'POST',
    cookie
  );
  const profile = await api<ChatProfile>(
    app,
    `/api/chats/${chat.id}/profile`,
    undefined,
    'GET',
    cookie
  );
  const command = {
    key: randomUUID(),
    request: '새 로컬 공급자와 모델 등록안을 만들어 주세요.',
    target: ref(model),
  };
  return {
    item,
    app,
    launch,
    login,
    provider,
    credentialEnv,
    secret,
    connection,
    model,
    chat,
    profile,
    command,
    cookie,
    failures,
  };
}
type State = Awaited<ReturnType<typeof fixture>>;
const proposal = (state: State) => ({
  connection: {
    kind: 'new',
    draft: {
      title: 'New disabled connection',
      protocol: 'openai-chat-v1',
      endpoint: `${state.provider.origin}/v1`,
      enabled: false,
    },
  },
  model: {
    title: 'New model',
    modelId: 'proposed/model',
    maxOutputTokens: 2048,
    temperature: null,
  },
});
async function complete(response: ServerResponse, plan: unknown) {
  await writeSse(response, [
    {
      type: 'tool_delta',
      index: 0,
      id: 'proposal',
      name: 'registration.propose',
      argumentsDelta: JSON.stringify(plan),
    },
    { type: 'usage', inputTokens: 9, outputTokens: 4 },
    { type: 'done', reason: 'tool_calls' },
  ]);
}
async function waitFor(state: State, id: string, current = state.app, cookie = state.cookie) {
  await expect
    .poll(
      async () =>
        (await api<RegistrationView>(current, `${path}/${id}`, undefined, 'GET', cookie)).status,
      { timeout: 5000 }
    )
    .not.toBe('running');
  expect(state.failures).toEqual([]);
  return api<RegistrationView>(current, `${path}/${id}`, undefined, 'GET', cookie);
}
const savedConnection = (c: Connection, changes: Record<string, unknown>) => ({
  title: c.title,
  protocol: c.protocol,
  endpoint: c.endpoint,
  ...(c.credentialEnv ? { credentialEnv: c.credentialEnv } : {}),
  enabled: c.enabled,
  expectedRevision: c.revision,
  ...changes,
});

test('registration routes produce a reviewable plan then explicitly apply once without changing any role', async () => {
  const state = await fixture(async (request, response) => {
    const journal = state.app.store.product.all('registration-run') as any[];
    expect(journal).toHaveLength(1);
    expect(journal[0].status).toBe('running');
    expect(journal[0].attempts).toHaveLength(1);
    expect(journal[0].attempts[0].status).toBe('running');
    const body = JSON.parse(request.body);
    expect(body.input.task).toBe(state.command.request);
    expect(body.input).not.toHaveProperty('source');
    await complete(response, proposal(state));
  });
  const before = await api<Library>(state.app, '/api/library');
  const admitted = await api<RegistrationView>(state.app, path, state.command);
  const ready = await waitFor(state, admitted.id);
  expect(ready).toMatchObject({
    status: 'ready',
    modelCalls: 1,
    usage: { inputTokens: 9, outputTokens: 4, costUsd: null, raw: null },
  });
  expect(await api<Library>(state.app, '/api/library')).toEqual(before);
  expect(ready.applied).toBeNull();
  const apply = { expectedRevision: ready.revision, planHash: ready.planHash };
  const applied = await api<RegistrationView>(state.app, `${path}/${ready.id}/apply`, apply);
  expect(applied.status).toBe('applied');
  const after = await api<Library>(state.app, '/api/library');
  expect(after.connections).toHaveLength(before.connections.length + 1);
  expect(after.models).toHaveLength(before.models.length + 1);
  expect(after.connections.find((c) => c.id === applied.applied!.connection.id)).toMatchObject({
    enabled: false,
  });
  expect(after.models.find((m) => m.id === applied.applied!.model.id)).toMatchObject({
    modelId: 'proposed/model',
    connectionId: applied.applied!.connection.id,
  });
  expect(await api<ChatProfile>(state.app, `/api/chats/${state.chat.id}/profile`)).toEqual(
    state.profile
  );
  expect(await api<RegistrationView>(state.app, `${path}/${ready.id}/apply`, apply)).toEqual(
    applied
  );
  expect(await api<Library>(state.app, '/api/library')).toEqual(after);
  expect(state.provider.requests).toHaveLength(1);
  expect(JSON.stringify(state.app.store.product.all('registration-run'))).not.toContain(
    state.secret
  );
});

test('same registration key reuses running and ready results; different input conflicts without another call', async () => {
  const received = deferred();
  const gate = deferred();
  const state = await fixture(async (_request, response) => {
    received.release();
    await gate.promise;
    await complete(response, proposal(state));
  });
  state.item.release = gate.release;
  const first = await api<RegistrationView>(state.app, path, state.command);
  await received.promise;
  expect((await api<RegistrationView>(state.app, path, state.command)).id).toBe(first.id);
  expect(
    (await raw(state.app, path, { ...state.command, request: 'Different request' })).statusCode
  ).toBe(409);
  gate.release();
  const ready = await waitFor(state, first.id);
  expect(await api<RegistrationView>(state.app, `${path}/by-key/${state.command.key}`)).toEqual(
    ready
  );
  expect(await api<RegistrationView>(state.app, path, state.command)).toEqual(ready);
  expect(state.provider.requests).toHaveLength(1);
});

test('unknown target and unsupported provider proposal cannot write connection/model settings', async () => {
  const state = await fixture(async (_request, response) => {
    const plan = proposal(state);
    plan.connection.draft.protocol = 'unregistered-protocol';
    await complete(response, plan);
  });
  const before = await api<Library>(state.app, '/api/library');
  expect(
    (await raw(state.app, path, { ...state.command, target: { id: 'missing-model', revision: 1 } }))
      .statusCode
  ).toBe(404);
  expect(state.provider.requests).toHaveLength(0);
  const result = await waitFor(
    state,
    (await api<RegistrationView>(state.app, path, state.command)).id
  );
  expect(result).toMatchObject({ status: 'failed', plan: null, applied: null });
  expect(await api<Library>(state.app, '/api/library')).toEqual(before);
  expect(
    (
      await raw(state.app, `${path}/${result.id}/apply`, {
        expectedRevision: result.revision,
        planHash: 'a'.repeat(64),
      })
    ).statusCode
  ).toBe(409);
  expect(state.provider.requests).toHaveLength(1);
});

test('readiness reports only environment presence and rejects foreign Host/Origin or missing session', async () => {
  const state = await fixture((_request, response) => {
    response.writeHead(500);
    response.end();
  }, true);
  const url = `/api/provider-management/connections/${state.connection.id}/readiness`;
  const ready = await api<any>(state.app, url, undefined, 'GET', state.cookie);
  expect(ready).toMatchObject({ credentialStatus: 'configured', originApproved: true });
  expect(JSON.stringify(ready)).not.toContain(state.secret);
  vi.stubEnv(state.credentialEnv, '');
  expect(await api(state.app, url, undefined, 'GET', state.cookie)).toMatchObject({
    credentialStatus: 'missing',
  });
  expect((await raw(state.app, path, state.command, 'POST')).statusCode).toBe(401);
  expect(
    (await raw(state.app, path, state.command, 'POST', state.cookie, { host: 'outside.invalid' }))
      .statusCode
  ).toBe(403);
  expect(
    (
      await raw(state.app, path, state.command, 'POST', state.cookie, {
        origin: 'http://127.0.0.1:65534',
      })
    ).statusCode
  ).toBe(403);
  expect(state.provider.requests).toHaveLength(0);
});

test('logout and connection revocation during held response prevent adopting an otherwise valid proposal', async () => {
  for (const mode of ['logout', 'connection']) {
    const received = deferred();
    const gate = deferred();
    const state = await fixture(async (_request, response) => {
      received.release();
      await gate.promise;
      await complete(response, proposal(state));
    }, true);
    state.item.release = gate.release;
    const admitted = await api<RegistrationView>(
      state.app,
      path,
      state.command,
      'POST',
      state.cookie
    );
    await received.promise;
    let cookie = state.cookie;
    if (mode === 'logout') {
      await api(state.app, '/api/session', undefined, 'DELETE', cookie);
      cookie = await state.login();
    } else
      await api(
        state.app,
        `/api/connections/${state.connection.id}`,
        savedConnection(state.connection, { enabled: false }),
        'PUT',
        cookie
      );
    gate.release();
    const result = await waitFor(state, admitted.id, state.app, cookie);
    expect(result).toMatchObject({
      status: 'failed',
      error: 'CONNECTION_NOT_AUTHORIZED',
      plan: null,
    });
    expect(state.provider.requests).toHaveLength(1);
    expect(
      (await api<Library>(state.app, '/api/library', undefined, 'GET', cookie)).models
    ).toHaveLength(1);
  }
});

test('cancel endpoint stops a pending registration without settings writes or automatic replay', async () => {
  const received = deferred();
  const state = await fixture((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(sse({ type: 'text_delta', delta: '{' }));
    received.release();
  });
  const before = await api<Library>(state.app, '/api/library');
  const admitted = await api<RegistrationView>(state.app, path, state.command);
  await received.promise;
  await api(state.app, `${path}/${admitted.id}/cancel`, {});
  const result = await waitFor(state, admitted.id);
  expect(result).toMatchObject({ status: 'cancelled', plan: null });
  expect(await api<Library>(state.app, '/api/library')).toEqual(before);
  expect((await api<RegistrationView>(state.app, path, state.command)).status).toBe('cancelled');
  expect(state.provider.requests).toHaveLength(1);
});

test('graceful restart preserves a stopped uncertain provider attempt and GET/duplicate POST never replays it', async () => {
  const received = deferred();
  const state = await fixture((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(sse({ type: 'text_delta', delta: '{' }));
    received.release();
  });
  const admitted = await api<RegistrationView>(state.app, path, state.command);
  await received.promise;
  await state.app.close();
  state.item.app = undefined;
  const restarted = await state.launch();
  const result = await api<RegistrationView>(restarted, `${path}/${admitted.id}`);
  expect(result).toMatchObject({ status: 'cancelled', modelCalls: 1, plan: null });
  expect(await api<RegistrationView>(restarted, path, state.command)).toEqual(result);
  expect(await api<RegistrationView>(restarted, `${path}/by-key/${state.command.key}`)).toEqual(
    result
  );
  expect(state.provider.requests).toHaveLength(1);
  expect((await api<Library>(restarted, '/api/library')).models).toHaveLength(1);
  expect(state.failures).toEqual([]);
});

test('real catalog failure keeps prior list and a concurrent connection edit rejects the stale catalog response', async () => {
  let mode = 'success';
  const received = deferred();
  const gate = deferred();
  const state = await fixture(async (request, response) => {
    expect(request.url).toBe('/models');
    if (mode === 'failure') {
      response.writeHead(503);
      response.end();
      return;
    }
    if (mode === 'held') {
      received.release();
      await gate.promise;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        models: [
          { id: mode === 'held' ? 'late-model' : 'cached-model', label: 'Cached synthetic model' },
        ],
      })
    );
  });
  state.item.release = gate.release;
  const url = `/api/connections/${state.connection.id}/catalog`;
  const cached = await api<Connection>(state.app, url, {});
  expect(cached.catalog[0].id).toBe('cached-model');
  mode = 'failure';
  const failed = await api<Connection>(state.app, url, {});
  expect(failed.catalog).toEqual(cached.catalog);
  expect(failed.catalogError).toBe('CATALOG_UNAVAILABLE');
  expect(failed.catalogUpdatedAt).toBe(cached.catalogUpdatedAt);
  mode = 'held';
  const pending = raw(state.app, url, {});
  await received.promise;
  const renamed = await api<Connection>(
    state.app,
    `/api/connections/${failed.id}`,
    savedConnection(failed, { title: 'Edited while loading' }),
    'PUT'
  );
  gate.release();
  expect((await pending).statusCode).toBe(409);
  const current = (await api<Library>(state.app, '/api/library')).connections.find(
    (c) => c.id === failed.id
  )!;
  expect(current).toEqual(renamed);
  expect(current.catalog).toEqual(cached.catalog);
  expect(state.provider.requests).toHaveLength(3);
  expect(state.failures).toEqual([]);
});
