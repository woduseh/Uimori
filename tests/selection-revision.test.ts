import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as transport from '../core/transport.js';
import { validRevisionRange } from '../core/selection-revision.js';
import { SOURCE_TEXT_MAX_CHARS } from '../core/content-limits.js';
import { createApp, type App } from '../server/app.js';
import { importChatTranscript } from '../server/chat-transcript.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { fixtureBotInput } from './fixtures/chat.js';

const owned: { app: App; path: string }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { app, path } of owned.splice(0)) {
    await app.close();
    const target = resolve(path);
    const within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('uimori-selection-revision-')
    )
      throw new Error('Unsafe cleanup');
    rmSync(target, { recursive: true, force: true });
  }
});
const success: transport.ProviderResult = {
  status: 'completed',
  text: '미라는 문턱에서 멈췄다.',
  toolCalls: [],
  refusal: null,
  error: null,
  usage: { inputTokens: 10, outputTokens: 20, costUsd: null, raw: null, priceRevision: null },
  opaqueState: null,
};
async function setup(withModel = true) {
  const path = mkdtempSync(join(tmpdir(), 'uimori-selection-revision-'));
  const app = await createApp({
    dbPath: join(path, 'app.sqlite'),
    buildId: 'selection-revision-test',
    testMode: true,
  });
  owned.push({ app, path });
  const { store } = app;
  const bot = store.product.content(fixtureBotInput());
  const chat = importChatTranscript(store, {
    idempotencyKey: randomUUID(),
    transcript: {
      format: 'uimori-chat-transcript',
      version: 2,
      exportedAt: new Date().toISOString(),
      title: 'Selection revision',
      packageAttachments: [{ id: bot.id, revision: bot.revision, role: 'bot' }],
      notes: [],
      entries: [
        {
          request: 'First scene',
          text: '아침이었다.\n\n미라는 슬펐다.\n\n그는 떠났다.',
          translation: null,
        },
      ],
    },
  }).chat;
  const source = store.source(chat.headRevision!);
  const connection = store.product.connection({
    title: 'Fixture',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = store.product.model({
    title: 'Helper',
    connectionId: connection.id,
    modelId: 'fixture',
    maxOutputTokens: 4096,
    temperature: null,
  });
  const workspace = modelWorkspace(store);
  updateModelWorkspace(store, {
    expectedRevision: workspace.revision,
    routes: workspace.routes,
    translationPolicy: workspace.translationPolicy,
    helperModel: withModel ? { id: model.id } : null,
  });
  const draft = source.text + '\n이 줄은 저장하지 않은 문맥이다.';
  const start = draft.indexOf('미라는');
  const end = start + '미라는 슬펐다.'.length;
  const payload = {
    draft,
    start,
    end,
    instruction: '뜻을 유지하고 감정을 행동으로 보여줘.',
    expectedSourceHash: source.hash,
    expectedRevision: source.editRevision ?? 0,
  };
  const post = (body: unknown = payload) =>
    app.inject({
      method: 'POST',
      url: `/api/sources/${source.id}/selection-revision`,
      payload: body as object,
    });
  return { app, store, source, chat, model, connection, payload, post };
}
function mockSend(result = success, beforeResult?: () => void) {
  return vi
    .spyOn(transport, 'executeProvider')
    .mockImplementation(async (connection, request, options) => {
      transport.validateConnection(connection);
      transport.validateRequest(request);
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
        bodySha256: 'fixture',
        stablePrefixSha256: 'fixture',
      });
      beforeResult?.();
      return result;
    });
}
function authoredState(app: App) {
  return [
    'chats',
    'sources',
    'source_edits',
    'runs',
    'jobs',
    'job_results',
    'helper_conversations',
    'helper_tasks',
  ].map((name) => [name, app.store.db.prepare(`SELECT * FROM "${name}"`).all()]);
}

