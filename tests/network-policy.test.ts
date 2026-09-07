import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { createApp, type App } from '../server/app.js';
import { deniedBrowserRequest, listenAddress, networkPolicy } from '../server/network-policy.js';

const publicOrigin = 'https://story.example.test';
const accessToken = 'synthetic-self-host-access-token-0123456789';
const policy = networkPolicy({ publicOrigin, accessToken });
const owned: { directory: string; app?: App }[] = [];
afterEach(async () => {
  for (const item of owned.splice(0).reverse()) {
    await item.app?.close();
    const target = resolve(item.directory), within = relative(resolve(tmpdir()), target);
    if (isAbsolute(within) || within.startsWith('..') || !basename(target).startsWith('uimori-network-')) throw new Error('Unsafe test cleanup');
    await rm(target, { recursive: true, force: true });
  }
});
async function fixture(remote = true) {
  const item = { directory: await mkdtemp(join(tmpdir(), 'uimori-network-')), app: undefined as App | undefined };
  owned.push(item);
  item.app = await createApp({ dbPath: join(item.directory, 'test.sqlite'), buildId: 'network-synthetic', ...(remote ? { publicOrigin, accessToken } : {}) });
  return item.app;
}

describe('self-host network policy', () => {
  it('keeps local defaults and requires an explicit authenticated HTTPS origin for non-loopback binding', () => {
    expect(networkPolicy({})).toEqual({});
    expect(listenAddress({}, {})).toEqual({ host: '127.0.0.1', port: 4310 });
    for (const host of ['0.0.0.0', '::', '192.168.1.2']) expect(() => listenAddress({ NR_HOST: host }, {})).toThrow('requires self-host mode');
    expect(listenAddress({ NR_HOST: '0.0.0.0', NR_PORT: '0' }, policy)).toEqual({ host: '0.0.0.0', port: 0 });
    expect(listenAddress({ NR_HOST: '::1' }, {})).toEqual({ host: '::1', port: 4310 });
    for (const port of ['', '-1', '65536', '1e3', '43.10', ' 4310']) expect(() => listenAddress({ NR_PORT: port }, {})).toThrow('Invalid NR_PORT');
    for (const host of ['', 'story.example.test', '0.0.0.0:4310']) expect(() => listenAddress({ NR_HOST: host }, policy)).toThrow('NR_HOST');
  });
  it.each(['', 'http://story.example.test', 'https://user:password@story.example.test', 'https://story.example.test/chat',
    'https://story.example.test/path/..', 'https://story.example.test?', 'https://story.example.test#', 'https://story.example.test:0',
    'https://story.example.test,https://other.test', ' https://story.example.test', 'https://story.example.test\\'])('rejects malformed public origin %s', value => {
    expect(() => networkPolicy({ publicOrigin: value, accessToken })).toThrow('NR_PUBLIC_ORIGIN');
  });
  it('requires a usable token and denies test routes before creating a database', async () => {
    for (const token of [undefined, '', 'short', ' '.repeat(40), 'a'.repeat(1001)]) expect(() => networkPolicy({ publicOrigin, accessToken: token })).toThrow('NR_ACCESS_TOKEN');
    expect(() => networkPolicy({ publicOrigin, accessToken, testMode: true })).toThrow('NR_TEST_MODE');
    const item = { directory: await mkdtemp(join(tmpdir(), 'uimori-network-')) }; owned.push(item);
    const dbPath = join(item.directory, 'must-not-exist.sqlite');
    await expect(createApp({ dbPath, buildId: 'rejected', publicOrigin })).rejects.toThrow('NR_ACCESS_TOKEN');
    expect(existsSync(dbPath)).toBe(false);
  });
  it('canonicalizes the configured host/default port but grants no wildcard or subpath', () => {
    expect(networkPolicy({ publicOrigin: 'https://STORY.example.test:443/', accessToken })).toEqual(policy);
    expect(networkPolicy({ publicOrigin: 'https://[::1]:443/', accessToken }).publicHost).toBe('[::1]');
    expect(deniedBrowserRequest(policy, { method: 'GET', headers: { host: 'STORY.example.test:443' } })).toBeUndefined();
    for (const host of ['127.0.0.1', 'other.test', 'story.example.test.evil.test', 'story.example.test:444', 'story.example.test@evil.test',
      'story.example.test/path', 'story.example.test#x', 'story.example.test\\evil', 'story.example.test,evil.test', 'story.example.test%2f']) {
      expect(deniedBrowserRequest(policy, { method: 'GET', headers: { host } })).toBeTruthy();
    }
  });
  it('requires same-origin mutations and denies foreign/null origins and cross-site reads', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const origin of [undefined, 'null', 'https://evil.test', 'http://story.example.test', publicOrigin + '/']) {
        expect(deniedBrowserRequest(policy, { method, headers: { host: 'story.example.test', origin } })).toBeTruthy();
      }
      expect(deniedBrowserRequest(policy, { method, headers: { host: 'story.example.test', origin: publicOrigin } })).toBeUndefined();
    }
    expect(deniedBrowserRequest(policy, { method: 'GET', headers: { host: 'story.example.test' } })).toBeUndefined();
    expect(deniedBrowserRequest(policy, { method: 'GET', headers: { host: 'story.example.test', 'sec-fetch-site': 'cross-site' } })).toBeTruthy();
  });
  it('enforces policy on actual session/data routes and never trusts forwarded host or protocol', async () => {
    const app = await fixture();
    const headers = { host: 'story.example.test', origin: publicOrigin };
    expect((await app.inject({ url: '/api/session', headers })).json()).toEqual({ required: true, authenticated: false });
    for (const path of ['/api/chats', '/api/library', '/api/export', '/api/chats/unknown/events', '/api/assets/unknown', '/api/health']) {
      expect((await app.inject({ url: path, headers })).statusCode).toBe(401);
    }
    for (const badHeaders of [
      { host: 'localhost', origin: publicOrigin, 'x-forwarded-host': 'story.example.test', 'x-forwarded-proto': 'https' },
      { host: 'story.example.test', origin: 'https://evil.test', 'x-forwarded-host': 'story.example.test' },
      { host: 'story.example.test', 'x-forwarded-proto': 'https' },
    ]) expect((await app.inject({ method: 'POST', url: '/api/session', headers: badHeaders, payload: { token: accessToken } })).statusCode).toBe(403);
    const login = await app.inject({ method: 'POST', url: '/api/session', headers, payload: { token: accessToken } });
    expect(login.statusCode).toBe(200);
    expect(login.headers['set-cookie']).toContain('Secure');
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const authed = { ...headers, cookie };
    const create = await app.inject({ method: 'POST', url: '/api/chats', headers: authed, payload: { title: 'Self-host synthetic story' } });
    expect(create.statusCode).toBe(200);
    expect((await app.inject({ url: '/api/health', headers: authed })).json().mode).toBe('self-host');
    expect((await app.inject({ url: '/api/chats', headers: authed })).json()).toHaveLength(1);
    expect((await app.inject({ url: '/api/test/control', headers: authed })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/api/session', headers: authed })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/chats', headers: authed })).statusCode).toBe(401);
  });
  it('retains same-host local API calls without requiring an Origin header', async () => {
    const app = await fixture(false);
    expect((await app.inject({ method: 'POST', url: '/api/chats', headers: { host: '127.0.0.1' }, payload: { title: 'Local fixture' } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/chats', headers: { host: 'external.test' } })).statusCode).toBe(403);
  });
});
