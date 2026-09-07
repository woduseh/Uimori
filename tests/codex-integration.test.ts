import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createApp, type App } from '../server/app.js';
import type { CodexRuntimeService } from '../server/codex-runtime.js';
import type { ProviderRequest, ProviderResult } from '../core/transport.js';

const owned: { directory: string; app?: App }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const item of owned.splice(0).reverse()) {
    await item.app?.close(); const target = resolve(item.directory), within = relative(resolve(tmpdir()), target);
    if (isAbsolute(within) || within.startsWith('..') || !basename(target).startsWith('uimori-codex-integration-')) throw new Error('Unsafe cleanup');
    await rm(target, { recursive: true, force: true });
  }
});
async function api(app: App, url: string, body?: unknown, method: 'GET'|'POST'|'PUT' = body === undefined ? 'GET' : 'POST', status = 200): Promise<any> {
  const response = await app.inject({ method, url, headers: { host: '127.0.0.1', 'content-type': 'application/json' }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
  expect(response.statusCode, response.body).toBe(status); return response.json();
}
const ref = (value: { id: string }) => ({ id: value.id });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('runtime HTTP routes enforce authentication and Origin and redact failures with no-store', async () => {
  const state = { available: true, authenticated: false, authMode: null, error: null, login: null, planType: null, limits: [] };
  const status = vi.fn(async () => state), login = vi.fn(async () => state), cancelLogin = vi.fn(async () => state), logout = vi.fn(async () => state);
  const runtime: CodexRuntimeService = { status, login, cancelLogin, logout, catalog: async () => [], execute: async () => { throw new Error('Unexpected execute'); }, close: async () => {} };
  const item = { directory: await mkdtemp(join(tmpdir(), 'uimori-codex-integration-')) } as (typeof owned)[number]; owned.push(item);
  const app = await createApp({ dbPath: join(item.directory, 'auth.sqlite'), buildId: 'codex-http-synthetic', instanceId: randomUUID(), testMode: true, accessToken: 'synthetic-access-token', codexRuntime: runtime }); item.app = app; await app.ready();
  const root = '/api/agent-runtimes/codex';
  const routes = [{ method: 'GET' as const, url: root }, { method: 'POST' as const, url: `${root}/login` }, { method: 'POST' as const, url: `${root}/login/cancel` }, { method: 'DELETE' as const, url: `${root}/session` }];
  for (const route of routes) {
    const response = await app.inject({ ...route, headers: { host: '127.0.0.1' } }); expect(response.statusCode).toBe(401);
  }
  expect(status).not.toHaveBeenCalled(); expect(login).not.toHaveBeenCalled();
  const session = await app.inject({ method: 'POST', url: '/api/session', headers: { host: '127.0.0.1', 'content-type': 'application/json' }, payload: JSON.stringify({ token: 'synthetic-access-token' }) });
  expect(session.statusCode).toBe(200); const cookie = String(session.headers['set-cookie']).split(';')[0];
  for (const route of routes) {
    const response = await app.inject({ ...route, headers: { host: '127.0.0.1', cookie, origin: 'https://untrusted.invalid' } }); expect(response.statusCode).toBe(403);
  }
  for (const route of routes.filter(route => route.method !== 'GET')) {
    const response = await app.inject({ ...route, headers: { host: '127.0.0.1', cookie, 'content-type': 'application/json' }, payload: JSON.stringify({ executable: 'untrusted-command', token: 'untrusted-token' }) });
    expect(response.statusCode).toBe(400); expect(response.headers['cache-control']).toBe('no-store');
  }
  expect(login).not.toHaveBeenCalled(); expect(cancelLogin).not.toHaveBeenCalled(); expect(logout).not.toHaveBeenCalled();
  for (const route of routes) {
    const response = await app.inject({ ...route, headers: { host: '127.0.0.1', cookie, origin: 'http://127.0.0.1' } });
    expect(response.statusCode, response.body).toBe(200); expect(response.headers['cache-control']).toBe('no-store'); expect(response.json()).toEqual(state);
  }
  for (const [route, action] of [[routes[1], login], [routes[2], cancelLogin], [routes[3], logout]] as const) {
    action.mockRejectedValueOnce(new Error('SYNTHETIC_SECRET C:\\private\\auth.json'));
    const response = await app.inject({ ...route, headers: { host: '127.0.0.1', cookie } });
    expect(response.statusCode).toBe(503); expect(response.headers['cache-control']).toBe('no-store'); expect(response.body).toContain('CODEX_UNAVAILABLE'); expect(response.body).not.toContain('SYNTHETIC_SECRET'); expect(response.body).not.toContain('auth.json');
  }
});

test('app routes every agent role through Codex and persists RPC attempts, proposals and archive contracts', async () => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External calls forbidden'));
  const calls: ProviderRequest[] = [];
  const status = async () => ({ available: true, authenticated: true, authMode: 'chatgpt' as const, error: null, login: null, planType: null, limits: [] });
  const runtime: CodexRuntimeService = { status, login: status, cancelLogin: status, logout: status, catalog: async () => [], close: async () => {}, execute: async (connection, request, options) => {
    calls.push(structuredClone(request));
    const body = { method: 'turn/start', role: request.role, model: request.modelId };
    await options.onWire?.({ connectionId: connection.id, protocol: connection.protocol, role: request.role, modelId: request.modelId, method: 'RPC', url: 'codex://local', headers: {}, body, bodySha256: hash(body), stablePrefixSha256: hash(request.stable) });
    const source = request.input.source as any;
    let output: unknown;
    if (request.stable.tools.some(tool => tool.name === 'registration.propose')) output = { connection: { kind: 'new', draft: { title: 'Proposed Codex', protocol: 'codex-app-server-v1', endpoint: 'codex://local', enabled: false } }, model: { title: 'Proposed model', modelId: 'synthetic-new', maxOutputTokens: 1024, temperature: null } };
    else if (request.role === 'main') output = 'The keeper opened the gate.';
    else if (request.role === 'state') output = { sourceRevision: source.revision, sourceHash: source.hash, moduleRevision: source.module.revision, operations: [] };
    else if (request.role === 'memory') output = { entries: [] };
    else if (request.role === 'translation') output = { sourceRevision: source.sourceRevision, sourceHash: source.sourceHash, chunkId: source.chunkId, segments: source.blocks.map((block: any) => ({ anchors: [block.anchor], text: block.text })) };
    else output = { sourceRevision: source.sourceRevision, sourceHash: source.sourceHash, ...(request.role === 'status' ? { kind: 'display-only' } : {}), entries: [] };
    return { status: 'completed', text: typeof output === 'string' ? output : JSON.stringify(output), toolCalls: [], refusal: null, error: null, usage: { inputTokens: null, outputTokens: null, costUsd: null, raw: { modelCalls: null }, priceRevision: null }, opaqueState: null } satisfies ProviderResult;
  } };
  const item = { directory: await mkdtemp(join(tmpdir(), 'uimori-codex-integration-')) } as (typeof owned)[number]; owned.push(item);
  const app = await createApp({ dbPath: join(item.directory, 'test.sqlite'), buildId: 'codex-synthetic', instanceId: randomUUID(), testMode: true, codexRuntime: runtime }); item.app = app; await app.ready();
  const connection = await api(app, '/api/connections', { title: 'Codex', protocol: 'codex-app-server-v1', endpoint: 'codex://local', enabled: true });
  const model = await api(app, '/api/model-presets', { title: 'Synthetic Codex', connectionId: connection.id, modelId: 'synthetic', maxOutputTokens: 1024, temperature: null });
  const chat = await api(app, '/api/chats', { title: 'Synthetic Codex story' });
  const profile = await api(app, `/api/chats/${chat.id}/profile`);
  await api(app, `/api/chats/${chat.id}/profile`, { expectedRevision: profile.revision, attachments: [], creative: profile.creative, routes: { main: ref(model), translation: ref(model), status: ref(model), image: ref(model) }, image: true }, 'PUT');
  await api(app, `/api/chats/${chat.id}/story/config`, { expectedRevision: 0, module: { id: 'wallet', revision: 1, name: 'Wallet', mode: 'authoritative', fields: { coins: { type: 'number', initial: 10, min: 0, max: 100 } }, rules: {} }, stateModel: ref(model), memory: { enabled: true, model: ref(model), recentCount: 2, maxPacketChars: 60000 } }, 'PUT');
  const run = await api(app, `/api/chats/${chat.id}/runs`, { request: 'Open the gate.', expectedRevision: null, expectedSettingsRevision: chat.settingsRevision, idempotencyKey: randomUUID() });
  await expect.poll(() => ({ status: app.store.run(run.id).status, error: app.store.run(run.id).error, attempts: app.store.product.attempts(chat.id).map(a => ({status:a.status,error:a.error})) })).toEqual(expect.objectContaining({status:'completed',error:null}));
  const source = app.store.source(app.store.chat(chat.id).headRevision!);
  await api(app, `/api/sources/${source.id}/translation`, {});
  await expect.poll(() => [...new Set(calls.map(call => call.role))].sort()).toEqual(['image', 'main', 'memory', 'state', 'status', 'translation']);
  await expect.poll(() => app.store.product.attempts(chat.id).filter(attempt => attempt.status === 'running').length).toBe(0);
  expect(app.store.product.attempts(chat.id)).toHaveLength(6);
  for (const attempt of app.store.product.attempts(chat.id)) { expect(attempt.request).toMatchObject({ method: 'RPC', url: 'codex://local', body: { method: 'turn/start' } }); expect(attempt.costUsd).toBeNull(); }
  const registration = await api(app, '/api/provider-management/registrations', { key: randomUUID(), request: 'Create a model proposal.', target: {id:model.id,revision:model.revision} });
  await expect.poll(async () => (await api(app, `/api/provider-management/registrations/${registration.id}`)).status).toBe('ready');
  const archive = await api(app, '/api/export');
  const restoredItem = { directory: await mkdtemp(join(tmpdir(), 'uimori-codex-integration-')) } as (typeof owned)[number]; owned.push(restoredItem);
  const restored = await createApp({ dbPath: join(restoredItem.directory, 'restore.sqlite'), buildId: 'codex-restore', instanceId: randomUUID(), testMode: true, codexRuntime: runtime }); restoredItem.app = restored; await restored.ready();
  await api(restored, '/api/import', { archive });
  expect(JSON.stringify(archive)).toContain('codex://local');
  expect(restored.store.product.attempts(chat.id)).toEqual(app.store.product.attempts(chat.id));
  for (const role of ['state', 'memory']) expect(app.store.product.attempts(chat.id).find(attempt => attempt.role === role)?.storyJobId).toEqual(expect.any(String));
  const count = calls.length;
  await api(app, `/api/connections/${connection.id}`, { title: connection.title, protocol: connection.protocol, endpoint: connection.endpoint, enabled: false, expectedRevision: connection.revision }, 'PUT');
  await api(app, '/api/provider-management/registrations', { key: randomUUID(), request: 'Must not run.', target: {id:model.id,revision:model.revision} }, 'POST', 403);
  expect(calls).toHaveLength(count);
});
