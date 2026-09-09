import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import * as transport from '../core/transport.js';
import type { Chat } from '../core/types.js';
import { fixtureBotInput } from './fixtures/chat.js';

const owned: { path: string; close: () => unknown }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const item of owned.splice(0).reverse()) {
    await item.close();
    const inside = relative(tmpdir(), item.path);
    if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('uimori-title-api-'))
      throw new Error('Unsafe test cleanup');
    await rm(item.path, { recursive: true, force: true });
  }
});

async function setup() {
  const path = await mkdtemp(join(tmpdir(), 'uimori-title-api-'));
  const app = await createApp({
    dbPath: join(path, 'test.sqlite'),
    buildId: 'title-api',
    testMode: true,
    approvedOrigins: ['http://127.0.0.1:9'],
  });
  owned.push({ path, close: () => app.close() });
  const bot = app.store.product.content(fixtureBotInput());
  async function create(extra: Record<string, unknown> = {}) {
    const result = await app.inject({
      method: 'POST',
      url: '/api/chats',
      payload: { title: 'A', botId: bot.id, ...extra },
    });
    expect(result.statusCode).toBe(200);
    return result.json<Chat>();
  }
  const rename = (chat: Chat, title: string, expectedTitleRevision = chat.titleRevision ?? 0) =>
    app.inject({
      method: 'PATCH',
      url: `/api/chats/${chat.id}/title`,
      payload: { title, expectedTitleRevision },
    });
  return { app, bot, create, rename };
}

test('manual title API rejects stale revisions including A to B to A and records same-title intent', async () => {
  const { app, create, rename } = await setup();
  const chat = await create();
  expect(chat.titleRevision).toBe(0);
  const same = await rename(chat, 'A');
  expect(same.statusCode).toBe(200);
  const manual = same.json<Chat>();
  expect(manual.titleRevision).toBeGreaterThan(0);
  const b = await rename(manual, 'B');
  expect(b.statusCode).toBe(200);
  const a = await rename(b.json<Chat>(), 'A');
  expect(a.statusCode).toBe(200);
  expect(a.json<Chat>().titleRevision).toBeGreaterThan(b.json<Chat>().titleRevision!);
  expect((await rename(chat, 'Stale', 0)).statusCode).toBe(409);
  expect(app.store.chat(chat.id).title).toBe('A');
  expect(
    app.store.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE chat_id=? AND kind='chat.title.manual'")
      .get(chat.id)
  ).toEqual({ n: 3 });
});

