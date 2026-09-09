import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as transport from '../core/transport.js';
import { Store } from '../server/store.js';
import { ChatTitleService } from '../server/chat-title.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { createFixtureChat } from './fixtures/chat.js';
import { editSource } from '../server/source-editing.js';

const owned: { store: Store; path: string }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const { store, path } of owned.splice(0)) {
    store.close();
    const within = relative(tmpdir(), path);
    if (isAbsolute(within) || within.startsWith('..') || !within.startsWith('uimori-title-'))
      throw new Error('Unsafe cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
function setup() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-title-')),
    store = new Store(join(path, 'story.sqlite'));
  owned.push({ store, path });
  const chat = createFixtureChat(store, 'Default title');
  const connection = store.product.connection({
    title: 'Fixture',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = store.product.model({
    title: 'Title',
    connectionId: connection.id,
    modelId: 'fixture',
    maxOutputTokens: 1024,
    temperature: null,
  });
  const current = modelWorkspace(store);
  updateModelWorkspace(store, {
    expectedRevision: current.revision,
    routes: { ...current.routes, main: { id: model.id } },
    translationPolicy: current.translationPolicy,
    titleModel: { id: model.id },
  });
  const work: Promise<void>[] = [];
  const publish = vi.fn();
  const options = {
    approvedOrigins: [],
    signal: new AbortController().signal,
    track: (p: Promise<void>) => {
      work.push(p);
    },
    publish,
  };
  const service = new ChatTitleService(store, options);
  service.enroll(chat.id);
  const profile = store.product.snapshot(chat.id);
  const run = store.createRun(
    chat.id,
    {
      request: 'A scene',
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    () => ({
      chatId: chat.id,
      parentRevision: chat.headRevision,
      settingsRevision: chat.settingsRevision,
      settings: chat.settings,
      request: 'A scene',
      history: [],
      resources: store.product.resources(chat.id, profile),
      profile,
    })
  ).run;
  store.startRun(run.id);
  const source = store.completeRun(
    run.id,
    'A synthetic source.',
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
  return { store, chat, run, source, service, work, publish, connection, options };
}
const success: transport.ProviderResult = {
  status: 'completed',
  text: '새로운 만남',
  toolCalls: [],
  refusal: null,
  error: null,
  usage: { inputTokens: 1, outputTokens: 2, costUsd: null, raw: null, priceRevision: null },
  opaqueState: null,
};
function mockSend(before?: () => void, result = success, finish?: () => Promise<void>) {
  return vi
    .spyOn(transport, 'executeProvider')
    .mockImplementation(async (connection, request, options) => {
      before?.();
      options.beforeTurn?.();
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
      await finish?.();
      return result;
    });
}
test('one title request is journaled, bounded and never repeated after completion or restart', async () => {
  const f = setup(),
    send = mockSend();
  f.service.afterSource(f.run.id);
  f.service.afterSource(f.run.id);
  await Promise.all(f.work);
  expect(f.store.chat(f.chat.id).title).toBe('새로운 만남');
  expect(f.publish).toHaveBeenCalledWith(f.chat.id);
  const request = send.mock.calls[0][1];
  expect(request.role).toBe('title');
  expect(request.stable.tools).toEqual([]);
  expect(request.generation?.maxOutputTokens).toBe(256);
  expect(f.store.product.attempts(f.chat.id)).toMatchObject([
    { role: 'title', status: 'completed' },
  ]);
  new ChatTitleService(f.store, f.options).afterSource(f.run.id);
  expect(send).toHaveBeenCalledTimes(1);
});
test.each(['manual', 'source', 'cancel'] as const)(
  'late title cannot overwrite %s changes',
  async (kind) => {
    const f = setup();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockSend(undefined, success, () => pending);
    f.service.afterSource(f.run.id);
    if (kind === 'manual') f.store.event(f.chat.id, 'chat.title.manual', f.chat.id);
    if (kind === 'source')
      editSource(f.store, f.source.id, {
        expectedRevision: f.source.editRevision ?? 0,
        text: 'Edited source',
      });
    if (kind === 'cancel') f.service.cancel(f.chat.id);
    release();
    await Promise.all(f.work);
    expect(f.store.chat(f.chat.id).title).toBe('Default title');
    expect(f.publish).not.toHaveBeenCalled();
  }
);
test('current connection authority is checked before the first send and failure does not retry', async () => {
  const f = setup();
  const send = mockSend(() => {
    f.store.db
      .prepare("UPDATE provider_settings SET body=? WHERE kind='connection' AND id=?")
      .run(JSON.stringify({ ...f.connection, enabled: false }), f.connection.id);
  });
  f.service.afterSource(f.run.id);
  await Promise.all(f.work);
  expect(f.store.product.attempts(f.chat.id)).toEqual([]);
  new ChatTitleService(f.store, f.options).afterSource(f.run.id);
  expect(send).toHaveBeenCalledTimes(1);
  expect(f.store.chat(f.chat.id).title).toBe('Default title');
});

test('transport failure after the wire leaves a terminal durable attempt and never replays', async () => {
  const f = setup();
  const send = mockSend(undefined, success, async () => {
    throw new Error('Synthetic provider failure');
  });
  f.service.afterSource(f.run.id);
  await Promise.all(f.work);
  expect(f.store.product.attempts(f.chat.id)).toMatchObject([
    { role: 'title', status: 'error', error: 'TITLE_GENERATION_FAILED' },
  ]);
  new ChatTitleService(f.store, f.options).afterSource(f.run.id);
  expect(send).toHaveBeenCalledTimes(1);
  expect(f.store.chat(f.chat.id).title).toBe('Default title');
});