test('one helper call returns only a proposal and numeric usage; unsaved draft and story are not persisted', async () => {
  const f = await setup();
  const before = authoredState(f.app);
  const send = mockSend();
  const response = await f.post();
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toEqual({ text: success.text });
  expect(response.headers['cache-control']).toBe('no-store');
  expect(send).toHaveBeenCalledTimes(1);
  const [connection, request] = send.mock.calls[0];
  expect(connection.id).toBe(f.connection.id);
  expect(request).toMatchObject({
    role: 'helper',
    modelId: f.model.modelId,
    stable: { tools: [] },
  });
  expect(JSON.parse(request.input.task)).toEqual({
    revisionInstruction: f.payload.instruction,
    selectedPassage: '미라는 슬펐다.',
    surroundingDraft: {
      before: '아침이었다.\n\n',
      after: '\n\n그는 떠났다.\n이 줄은 저장하지 않은 문맥이다.',
    },
  });
  expect(authoredState(f.app)).toEqual(before);
  const attempts = f.store.db.prepare('SELECT * FROM attempts').all();
  expect(attempts).toHaveLength(1);
  expect(attempts[0]).toMatchObject({
    usage_kind: 'helper',
    usage_detached: 1,
    request: '{}',
    run_id: null,
    job_id: null,
  });
  expect(JSON.stringify(attempts)).not.toContain('미라는');
  expect(JSON.parse(String(attempts[0].response)).usage).toEqual({
    inputTokens: 10,
    outputTokens: 20,
    costUsd: null,
  });
});

test('changed stored source is rejected both before spending a call and after a response arrives', async () => {
  const f = await setup();
  const send = mockSend(success, () => {
    f.store.editSource(f.source.id, {
      text: '다른 창에서 저장한 원문.',
      expectedRevision: f.payload.expectedRevision,
    });
  });
  const late = await f.post();
  expect(late.statusCode).toBe(409);
  expect(late.json()).toEqual({ error: 'SELECTION_REVISION_STALE' });
  expect(f.store.source(f.source.id).text).toBe('다른 창에서 저장한 원문.');
  const early = await f.post();
  expect(early.statusCode).toBe(409);
  expect(send).toHaveBeenCalledTimes(1);
});

test.each([
  ['refused', { status: 'refused', refusal: 'No' }],
  ['partial', { status: 'partial', text: 'unfinished' }],
  ['empty', { text: '' }],
  ['tool call', { status: 'tool_calls', toolCalls: [{ id: '1', name: 'save', arguments: {} }] }],
] as const)(
  'a %s result cannot change the source and is never retried automatically',
  async (_, delta) => {
    const f = await setup();
    const send = mockSend({ ...success, ...delta } as transport.ProviderResult);
    const before = authoredState(f.app);
    const response = await f.post();
    expect(response.statusCode).toBe('status' in delta && delta.status === 'refused' ? 422 : 502);
    expect(send).toHaveBeenCalledTimes(1);
    expect(authoredState(f.app)).toEqual(before);
  }
);

test('output must fit the whole draft and cannot be silently truncated', async () => {
  const f = await setup();
  const send = mockSend({ ...success, text: 'x'.repeat(SOURCE_TEXT_MAX_CHARS) });
  const response = await f.post();
  expect(response.statusCode).toBe(422);
  expect(response.json()).toEqual({ error: 'SELECTION_REVISION_TOO_LONG' });
  expect(send).toHaveBeenCalledTimes(1);
  expect(f.store.source(f.source.id)).toEqual(f.source);
});

test('invalid selection and absent helper model never send a provider call', async () => {
  const f = await setup(false);
  const send = mockSend();
  expect((await f.post({ ...f.payload, end: f.payload.start })).statusCode).toBe(400);
  const response = await f.post();
  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({ error: 'MODEL_REQUIRED:helper' });
  expect(send).not.toHaveBeenCalled();
  expect(validRevisionRange('A😀B', 1, 2)).toBe(false);
  expect(validRevisionRange('A😀B', 2, 3)).toBe(false);
  expect(validRevisionRange('A😀B', 1, 3)).toBe(true);
});

test('shutdown cancels the single pending proposal and keeps the source', async () => {
  const f = await setup();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let cancelled = false;
  vi.spyOn(transport, 'executeProvider').mockImplementation(async (_, __, options) => {
    started();
    await new Promise<void>((resolve) =>
      options.signal.addEventListener(
        'abort',
        () => {
          cancelled = true;
          resolve();
        },
        { once: true }
      )
    );
    return { ...success, status: 'cancelled', text: '' };
  });
  const pending = Promise.resolve(f.post());
  await ready;
  await f.app.close();
  expect(cancelled).toBe(true);
  expect((await pending).statusCode).toBe(408);
});
