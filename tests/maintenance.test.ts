import Fastify from 'fastify';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { afterEach, expect, test, vi } from 'vitest';
import { createApp, type App } from '../server/app.js';
import { maintenanceState, setMaintenance, maintenanceRoutes } from '../server/maintenance.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import * as transport from '../core/transport.js';
import { createFixtureChat } from './fixtures/chat.js';

const owned: { app: App; directory: string }[] = [];
afterEach(async () => {
  for (const { app, directory } of owned.splice(0).reverse()) {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function boot(
  options: { maintenance?: boolean; directory?: string; testMode?: boolean } = {}
) {
  const directory =
    options.directory ?? (await mkdtemp(join(await realpath(tmpdir()), 'uimori-maintenance-')));
  const app = await createApp({
    dbPath: join(directory, 'story.sqlite'),
    buildId: 'maintenance-test',
    testMode: options.testMode,
    ...(options.maintenance ? { maintenance: true } : {}),
  });
  owned.push({ app, directory });
  await app.ready();
  return { app, directory };
}

test('a closed gate blocks new writes, keeps reads and cancellation, and survives a restart', async () => {
  const { app, directory } = await boot();
  const chat = createFixtureChat(app.store, 'Maintenance fixture');
  const opened = await app.inject({ method: 'GET', url: '/api/maintenance' });
  expect(opened.json()).toMatchObject({ status: 'open', epoch: 0, forcedClosed: false });
  // The session read carries the same gate, so no screen polls while the app is open.
  expect((await app.inject({ method: 'GET', url: '/api/session' })).json()).toMatchObject({
    maintenance: { status: 'open', epoch: 0, forcedClosed: false },
  });

  const closed = await app.inject({
    method: 'POST',
    url: '/api/maintenance',
    payload: { status: 'closed', reason: 'update' },
  });
  expect(closed.json()).toMatchObject({ status: 'closed', epoch: 1, reason: 'update' });

  expect((await app.inject({ method: 'GET', url: '/api/session' })).json().maintenance).toEqual({
    status: 'closed',
    epoch: 1,
    reason: 'update',
    updatedAt: expect.any(String),
    forcedClosed: false,
  });
  const write = await app.inject({
    method: 'POST',
    url: `/api/chats/${chat.id}/runs`,
    payload: {
      request: 'Blocked while closed.',
      expectedRevision: null,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: 'maintenance-blocked',
    },
  });
  expect(write.statusCode).toBe(503);
  expect(write.json()).toEqual({ error: 'MAINTENANCE_CLOSED' });
  expect(app.store.db.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 0 });

  const read = await app.inject({ method: 'GET', url: `/api/chats/${chat.id}` });
  expect(read.statusCode).toBe(200);
  // Stopping already admitted work stays possible while the gate is closed.
  const cancel = await app.inject({ method: 'POST', url: '/api/runs/missing-run/cancel' });
  expect(cancel.statusCode).not.toBe(503);

  await app.close();
  owned.splice(
    owned.findIndex((item) => item.app === app),
    1
  );
  const reopened = await boot({ directory });
  expect(
    (await reopened.app.inject({ method: 'GET', url: '/api/maintenance' })).json()
  ).toMatchObject({ status: 'closed', epoch: 1 });
  const stillBlocked = await reopened.app.inject({
    method: 'POST',
    url: `/api/chats/${chat.id}/runs`,
    payload: {
      request: 'Still blocked.',
      expectedRevision: null,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: 'maintenance-blocked-2',
    },
  });
  expect(stillBlocked.statusCode).toBe(503);

  const reopenedGate = await reopened.app.inject({
    method: 'POST',
    url: '/api/maintenance',
    payload: { status: 'open' },
  });
  expect(reopenedGate.json()).toMatchObject({ status: 'open', epoch: 1 });
  expect(maintenanceState(reopened.app.store)).toMatchObject({ status: 'open', epoch: 1 });
  const accepted = await reopened.app.inject({
    method: 'POST',
    url: `/api/chats/${chat.id}/runs`,
    payload: {
      request: 'Accepted after reopening.',
      expectedRevision: null,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: 'maintenance-accepted',
    },
  });
  expect(accepted.statusCode).not.toBe(503);
});

test('automatic work queued while admission is closed resumes when it opens', async () => {
  const { app } = await boot({ testMode: true });
  const chat = createFixtureChat(app.store, 'Deferred translation');
  const settings = await app.inject({
    method: 'PATCH',
    url: `/api/chats/${chat.id}/settings`,
    payload: {
      ...chat.settings,
      autoTranslate: true,
      expectedSettingsRevision: chat.settingsRevision,
    },
  });
  expect(settings.statusCode).toBe(200);
  app.controls.hold('run');
  const run = await app.inject({
    method: 'POST',
    url: `/api/chats/${chat.id}/runs`,
    payload: {
      request: 'A synthetic scene.',
      expectedRevision: null,
      expectedSettingsRevision: settings.json().settingsRevision,
      idempotencyKey: 'deferred-translation',
    },
  });
  expect(run.statusCode).toBe(200);
  await until(() => app.controls.snapshot().waiting.run === 1);
  await app.inject({ method: 'POST', url: '/api/maintenance', payload: { status: 'closed' } });
  app.controls.release('run');
  await until(() =>
    Boolean(app.store.db.prepare("SELECT 1 FROM jobs WHERE status='queued'").get())
  );
  expect(app.store.db.prepare("SELECT status FROM jobs WHERE kind='translation'").get()).toEqual({
    status: 'queued',
  });
  await app.inject({ method: 'POST', url: '/api/maintenance', payload: { status: 'open' } });
  await until(() =>
    Boolean(app.store.db.prepare("SELECT 1 FROM jobs WHERE status='completed'").get())
  );
  expect(
    app.store.db.prepare("SELECT count(*) AS n FROM jobs WHERE kind='translation'").get()
  ).toEqual({ n: 1 });
});

test('forced maintenance boot leaves queued context recovery untouched', async () => {
  const { app, directory } = await boot();
  const chat = createFixtureChat(app.store, 'Pending context');
  const now = new Date().toISOString();
  app.store.db
    .prepare(`INSERT INTO context_jobs
    (id,chat_id,request_key,command,status,snapshot,created_at,updated_at)
    VALUES(?,?,?,?,'queued',?,?,?)`)
    .run('pending-context', chat.id, 'pending', '{}', '{"input":"keep"}', now, now);
  await app.close();
  owned.splice(
    owned.findIndex((item) => item.app === app),
    1
  );
  const candidate = await boot({ directory, maintenance: true });
  expect(
    candidate.app.store.db
      .prepare('SELECT status,snapshot FROM context_jobs WHERE id=?')
      .get('pending-context')
  ).toEqual({ status: 'queued', snapshot: '{"input":"keep"}' });
  await candidate.app.close();
  owned.splice(
    owned.findIndex((item) => item.app === candidate.app),
    1
  );
  const normal = await boot({ directory });
  expect(
    normal.app.store.db
      .prepare('SELECT status,snapshot FROM context_jobs WHERE id=?')
      .get('pending-context')
  ).toEqual({ status: 'interrupted', snapshot: null });
});

test('staging cleanup starts on normal listen but never on a forced maintenance boot', async () => {
  const { app, directory } = await boot({ maintenance: true });
  const staged = join(directory, 'risu-prepared', 'a'.repeat(32));
  const upload = join(directory, 'uploads', `${'b'.repeat(32)}.bin`);
  await mkdir(staged, { recursive: true });
  await mkdir(join(directory, 'uploads'), { recursive: true });
  await writeFile(upload, 'expired upload');
  const expired = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await utimes(staged, expired, expired);
  await utimes(upload, expired, expired);
  await app.listen({ host: '127.0.0.1', port: 0 });
  expect(existsSync(staged)).toBe(true);
  expect(existsSync(upload)).toBe(true);
  setMaintenance(app.store, { closed: true, reason: 'update' });
  await app.close();
  owned.splice(
    owned.findIndex((item) => item.app === app),
    1
  );
  const closed = await boot({ directory, testMode: true });
  await closed.app.listen({ host: '127.0.0.1', port: 0 });
  expect(existsSync(staged)).toBe(true);
  expect(existsSync(upload)).toBe(true);
  await closed.app.inject({ method: 'POST', url: '/api/maintenance', payload: { status: 'open' } });
  await closed.app.close();
  owned.splice(
    owned.findIndex((item) => item.app === closed.app),
    1
  );
  const normal = await boot({ directory, testMode: true });
  await normal.app.listen({ host: '127.0.0.1', port: 0 });
  expect(existsSync(staged)).toBe(false);
  expect(existsSync(upload)).toBe(false);
});

test('a persisted closed gate holds recovered Batch execution until reopening', async () => {
  const { app, directory } = await boot({ testMode: true });
  const chat = createFixtureChat(app.store, 'Batch recovery');
  const profile = app.store.product.snapshot(chat.id);
  const run = app.store.createRun(
    chat.id,
    {
      request: 'Resume the scene',
      expectedRevision: null,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: 'batch-recovery',
    },
    () => ({
      chatId: chat.id,
      parentRevision: null,
      settingsRevision: chat.settingsRevision,
      settings: chat.settings,
      request: 'Resume the scene',
      history: [],
      resources: app.store.product.resources(chat.id, profile),
      profile,
    })
  ).run;
  app.store.startRun(run.id);
  const attempt = app.store.product.startAttempt(chat.id, run.id, null, {
    connectionId: 'anthropic',
    protocol: 'anthropic-messages-v1',
    role: 'main',
    modelId: 'fixture',
    method: 'POST',
    url: 'https://example.test/v1/messages/batches',
    headers: {},
    body: {},
    bodySha256: 'batch-request',
    stablePrefixSha256: 'stable',
    executionMode: 'batch',
  });
  const now = new Date().toISOString();
  app.store.db
    .prepare(`INSERT INTO anthropic_batches
    (attempt_id,run_id,ordinal,batch_id,custom_id,request_sha256,status,created_at,updated_at)
    VALUES(?,?,0,?,?,?,'in_progress',?,?)`)
    .run(attempt, run.id, 'batch-1', attempt, 'batch-request', now, now);
  setMaintenance(app.store, { closed: true, reason: 'restart' });
  await app.close();
  owned.splice(
    owned.findIndex((item) => item.app === app),
    1
  );

  const restarted = await boot({ directory, testMode: true });
  restarted.app.controls.hold('run');
  await restarted.app.listen({ host: '127.0.0.1', port: 0 });
  expect(restarted.app.store.run(run.id).status).toBe('queued');
  expect((await restarted.app.inject('/api/maintenance')).json().activeWork).toBe(0);
  await restarted.app.inject({
    method: 'POST',
    url: '/api/maintenance',
    payload: { status: 'open' },
  });
  await until(() => restarted.app.controls.snapshot().waiting.run === 1);
  expect(restarted.app.store.run(run.id).status).toBe('running');
  expect(
    restarted.app.store.db
      .prepare('SELECT count(*) AS n FROM anthropic_batches WHERE run_id=?')
      .get(run.id)
  ).toEqual({ n: 1 });
  restarted.app.controls.release('run');
});

test('queued helper work remains stopped while closed and resumes once on open', async () => {
  const { app } = await boot({ testMode: true });
  const connection = app.store.product.connection({
    title: 'Fixture',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = app.store.product.model({
    title: 'Fixture',
    connectionId: connection.id,
    modelId: 'fixture',
    maxOutputTokens: 1024,
    temperature: null,
  });
  const workspace = modelWorkspace(app.store);
  updateModelWorkspace(app.store, {
    expectedRevision: workspace.revision,
    routes: workspace.routes,
    translationPolicy: workspace.translationPolicy,
    helperModel: { id: model.id },
  });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const send = vi
    .spyOn(transport, 'executeProvider')
    .mockImplementation(async (connection, request, options) => {
      await options.beforeTurn?.();
      await options.onWire?.({
        connectionId: connection.id,
        protocol: connection.protocol,
        role: request.role,
        modelId: request.modelId,
        method: 'POST',
        url: connection.endpoint,
        headers: {},
        body: {},
        bodySha256: 'synthetic',
        stablePrefixSha256: 'synthetic',
      });
      await pending;
      return {
        status: 'completed',
        text: 'Done',
        toolCalls: [],
        refusal: null,
        error: null,
        usage: { inputTokens: 1, outputTokens: 1, costUsd: null, raw: null, priceRevision: null },
        opaqueState: null,
      };
    });
  try {
    const tasks: string[] = [];
    for (const index of [1, 2, 3]) {
      const conversation = await app.inject({
        method: 'POST',
        url: '/api/helper/conversations',
        payload: { scope: { kind: 'library', workId: `deferred-${index}` } },
      });
      expect(conversation.statusCode).toBe(200);
      const task = await app.inject({
        method: 'POST',
        url: `/api/helper/conversations/${conversation.json().id}/messages`,
        payload: { requestKey: `task-${index}`, text: 'Synthetic request' },
      });
      expect(task.statusCode).toBe(200);
      tasks.push(task.json().id);
    }
    await until(() => send.mock.calls.length === 2);
    expect(
      app.store.db.prepare('SELECT status FROM helper_tasks WHERE id=?').get(tasks[2])
    ).toEqual({ status: 'queued' });
    await app.inject({ method: 'POST', url: '/api/maintenance', payload: { status: 'closed' } });
    release();
    await until(
      () =>
        Number(
          app.store.db
            .prepare("SELECT count(*) AS n FROM helper_tasks WHERE status='running'")
            .get()?.n
        ) === 0
    );
    expect(send).toHaveBeenCalledTimes(2);
    expect(
      app.store.db.prepare('SELECT status FROM helper_tasks WHERE id=?').get(tasks[2])
    ).toEqual({ status: 'queued' });
    await app.inject({ method: 'POST', url: '/api/maintenance', payload: { status: 'open' } });
    await until(() => send.mock.calls.length === 3);
    await until(
      () =>
        app.store.db.prepare('SELECT status FROM helper_tasks WHERE id=?').get(tasks[2])?.status ===
        'completed'
    );
    expect(send).toHaveBeenCalledTimes(3);
  } finally {
    release();
    send.mockRestore();
  }
});

async function until(condition: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for background work');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('repeating the same gate change keeps one epoch and a forced maintenance boot rejects reopening through HTTP', async () => {
  const { app, directory } = await boot();
  setMaintenance(app.store, { closed: true, reason: 'first' });
  setMaintenance(app.store, { closed: true, reason: 'second' });
  expect(maintenanceState(app.store)).toMatchObject({
    status: 'closed',
    epoch: 1,
    reason: 'first',
  });
  setMaintenance(app.store, { closed: false });
  setMaintenance(app.store, { closed: true });
  expect(maintenanceState(app.store)).toMatchObject({ status: 'closed', epoch: 2 });
  await app.close();
  owned.splice(
    owned.findIndex((item) => item.app === app),
    1
  );

  const candidate = await boot({ directory, maintenance: true });
  // A candidate boot proves current schema admission and reads; its gate is not a user setting.
  setMaintenance(candidate.app.store, { closed: false });
  const status = await candidate.app.inject({ method: 'GET', url: '/api/maintenance' });
  expect(status.json()).toMatchObject({ status: 'closed', forcedClosed: true });
  const reopen = await candidate.app.inject({
    method: 'POST',
    url: '/api/maintenance',
    payload: { status: 'open' },
  });
  expect(reopen.statusCode).toBe(409);
  expect(reopen.json()).toEqual({ error: 'MAINTENANCE_BOOT' });
});

test('closing admission waits for previously admitted HTTP writes and releases failed writes', async () => {
  const { app } = await boot();
  const http = Fastify();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  http.post('/slow-write', async () => {
    entered();
    await barrier;
    return { saved: true };
  });
  http.post('/failed-write', async () => {
    throw new Error('synthetic write failed');
  });
  maintenanceRoutes(http, app.store, { forcedClosed: false, activeWork: () => 0 });
  const pending = http.inject({ method: 'POST', url: '/slow-write' }).then((response) => response);
  await started;
  try {
    const closed = await http.inject({
      method: 'POST',
      url: '/api/maintenance',
      payload: { status: 'closed', reason: 'oracle:test' },
    });
    expect(closed.json()).toMatchObject({ status: 'closed', activeWork: 1 });
    expect((await http.inject({ method: 'POST', url: '/slow-write' })).statusCode).toBe(503);
    release();
    await pending;
    expect((await http.inject('/api/maintenance')).json().activeWork).toBe(0);
    await http.inject({ method: 'POST', url: '/api/maintenance', payload: { status: 'open' } });
    expect((await http.inject({ method: 'POST', url: '/failed-write' })).statusCode).toBe(500);
    expect((await http.inject('/api/maintenance')).json().activeWork).toBe(0);
  } finally {
    release();
    await pending;
    await http.close();
  }
});