test('manual title API validates text and revision without mutating state', async () => {
  const { app, create, rename } = await setup();
  const chat = await create();
  for (const title of ['', '   ', 'x'.repeat(201)])
    expect((await rename(chat, title)).statusCode).toBe(400);
  for (const expectedTitleRevision of [-1, 0.5, '0', null]) {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/chats/${chat.id}/title`,
      payload: { title: 'Changed', expectedTitleRevision },
    });
    expect(response.statusCode).toBe(400);
  }
  expect(app.store.chat(chat.id)).toEqual(chat);
  const accepted = await rename(chat, 'x'.repeat(200));
  expect(accepted.statusCode).toBe(200);
  expect(accepted.json<Chat>().title).toHaveLength(200);
});

test('manual title changes preserve chat execution, organization and source records and export the new title', async () => {
  const { app, create, rename } = await setup();
  const chat = await create();
  const store = app.store;
  const profile = store.product.snapshot(chat.id);
  const run = store.createRun(
    chat.id,
    {
      request: 'Synthetic source',
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    () => ({
      chatId: chat.id,
      parentRevision: chat.headRevision,
      settingsRevision: chat.settingsRevision,
      settings: chat.settings,
      request: 'Synthetic source',
      history: [],
      resources: store.product.resources(chat.id, profile),
      profile,
    })
  ).run;
  store.startRun(run.id);
  store.completeRun(
    run.id,
    'Immutable synthetic source',
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
  const before = store.chat(chat.id);
  const sources = store.db.prepare('SELECT * FROM sources WHERE chat_id=?').all(chat.id);
  expect(sources).toHaveLength(1);
  const runs = store.db.prepare('SELECT * FROM runs WHERE chat_id=?').all(chat.id);
  const saved = await rename(before, 'Renamed with source');
  expect(saved.statusCode).toBe(200);
  const after = saved.json<Chat>();
  const stable = (value: Chat) => ({
    headRevision: value.headRevision,
    settingsRevision: value.settingsRevision,
    settings: value.settings,
    botId: value.botId,
    folderId: value.folderId,
    sortPosition: value.sortPosition,
    organizationRevision: value.organizationRevision,
  });
  expect(stable(after)).toEqual(stable(before));
  expect(store.db.prepare('SELECT * FROM sources WHERE chat_id=?').all(chat.id)).toEqual(sources);
  expect(store.db.prepare('SELECT * FROM runs WHERE chat_id=?').all(chat.id)).toEqual(runs);
  const path = await mkdtemp(join(tmpdir(), 'uimori-title-api-'));
  const restored = new Store(join(path, 'restored.sqlite'));
  owned.push({ path, close: () => restored.close() });
  restored.product.import(store.product.export());
  expect(restored.chat(chat.id).title).toBe('Renamed with source');
});

test('automatic title enrollment needs explicit opt-in and a configured title model without provider calls', async () => {
  const { app, create } = await setup();
  const execute = vi
    .spyOn(transport, 'executeProvider')
    .mockRejectedValue(new Error('Unexpected provider execution during API fixture'));
  const disabled = await create({ autoTitle: true });
  const connection = app.store.product.connection({
    title: 'Fixture',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = app.store.product.model({
    title: 'Title',
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
    titleModel: { id: model.id },
  });
  const automatic = await create({ autoTitle: true });
  const omitted = await create({ title: 'Custom title' });
  const explicit = await create({ title: 'Custom title', autoTitle: false });
  const eligible = app.store.db
    .prepare("SELECT chat_id FROM events WHERE kind='chat.title.eligible'")
    .all();
  expect(eligible).toEqual([{ chat_id: automatic.id }]);
  expect(new Set([disabled.id, omitted.id, explicit.id]).has(automatic.id)).toBe(false);
  expect(execute).not.toHaveBeenCalled();
});

test('real transport completes HTTP runs and invokes the automatic title helper exactly once', async () => {
  const { app, create } = await setup();
  const connection = app.store.product.connection({
    title: 'Synthetic transport',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = app.store.product.model({
    title: 'Synthetic model',
    connectionId: connection.id,
    modelId: 'fixture',
    maxOutputTokens: 1024,
    temperature: null,
  });
  const workspace = modelWorkspace(app.store);
  updateModelWorkspace(app.store, {
    expectedRevision: workspace.revision,
    routes: { ...workspace.routes, main: { id: model.id } },
    translationPolicy: workspace.translationPolicy,
    titleModel: { id: model.id },
  });
  const bodies: transport.ProviderRequest[] = [];
  // Preserve executeProvider, validation, wire journaling, encoder and SSE parser; replace I/O only.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    expect(new URL(String(url)).origin).toBe('http://127.0.0.1:9');
    expect(options?.method).toBe('POST');
    const request = JSON.parse(String(options?.body)) as transport.ProviderRequest;
    bodies.push(request);
    expect(['main', 'title']).toContain(request.role);
    const events = [
      {
        type: 'text_delta',
        delta: request.role === 'title' ? '첫 만남의 기록' : 'Synthetic completed source.',
      },
      { type: 'usage', inputTokens: 1, outputTokens: 2, costUsd: null },
      { type: 'done', reason: 'stop' },
    ];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  const chat = await create({ autoTitle: true });
  async function complete() {
    const current = app.store.chat(chat.id);
    const result = await app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/runs`,
      payload: {
        request: 'Continue the synthetic scene.',
        expectedRevision: current.headRevision,
        expectedSettingsRevision: current.settingsRevision,
        idempotencyKey: randomUUID(),
      },
    });
    expect(result.statusCode).toBe(200);
    const runId = result.json<{ id: string }>().id;
    await vi.waitFor(() => expect(app.store.run(runId).status).toBe('completed'));
    return runId;
  }
  const firstRun = await complete();
  await vi.waitFor(() => expect(app.store.chat(chat.id).title).toBe('첫 만남의 기록'));
  expect(
    app.store.product.attempts(chat.id).filter((attempt) => attempt.role === 'title')
  ).toMatchObject([{ role: 'title', status: 'completed', runId: firstRun }]);
  await complete();
  expect(bodies.filter((request) => request.role === 'title')).toHaveLength(1);
  expect(bodies.filter((request) => request.role === 'main')).toHaveLength(2);
  expect(bodies.find((request) => request.role === 'title')).toMatchObject({
    stable: { tools: [] },
    generation: { maxOutputTokens: 256 },
  });
  expect(
    app.store.product.attempts(chat.id).filter((attempt) => attempt.role === 'title')
  ).toHaveLength(1);
  expect(app.store.chat(chat.id).title).toBe('첫 만남의 기록');
});
