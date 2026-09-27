import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { AccessSessions } from '../server/access-session.js';
import { PushService } from '../server/push-service.js';
import { createApp, type App } from '../server/app.js';
import { DEFAULT_PUSH_PREFERENCES, type PushEnvelope } from '../core/push.js';
import type { PushSender } from '../server/push-transport.js';
import { createFixtureChat } from './fixtures/chat.js';
import { completedSource } from './fixtures/illustration.js';

const origin = 'https://story.example.test';
const accessToken = 'synthetic-push-access-key-32-characters';
const stores: Store[] = [],
  services: PushService[] = [],
  directories: string[] = [],
  apps: App[] = [];
function subscription(suffix = randomUUID()) {
  const key = createECDH('prime256v1');
  key.generateKeys();
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${suffix}`,
    keys: {
      p256dh: key.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
}
function fixture(sender?: PushSender) {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-push-'));
  directories.push(directory);
  const store = new Store(join(directory, 'app.sqlite'));
  stores.push(store);
  const sessions = new AccessSessions(store.db, { accessToken, publicOrigin: origin });
  const cookie = sessions.login(accessToken).cookie,
    clientId = randomUUID();
  let time = Date.now();
  const delivered: PushEnvelope[] = [];
  const service = new PushService(store, {
    origin,
    sessionHash: (value) => sessions.sessionHash(value),
    canSend: () => true,
    now: () => Math.max(time, Date.now()),
    sender:
      sender ??
      (async (_subscription, envelope) => {
        delivered.push(envelope);
        return { status: 201 };
      }),
  });
  services.push(service);
  return {
    store,
    service,
    sessions,
    cookie,
    clientId,
    delivered,
    now: () => Math.max(time, Date.now()),
    advance: (value: number) => {
      time = Math.max(time, Date.now()) + value;
    },
  };
}
function enable(f: ReturnType<typeof fixture>) {
  f.service.prepare(f.clientId, f.cookie);
  return f.service.subscribe(
    {
      clientId: f.clientId,
      expectedRevision: 0,
      subscription: subscription(),
      preferences: DEFAULT_PUSH_PREFERENCES,
    },
    f.cookie
  );
}
function start(store: Store, chatId: string) {
  const chat = store.chat(chatId),
    profile = store.product.snapshot(chatId);
  const run = store.createRun(
    chatId,
    {
      request: 'Synthetic actual-write request',
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (selected) => ({
      chatId,
      parentRevision: selected.headRevision,
      settingsRevision: selected.settingsRevision,
      settings: { ...selected.settings, status: false },
      request: 'Synthetic actual-write request',
      history: store.history(selected.headRevision),
      profile,
      resources: store.product.resources(chatId, profile),
    })
  ).run;
  store.startRun(run.id);
  return run;
}
function complete(store: Store, chatId: string) {
  const run = start(store, chatId);
  // A local, deterministic receipt stands in for a completed provider call; never contacts a model.
  const id = store.product.startAttempt(chatId, run.id, null, {
    connectionId: 'synthetic-provider',
    modelId: 'synthetic-model',
    role: 'main',
    protocol: 'openai-chat-v1',
    method: 'POST',
    url: 'https://provider.invalid',
    headers: {},
    body: {},
    bodySha256: 'synthetic',
    stablePrefixSha256: 'synthetic',
  });
  store.product.finishAttempt(id, {
    status: 'completed',
    text: 'SECRET_PROSE_CANARY',
    toolCalls: [],
    refusal: null,
    error: null,
    opaqueState: null,
    usage: { inputTokens: 1, outputTokens: 1, costUsd: null, priceRevision: null, raw: null },
  });
  return store.source(
    store.completeRun(
      run.id,
      'SECRET_PROSE_CANARY',
      { modelCalls: 1, inputTokens: 1, outputTokens: 1, costUsd: null },
      run.snapshot.settings
    ).id
  );
}
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const app of apps.splice(0)) await app.close();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test('opt-in has no historical replay, body completion queues atomically once, and default payload hides titles and prose', async () => {
  const f = fixture();
  const chat = createFixtureChat(f.store, 'SECRET_CHAT_TITLE');
  const historical = complete(f.store, chat.id);
  expect(f.service.info(f.clientId, f.cookie)).toMatchObject({
    available: true,
    publicKey: null,
    device: null,
  });
  expect(f.store.db.prepare('SELECT count(*) AS n FROM push_outbox').get()!.n).toBe(0);
  const enabled = enable(f);
  expect(enabled).toMatchObject({ device: { revision: 1, preferences: DEFAULT_PUSH_PREFERENCES } });
  await f.service.tick();
  expect(f.delivered).toEqual([]);
  const source = complete(f.store, chat.id);
  f.store.event(chat.id, 'run.completed', source.runId);
  expect(f.store.db.prepare('SELECT count(*) AS n FROM push_outbox').get()!.n).toBe(1);
  await f.service.tick();
  await f.service.tick();
  expect(f.delivered).toHaveLength(1);
  expect(f.delivered[0]).toMatchObject({
    kind: 'main-completed',
    chatId: chat.id,
    sourceId: source.id,
    representation: 'original',
  });
  expect(JSON.stringify(f.delivered)).not.toMatch(/SECRET_CHAT_TITLE|SECRET_PROSE_CANARY/);
  expect(f.store.source(historical.id).text).toBe('SECRET_PROSE_CANARY');
  const visible = JSON.stringify(f.service.info(f.clientId, f.cookie));
  expect(visible).not.toMatch(/privateKey|endpoint|p256dh|auth|fcm\/send/);
  expect(f.store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

test('a failed source transaction rolls back notifications and cancelled/manual/scripted work is not advertised as model completion', async () => {
  const f = fixture();
  enable(f);
  const chat = createFixtureChat(f.store, 'Atomic');
  expect(() =>
    f.store.transaction(() => {
      complete(f.store, chat.id);
      throw new Error('synthetic rollback');
    })
  ).toThrow();
  expect(f.store.db.prepare('SELECT count(*) AS n FROM push_outbox').get()!.n).toBe(0);
  const scripted = completedSource(f.store, chat.id, 'A scripted source');
  f.service.update(
    {
      clientId: f.clientId,
      expectedRevision: 1,
      preferences: { ...DEFAULT_PUSH_PREFERENCES, translation: true },
    },
    f.cookie
  );
  f.store.editTranslation(scripted.id, {
    expectedRevision: 0,
    expectedSourceHash: scripted.hash,
    text: '직접 저장한 번역',
  });
  const cancelled = start(f.store, chat.id);
  f.store.finishRun(cancelled.id, 'cancelled', 'User stopped');
  await f.service.tick();
  expect(f.delivered).toEqual([]);
  const failed = start(f.store, chat.id);
  f.store.finishRun(failed.id, 'failed', 'SECRET_ERROR_CANARY');
  await f.service.tick();
  expect(f.delivered).toHaveLength(1);
  expect(f.delivered[0].kind).toBe('task-failed');
  expect(JSON.stringify(f.delivered)).not.toContain('SECRET_ERROR_CANARY');
});

test('current preferences apply before dispatch, titles are explicit, and stale or other-session updates fail', async () => {
  const f = fixture();
  enable(f);
  const chat = createFixtureChat(f.store, 'Optional title');
  complete(f.store, chat.id);
  const off = f.service.update(
    {
      clientId: f.clientId,
      expectedRevision: 1,
      preferences: { ...DEFAULT_PUSH_PREFERENCES, main: false },
    },
    f.cookie
  );
  await f.service.tick();
  expect(f.delivered).toEqual([]);
  expect(() =>
    f.service.update(
      { clientId: f.clientId, expectedRevision: 1, preferences: DEFAULT_PUSH_PREFERENCES },
      f.cookie
    )
  ).toThrow('PUSH_SETTINGS_CHANGED');
  const other = f.sessions.login(accessToken).cookie;
  expect(f.service.info(f.clientId, other).device).toBeNull();
  expect(() =>
    f.service.update(
      { clientId: f.clientId, expectedRevision: 2, preferences: DEFAULT_PUSH_PREFERENCES },
      other
    )
  ).toThrow();
  f.service.update(
    {
      clientId: f.clientId,
      expectedRevision: off.device!.revision,
      preferences: { ...DEFAULT_PUSH_PREFERENCES, showTitle: true },
    },
    f.cookie
  );
  complete(f.store, chat.id);
  await f.service.tick();
  expect(f.delivered[0].title).toBe('Optional title');
});

test('transient failures retry the same event a bounded number, while expiration and permanent endpoint removal do not restart a model', async () => {
  let requests = 0;
  const f = fixture(async () => {
    requests++;
    return { status: requests < 3 ? 503 : 201 };
  });
  enable(f);
  f.service.test(f.clientId, f.cookie);
  await f.service.tick();
  await f.service.tick();
  expect(requests).toBe(1);
  f.advance(31_000);
  await f.service.tick();
  expect(requests).toBe(2);
  // Test notifications have short TTL; they expire rather than arriving stale much later.
  f.advance(121_000);
  await f.service.tick();
  expect(requests).toBe(2);
  expect(f.store.db.prepare('SELECT status FROM push_outbox').get()!.status).toBe('failed');
  f.service.test(f.clientId, f.cookie);
  await f.service.tick();
  expect(requests).toBe(3);
  expect(f.store.db.prepare('SELECT count(*) AS n FROM runs').get()!.n).toBe(0);
  const gone = fixture(async () => ({ status: 410 }));
  enable(gone);
  gone.service.test(gone.clientId, gone.cookie);
  await gone.service.tick();
  expect(gone.service.info(gone.clientId, gone.cookie).device).toBeNull();
  expect(gone.store.db.prepare('SELECT count(*) AS n FROM push_outbox').get()!.n).toBe(0);
});

test('logout and access-token changes revoke queued and in-flight subscription authority', async () => {
  let entered = false,
    aborted = false;
  const f = fixture(async (_subscription, _envelope, _keys, _origin, _ttl, signal) => {
    entered = true;
    return new Promise((_resolve, reject) =>
      signal.addEventListener(
        'abort',
        () => {
          aborted = true;
          reject(new Error('cancelled'));
        },
        { once: true }
      )
    );
  });
  enable(f);
  f.service.test(f.clientId, f.cookie);
  const delivery = f.service.tick();
  expect(entered).toBe(true);
  f.sessions.logout(f.cookie);
  f.service.revokeInactive();
  await delivery;
  expect(aborted).toBe(true);
  expect(f.store.db.prepare('SELECT count(*) AS n FROM push_subscriptions').get()!.n).toBe(0);
  expect(() => f.service.test(f.clientId, f.cookie)).toThrow();
  const other = fixture();
  enable(other);
  other.service.test(other.clientId, other.cookie);
  new AccessSessions(other.store.db, {
    accessToken: 'changed-secret-access-token',
    publicOrigin: origin,
  });
  await other.service.tick();
  expect(other.delivered).toEqual([]);
  expect(other.store.db.prepare('SELECT count(*) AS n FROM push_outbox').get()!.n).toBe(0);
});

test('restart retries only durable unsent intent; changed server origins remove old delivery capabilities', async () => {
  const f = fixture();
  enable(f);
  const chat = createFixtureChat(f.store, 'Restart');
  complete(f.store, chat.id);
  f.store.db.prepare("UPDATE push_outbox SET status='sending',attempts=1").run();
  await f.service.close();
  const delivered: PushEnvelope[] = [];
  const restart = new PushService(f.store, {
    origin,
    sessionHash: (cookie) => f.sessions.sessionHash(cookie),
    canSend: () => true,
    sender: async (_sub, payload) => {
      delivered.push(payload);
      return { status: 201 };
    },
  });
  services.push(restart);
  restart.listen();
  await restart.tick();
  await restart.tick();
  expect(delivered).toHaveLength(1);
  await restart.close();
  const moved = new PushService(f.store, {
    origin: 'https://different.example.test',
    sessionHash: (cookie) => f.sessions.sessionHash(cookie),
    canSend: () => true,
    sender: async () => {
      throw new Error('Must not send after moving origin');
    },
  });
  services.push(moved);
  moved.listen();
  await moved.tick();
  expect(f.store.db.prepare('SELECT count(*) AS n FROM push_subscriptions').get()!.n).toBe(0);
});

test('public HTTP routes reuse authenticated sessions and maintenance; private keys and endpoint capabilities never appear in reads', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-push-http-'));
  directories.push(directory);
  const app = await createApp({
    dbPath: join(directory, 'app.sqlite'),
    buildId: 'synthetic-push',
    accessToken,
    publicOrigin: origin,
    pushSender: async () => ({ status: 201 }),
  });
  apps.push(app);
  const clientId = randomUUID();
  const headers = { host: 'story.example.test', origin };
  expect(
    (await app.inject({ method: 'GET', url: `/api/push?clientId=${clientId}`, headers })).statusCode
  ).toBe(401);
  const logged = await app.inject({
    method: 'POST',
    url: '/api/session',
    headers,
    payload: { token: accessToken },
  });
  expect(logged.statusCode, logged.body).toBe(200);
  const cookie = String(logged.headers['set-cookie']);
  const authenticated = { ...headers, cookie };
  const prepared = await app.inject({
    method: 'POST',
    url: '/api/push/prepare',
    headers: authenticated,
    payload: { clientId },
  });
  expect(prepared.statusCode, prepared.body).toBe(200);
  expect(prepared.body).not.toContain('privateKey');
  const enabled = await app.inject({
    method: 'POST',
    url: '/api/push/subscription',
    headers: authenticated,
    payload: {
      clientId,
      expectedRevision: 0,
      subscription: subscription(),
      preferences: DEFAULT_PUSH_PREFERENCES,
    },
  });
  expect(enabled.statusCode, enabled.body).toBe(200);
  expect(enabled.body).not.toContain('fcm.googleapis.com');
  const testResponse = await app.inject({
    method: 'POST',
    url: '/api/push/test',
    headers: authenticated,
    payload: { clientId },
  });
  expect(testResponse.statusCode).toBe(202);
  await app.inject({
    method: 'POST',
    url: '/api/maintenance',
    headers: authenticated,
    payload: { status: 'closed', reason: 'update' },
  });
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/push/test',
        headers: authenticated,
        payload: { clientId },
      })
    ).statusCode
  ).toBe(503);
  expect(
    (
      await app.inject({
        method: 'GET',
        url: `/api/push?clientId=${clientId}`,
        headers: authenticated,
      })
    ).statusCode
  ).toBe(200);
  await app.inject({ method: 'DELETE', url: '/api/session', headers: authenticated });
  expect(app.store.db.prepare('SELECT count(*) AS n FROM push_subscriptions').get()!.n).toBe(0);
});
