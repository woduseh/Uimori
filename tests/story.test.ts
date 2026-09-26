import { createFixtureChat, injectWithFixtureBot } from './fixtures/chat.js';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { Controls } from '../server/controls.js';
import { createApp, type App } from '../server/app.js';
import type { RunSnapshot, Run } from '../core/types.js';

const owned: { directory: string; store?: Store; app?: App }[] = [];
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('Paid and external calls forbidden in M2 story integration tests')
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const item of owned.splice(0).reverse()) {
    if (item.app) await item.app.close();
    else item.store?.close();
    const target = resolve(item.directory);
    const within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('Uimori M2 story ')
    )
      throw new Error('Refusing cleanup outside owned synthetic test directory');
    await rm(target, { recursive: true, force: true });
  }
});
async function database() {
  const directory = await mkdtemp(join(tmpdir(), 'Uimori M2 story '));
  const store = new Store(join(directory, 'story.sqlite'));
  const item = { directory, store };
  owned.push(item);
  return { store, item };
}
async function application() {
  const directory = await mkdtemp(join(tmpdir(), 'Uimori M2 story '));
  const app = await createApp({
    dbPath: join(directory, 'story.sqlite'),
    buildId: 'M2-synthetic-only',
    instanceId: randomUUID(),
    testMode: true,
  });
  owned.push({ directory, app });
  await app.ready();
  return app;
}
function chat(store: Store) {
  const created = createFixtureChat(store, 'Synthetic story notes');
  store.settings(created.id, created.settingsRevision, {
    ...created.settings,
    status: false,
  });
  return created.id;
}
function queued(store: Store, chatId: string, request = 'Continue.', branchId?: string): Run {
  const current = store.chat(chatId);
  const profile = store.product.snapshot(chatId);
  const branch = store.product.branch(chatId, branchId);
  return store.createRun(
    chatId,
    {
      request,
      expectedRevision: branch.headRevision,
      expectedSettingsRevision: current.settingsRevision,
      idempotencyKey: randomUUID(),
      ...(branchId ? { branchId } : {}),
    },
    (selected) =>
      ({
        chatId,
        parentRevision: selected.headRevision,
        settingsRevision: selected.settingsRevision,
        settings: selected.settings,
        request,
        history: store.history(selected.headRevision),
        resources: store.product.resources(chatId, profile),
        profile,
      }) satisfies RunSnapshot
  ).run;
}
async function api(
  app: App,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  body?: unknown,
  expected = 200
): Promise<any> {
  const response = await injectWithFixtureBot(app, {
    method,
    url,
    headers: {
      host: '127.0.0.1',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  expect(response.statusCode, response.body).toBe(expected);
  return response.json();
}

test('S01 source transaction failure rolls back original, Run completion and all durable story reservations', async () => {
  const { store } = await database();
  const id = chat(store);
  const run = queued(store, id);
  store.startRun(run.id);
  const controls = new Controls();
  controls.failures.add('source-transaction');
  expect(() =>
    store.completeRun(
      run.id,
      '[[event:buy-ticket]]',
      { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
      run.snapshot.settings,
      controls
    )
  ).toThrow('source-transaction');
  expect(store.run(run.id).status).toBe('running');
  expect(store.chat(id).headRevision).toBeNull();
  expect(store.db.prepare('SELECT count(*) AS n FROM sources').get()?.n).toBe(0);
  const reserve = store.story.reserveSourceInTransaction.bind(store.story);
  const spy = vi
    .spyOn(store.story, 'reserveSourceInTransaction')
    .mockImplementation((src, current) => {
      reserve(src, current);
      throw new Error('Crash after durable story reservation');
    });
  expect(() =>
    store.completeRun(
      run.id,
      '[[event:buy-ticket]]',
      { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
      run.snapshot.settings
    )
  ).toThrow('Crash after durable story reservation');
  spy.mockRestore();
  expect(store.db.prepare('SELECT count(*) AS n FROM sources').get()?.n).toBe(0);
  expect(store.run(run.id).status).toBe('running');
});

test('S06 scene commands are consumed only with successful source commit; cancelled or failed runs never consume', async () => {
  const { store } = await database();
  const id = chat(store);
  const command = store.story.createCommand(id, {
    label: 'Buy ticket',
    request: 'Buy one ticket.',
    idempotencyKey: randomUUID(),
  });
  const first = queued(store, id, command.request);
  store.transaction(() => store.story.bindCommandInTransaction(command.id, first.id));
  store.finishRun(first.id, 'cancelled', 'User cancelled');
  expect(store.story.command(command.id)).toMatchObject({
    status: 'cancelled',
    sourceRevision: null,
  });
  const retry = queued(store, id, command.request);
  store.transaction(() => store.story.bindCommandInTransaction(command.id, retry.id));
  store.startRun(retry.id);
  const result = store.completeRun(
    retry.id,
    'A ticket.',
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    retry.snapshot.settings
  );
  expect(store.story.command(command.id)).toMatchObject({
    status: 'consumed',
    runId: retry.id,
    sourceRevision: result.id,
  });
  const duplicate = queued(store, id, command.request);
  expect(() =>
    store.transaction(() => store.story.bindCommandInTransaction(command.id, duplicate.id))
  ).toThrow('unavailable');
  store.finishRun(duplicate.id, 'cancelled', 'Duplicate command rejected');
  const failedCommand = store.story.createCommand(id, {
    label: 'Try',
    request: 'Try another scene.',
    idempotencyKey: randomUUID(),
  });
  const failed = queued(store, id, failedCommand.request);
  store.transaction(() => store.story.bindCommandInTransaction(failedCommand.id, failed.id));
  store.finishRun(failed.id, 'failed', 'Synthetic run failure');
  expect(store.story.command(failedCommand.id).status).toBe('failed');
});

test('explicit notes need no transcripts, use CAS and preserve their replaced records without provider calls', async () => {
  const app = await application();
  const created = await api(app, 'POST', '/api/chats', { title: 'Synthetic notes' });
  const first = await api(app, 'POST', `/api/chats/${created.id}/notes`, {
    text: 'The sea is silver.',
    author: 'user',
    expectedRevision: 0,
    expectedHeadRevision: null,
    idempotencyKey: 'note-one',
  });
  expect(first.note).toMatchObject({ kind: 'author-note', atRevision: null, atHash: null });
  const replacement = await api(app, 'POST', `/api/chats/${created.id}/notes`, {
    text: 'The sea is violet.',
    author: 'user',
    replacesId: first.note.id,
    expectedRevision: 1,
    expectedHeadRevision: null,
    idempotencyKey: 'note-two',
  });
  const detail = await api(app, 'GET', `/api/chats/${created.id}/story`);
  expect(detail.notes).toEqual([replacement.note]);
  expect(detail.notesRevision).toBe(2);
  expect(
    app.store.db.prepare('SELECT count(*) AS n FROM author_notes WHERE chat_id=?').get(created.id)
      ?.n
  ).toBe(2);
  expect(app.store.detail(created.id).sources).toEqual([]);
  expect(app.store.detail(created.id).attempts).toEqual([]);
  await api(
    app,
    'POST',
    `/api/chats/${created.id}/notes`,
    {
      text: 'Stale correction',
      author: 'user',
      expectedRevision: 0,
      expectedHeadRevision: null,
      idempotencyKey: 'stale-note',
    },
    409
  );
});
