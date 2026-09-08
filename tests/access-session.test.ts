import { injectWithFixtureBot } from './fixtures/chat.js';
import { afterEach, expect, test, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { AccessSessions } from '../server/access-session.js';
import { createApp } from '../server/app.js';
import { productRoutes } from '../server/product-routes.js';
import { Store } from '../server/store.js';

const accessToken = 'synthetic-selfhost-token-0123456789abcdef';
const publicOrigin = 'https://uimori.example.test';
const cookieHeader = (setCookie: string) => setCookie.split(';')[0];
const owned: { app: FastifyInstance; store?: Store; dir: string }[] = [];
afterEach(async () => {
  for (const { app, store, dir } of owned.splice(0)) {
    await app.close();
    store?.close();
    const inside = relative(resolve(tmpdir()), resolve(dir));
    if (
      isAbsolute(inside) ||
      inside.startsWith('..') ||
      !inside.startsWith('uimori-access-session-')
    )
      throw Error('Unsafe test cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(options: { accessToken?: string; publicOrigin?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-access-session-'));
  const app = Fastify(),
    store = new Store(join(dir, 'test.sqlite')),
    onAuthChanged = vi.fn();
  owned.push({ app, store, dir });
  const session = productRoutes(app, store, {
    ...options,
    approvedOrigins: [],
    publish: () => {},
    onAuthChanged,
  });
  return { app, onAuthChanged, session };
}

test('local access stays optional and configured local tokens use the existing HTTP cookie', () => {
  const open = new AccessSessions({});
  expect(open.required).toBe(false);
  expect(open.authenticated()).toBe(true);
  const local = new AccessSessions({ accessToken: 'local-token' });
  expect(local.required).toBe(true);
  expect(local.authenticated()).toBe(false);
  const { cookie } = local.login('local-token');
  expect(cookie).toMatch(
    /^nr_session=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200$/u
  );
  expect(local.authenticated(cookieHeader(cookie))).toBe(true);
  expect(local.logout(cookieHeader(cookie))).toBe(
    'nr_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'
  );
  expect(local.authenticated(cookieHeader(cookie))).toBe(false);
});

test('remote access rejects absent or weak configuration without repeating the configured value', () => {
  for (const token of [undefined, '', 'short-secret-value', `${accessToken}\n`]) {
    try {
      new AccessSessions({ publicOrigin, accessToken: token });
      throw Error('Expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('Remote access requires');
      if (token) expect((error as Error).message).not.toContain(token);
    }
  }
});

test('remote login uses fresh independent secure sessions and logout revokes only its session', () => {
  const sessions = new AccessSessions({ accessToken, publicOrigin });
  const first = sessions.login(accessToken),
    second = sessions.login(accessToken);
  expect(first.cookie).toMatch(
    /^nr_session=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200; Secure$/u
  );
  expect(first.cookie).not.toContain(accessToken);
  expect(first.cookie).not.toBe(second.cookie);
  expect(sessions.authenticated(cookieHeader(first.cookie))).toBe(true);
  expect(sessions.logout(cookieHeader(first.cookie))).toBe(
    'nr_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure'
  );
  expect(sessions.authenticated(cookieHeader(first.cookie))).toBe(false);
  expect(sessions.authenticated(cookieHeader(second.cookie))).toBe(true);
  expect(
    new AccessSessions({ accessToken, publicOrigin }).authenticated(cookieHeader(second.cookie))
  ).toBe(false);
});

test('session expiry is absolute at 12 hours and requests do not extend it', () => {
  let now = 1000;
  const sessions = new AccessSessions({ accessToken, publicOrigin, now: () => now });
  const first = cookieHeader(sessions.login(accessToken).cookie);
  now += 12 * 60 * 60 * 1000 - 1;
  expect(sessions.authenticated(first)).toBe(true);
  const second = cookieHeader(sessions.login(accessToken).cookie);
  now++;
  expect(sessions.authenticated(first)).toBe(false);
  expect(sessions.authenticated(second)).toBe(true);
});

test('session count is bounded to 32 and replacing the oldest session reports revocation', () => {
  const sessions = new AccessSessions({ accessToken, publicOrigin });
  const cookies = Array.from({ length: 32 }, () => {
    const result = sessions.login(accessToken);
    expect(result.revoked).toBe(false);
    return cookieHeader(result.cookie);
  });
  const replacement = sessions.login(accessToken);
  expect(replacement.revoked).toBe(true);
  expect(sessions.authenticated(cookies[0])).toBe(false);
  for (const cookie of cookies.slice(1)) expect(sessions.authenticated(cookie)).toBe(true);
  expect(sessions.authenticated(cookieHeader(replacement.cookie))).toBe(true);
});

test('expired sessions are removed before capacity eviction', () => {
  let now = 1000;
  const sessions = new AccessSessions({ accessToken, publicOrigin, now: () => now });
  for (let i = 0; i < 32; i++) sessions.login(accessToken);
  now += 12 * 60 * 60 * 1000;
  expect(sessions.login(accessToken).revoked).toBe(false);
});

test('unknown, malformed, ambiguous and non-session cookies never authenticate', () => {
  const sessions = new AccessSessions({ accessToken, publicOrigin });
  const valid = cookieHeader(sessions.login(accessToken).cookie);
  for (const cookie of [
    undefined,
    '',
    'nr_session=invalid',
    `other_${valid}`,
    `${valid}; ${valid}`,
    `nr_session=${'0'.repeat(64)}`,
    `${valid}extra`,
  ])
    expect(sessions.authenticated(cookie)).toBe(false);
  expect(sessions.authenticated(`theme=dark; ${valid}; another=value`)).toBe(true);
});

test('remote failures throttle the whole workspace after ten attempts until the 15 minute window ends', () => {
  let now = 1000;
  const sessions = new AccessSessions({ accessToken, publicOrigin, now: () => now });
  const established = cookieHeader(sessions.login(accessToken).cookie);
  for (let i = 0; i < 10; i++)
    expect(() => sessions.login(`wrong-secret-${i}`)).toThrow(
      expect.objectContaining({ statusCode: 401, message: 'Invalid access token' })
    );
  expect(() => sessions.login(accessToken)).toThrow(
    expect.objectContaining({ statusCode: 429, retryAfterSeconds: 900 })
  );
  expect(sessions.authenticated(established)).toBe(true);
  now += 899_001;
  expect(() => sessions.login('another-secret')).toThrow(
    expect.objectContaining({ statusCode: 429, retryAfterSeconds: 1 })
  );
  now += 999;
  expect(sessions.login(accessToken).cookie).toContain('; Secure');
});

test('a successful remote login resets prior failures and local mode does not throttle', () => {
  const remote = new AccessSessions({ accessToken, publicOrigin });
  for (let cycle = 0; cycle < 2; cycle++) {
    for (let i = 0; i < 9; i++)
      expect(() => remote.login('wrong')).toThrow(expect.objectContaining({ statusCode: 401 }));
    expect(remote.login(accessToken).cookie).toContain('; Secure');
  }
  const local = new AccessSessions({ accessToken });
  for (let i = 0; i < 20; i++)
    expect(() => local.login('wrong')).toThrow(expect.objectContaining({ statusCode: 401 }));
  expect(local.login(accessToken).cookie).not.toContain('; Secure');
});

test('session routes preserve optional local access and do not cache authentication state', async () => {
  const { app } = fixture();
  const status = await injectWithFixtureBot(app, { method: 'GET', url: '/api/session' });
  expect(status.json()).toEqual({ required: false, authenticated: true });
  expect(status.headers['cache-control']).toBe('no-store');
  expect((await injectWithFixtureBot(app, { method: 'GET', url: '/api/library' })).statusCode).toBe(
    200
  );
  const logout = await injectWithFixtureBot(app, { method: 'DELETE', url: '/api/session' });
  expect(logout.json()).toEqual({ required: false, authenticated: true });
  expect(logout.headers['set-cookie']).not.toContain('; Secure');
});

test('remote session routes protect API resources, revoke logout and emit matching secure cookie attributes', async () => {
  const { app, onAuthChanged, session } = fixture({ accessToken, publicOrigin });
  expect((await injectWithFixtureBot(app, { method: 'GET', url: '/api/session' })).json()).toEqual({
    required: true,
    authenticated: false,
  });
  expect((await injectWithFixtureBot(app, { method: 'GET', url: '/api/library' })).statusCode).toBe(
    401
  );
  const login = await injectWithFixtureBot(app, {
    method: 'POST',
    url: '/api/session',
    payload: { token: accessToken },
  });
  expect(login.statusCode).toBe(200);
  expect(login.json()).toEqual({ required: true, authenticated: true });
  expect(login.headers['cache-control']).toBe('no-store');
  expect(login.headers['set-cookie']).toContain('; Secure');
  expect(login.body).not.toContain(accessToken);
  const cookie = cookieHeader(login.headers['set-cookie'] as string);
  expect(
    (await injectWithFixtureBot(app, { method: 'GET', url: '/api/library', headers: { cookie } }))
      .statusCode
  ).toBe(200);
  expect(
    (
      await injectWithFixtureBot(app, { method: 'GET', url: '/api/session', headers: { cookie } })
    ).json()
  ).toEqual({ required: true, authenticated: true });
  const logout = await injectWithFixtureBot(app, {
    method: 'DELETE',
    url: '/api/session',
    headers: { cookie },
  });
  expect(logout.json()).toEqual({ required: true, authenticated: false });
  expect(logout.headers['set-cookie']).toBe(
    'nr_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure'
  );
  expect(onAuthChanged).toHaveBeenCalledOnce();
  expect(session.authenticated(cookie)).toBe(false);
  expect(
    (await injectWithFixtureBot(app, { method: 'GET', url: '/api/library', headers: { cookie } }))
      .statusCode
  ).toBe(401);
});

test('remote route throttling ignores spoofed forwarded IPs, sets Retry-After and never echoes tokens', async () => {
  const { app } = fixture({ accessToken, publicOrigin });
  for (let i = 0; i < 10; i++) {
    const secret = `attempt-secret-${i}`;
    const response = await injectWithFixtureBot(app, {
      method: 'POST',
      url: '/api/session',
      headers: { 'x-forwarded-for': `192.0.2.${i + 1}` },
      payload: { token: secret },
    });
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain(secret);
    expect(response.body).not.toContain(accessToken);
    expect(response.headers['set-cookie']).toBeUndefined();
  }
  const blocked = await injectWithFixtureBot(app, {
    method: 'POST',
    url: '/api/session',
    headers: { 'x-forwarded-for': '198.51.100.10' },
    payload: { token: accessToken },
  });
  expect(blocked.statusCode).toBe(429);
  expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(900);
  expect(blocked.headers['set-cookie']).toBeUndefined();
  expect(blocked.body).not.toContain(accessToken);
  const malformed = await injectWithFixtureBot(app, {
    method: 'POST',
    url: '/api/session',
    payload: { unexpected: 'private-value' },
  });
  expect(malformed.statusCode).toBe(429);
  expect(malformed.body).not.toContain('private-value');
});

test('capacity eviction invokes the existing revocation notification used by active streams', async () => {
  const { app, onAuthChanged, session } = fixture({ accessToken, publicOrigin });
  let first = '';
  for (let i = 0; i < 33; i++) {
    const response = await injectWithFixtureBot(app, {
      method: 'POST',
      url: '/api/session',
      payload: { token: accessToken },
    });
    expect(response.statusCode).toBe(200);
    if (!i) first = cookieHeader(response.headers['set-cookie'] as string);
  }
  expect(onAuthChanged).toHaveBeenCalledOnce();
  expect(session.authenticated(first)).toBe(false);
});

test.each([false, true])(
  'matched API routes require authentication even with encoded request paths (remote=%s)',
  async (remote) => {
    const dir = mkdtempSync(join(tmpdir(), 'uimori-access-session-'));
    const app = await createApp({
      dbPath: join(dir, 'test.sqlite'),
      buildId: 'access-path-synthetic',
      accessToken,
      ...(remote ? { publicOrigin } : {}),
    });
    owned.push({ app, dir });
    const origin = remote ? publicOrigin : 'http://localhost';
    const headers = { host: new URL(origin).host, origin };
    const paths = [
      '/api/library',
      '/api/export',
      '/api/backup',
      '/api/import/status',
      '/api/assets/private-asset',
      '/api/chats/private-chat/reader',
    ];
    for (const path of paths) {
      for (const prefix of ['/api/', '/%61pi/', '/a%70i/', '/ap%69/']) {
        const url = path.replace('/api/', prefix);
        const response = await injectWithFixtureBot(app, { method: 'GET', url, headers });
        expect(response.statusCode, url).toBe(401);
        expect(response.json()).toEqual({ error: 'Authentication required' });
      }
      expect(
        (await injectWithFixtureBot(app, { method: 'GET', url: origin + path, headers }))
          .statusCode,
        path
      ).toBe(401);
    }
    expect(
      (await injectWithFixtureBot(app, { method: 'GET', url: '/api/not-a-route', headers }))
        .statusCode
    ).toBe(401);
    const session = await injectWithFixtureBot(app, {
      method: 'GET',
      url: '/%61pi/%73ession',
      headers,
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toEqual({ required: true, authenticated: false });
    const login = await injectWithFixtureBot(app, {
      method: 'POST',
      url: '/api/session',
      headers,
      payload: { token: accessToken },
    });
    expect(login.statusCode).toBe(200);
    const cookie = cookieHeader(login.headers['set-cookie'] as string);
    for (const path of ['/%61pi/library', '/%61pi/export'])
      expect(
        (
          await injectWithFixtureBot(app, {
            method: 'GET',
            url: path,
            headers: { ...headers, cookie },
          })
        ).statusCode
      ).toBe(200);
  }
);
