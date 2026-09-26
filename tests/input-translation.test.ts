import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as transport from '../core/transport.js';
import { inputTranslationContract, inputTranslationTerms } from '../core/input-translation.js';
import { REQUEST_TEXT_MAX_CHARS } from '../core/content-limits.js';
import { withTranslationGuide } from '../core/translation-guide.js';
import { createApp, type App } from '../server/app.js';
import { importChatTranscript } from '../server/chat-transcript.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { fixtureBotInput } from './fixtures/chat.js';

const owned: { app: App; path: string }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { app, path } of owned.splice(0)) {
    await app.close();
    rmSync(path, { recursive: true, force: true });
  }
});
const success: transport.ProviderResult = {
  status: 'completed',
  text: '(OOC: Mira does not know yet.)\n\n*{{char}} waits.*',
  toolCalls: [],
  refusal: null,
  error: null,
  usage: { inputTokens: 10, outputTokens: 20, costUsd: null, raw: null, priceRevision: null },
  opaqueState: null,
};
async function setup(withModel = true) {
  const path = mkdtempSync(join(tmpdir(), 'uimori-input-translation-'));
  const app = await createApp({
    dbPath: join(path, 'app.sqlite'),
    buildId: 'input-translation-test',
    testMode: true,
  });
  owned.push({ app, path });
  const { store } = app;
  const input = fixtureBotInput('Spelling owner', 'BOT_PROSE_NOT_REQUIRED');
  input.package.nativeRisu.card = withTranslationGuide(input.package.nativeRisu.card, {
    instructions: 'KOREAN_OUTPUT_ONLY_DO_NOT_FORWARD',
    terms: [
      { source: 'Mira', target: '미라', note: 'The person; preserve uncertainty.' },
      { source: 'Rose', target: '로즈', note: 'Not the flower.' },
    ],
  });
  const bot = store.product.content(input);
  const chat = importChatTranscript(store, {
    idempotencyKey: randomUUID(),
    transcript: {
      format: 'uimori-chat-transcript',
      version: 2,
      exportedAt: new Date().toISOString(),
      title: 'Input translation scene',
      packageAttachments: [{ id: bot.id, revision: bot.revision, role: 'bot' }],
      notes: [],
      entries: [
        { request: 'Old unrelated request', text: 'OLDER_SCENE_NOT_REQUIRED', translation: null },
        {
          request: 'Current request',
          translation: null,
          text:
            'OLD_PREFIX_NOT_REQUIRED' + 'Reference text. '.repeat(500) + 'LATEST_SCENE_REFERENCE',
        },
      ],
    },
  }).chat;
  const connection = store.product.connection({
    title: 'Fixture',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = store.product.model({
    title: 'Existing translation model',
    connectionId: connection.id,
    modelId: 'fixture',
    maxOutputTokens: 4096,
    temperature: null,
  });
  const current = modelWorkspace(store);
  updateModelWorkspace(store, {
    expectedRevision: current.revision,
    routes: { ...current.routes, translation: withModel ? { id: model.id } : null },
    translationPolicy: current.translationPolicy,
  });
  const post = (body: unknown) =>
    app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/input-translation`,
      payload: body as object,
    });
  return { app, store, chat, connection, model, post };
}
function mockSend(result = success) {
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
      return result;
    });
}
function databaseState(app: App) {
  const tables = app.store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  return tables.map(({ name }) => [
    name,
    app.store.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all(),
  ]);
}
const payload = {
  text: '(OOC: 미라는 아직 몰라.)\n\n*{{char}}는 기다린다.*',
  targetLanguage: 'en',
};

test('explicit input translation uses the selected model and spelling pairs, without any persistent write', async () => {
  const f = await setup();
  const send = mockSend();
  const before = databaseState(f.app);
  const response = await f.post({ ...payload, branchId: f.store.product.branch(f.chat.id).id });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toEqual({ text: success.text, targetLanguage: 'en' });
  expect(response.headers['cache-control']).toBe('no-store');
  expect(send).toHaveBeenCalledTimes(1);
  const [connection, request] = send.mock.calls[0];
  expect(connection.id).toBe(f.connection.id);
  expect(request).toMatchObject({
    role: 'translation',
    modelId: f.model.modelId,
    stable: { tools: [] },
  });
  expect(request.prompt).toBeUndefined();
  expect(request.input.controls).toEqual({});
  expect(request.stable.contract).toContain('into English');
  const task = JSON.parse(request.input.task);
  expect(task.draft).toBe(payload.text);
  expect(task.terms).toEqual([
    { source: 'Mira', target: '미라', note: 'The person; preserve uncertainty.' },
  ]);
  expect(task.context.excerpt).toHaveLength(3000);
  expect(task.context.truncated).toBe(true);
  expect(task.context.excerpt).toContain('LATEST_SCENE_REFERENCE');
  expect(JSON.stringify(request)).not.toMatch(
    /KOREAN_OUTPUT_ONLY|OLDER_SCENE_NOT_REQUIRED|OLD_PREFIX_NOT_REQUIRED|BOT_PROSE_NOT_REQUIRED/
  );
  expect(databaseState(f.app)).toEqual(before);
});

test('language selection changes the contract; reference terms work both ways without replacement', () => {
  expect(inputTranslationContract('ja')).toContain('into Japanese');
  const terms = [
    { source: 'Rose', target: '로즈', note: 'Person only' },
    { source: 'Mira', target: '미라' },
  ];
  expect(inputTranslationTerms('ROSE and 미라', terms)).toEqual(terms);
  expect(inputTranslationTerms('A different request', terms)).toEqual([]);
});

test('a long draft and its translation keep their full text without extra model calls', async () => {
  const f = await setup();
  const draft = '작가 요청\n'.repeat(4000) + '끝까지 보존';
  const translated = 'Author request\n'.repeat(4000) + 'KEEP THE END';
  const send = mockSend({ ...success, text: translated });
  const before = databaseState(f.app);
  const response = await f.post({ ...payload, text: draft });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toEqual({ text: translated, targetLanguage: 'en' });
  expect(send).toHaveBeenCalledTimes(1);
  expect(JSON.parse(send.mock.calls[0][1].input.task).draft).toBe(draft);
  expect(databaseState(f.app)).toEqual(before);
});

test('the request-sized HTTP body reaches model selection without starting a call', async () => {
  const f = await setup(false);
  const send = mockSend();
  // JSON escapes each null character to six bytes: the former 4 MiB body cap failed first.
  const response = await f.post({ ...payload, text: '\0'.repeat(REQUEST_TEXT_MAX_CHARS) });
  expect(response.statusCode, response.body).toBe(409);
  expect(response.json()).toEqual({ error: 'MODEL_REQUIRED:translation' });
  expect(send).not.toHaveBeenCalled();
});

test('no selected translation model gives actionable feedback and never falls back to another role', async () => {
  const f = await setup(false);
  const send = mockSend();
  const response = await f.post(payload);
  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({ error: 'MODEL_REQUIRED:translation' });
  expect(send).not.toHaveBeenCalled();
});

test.each([
  { ...payload, text: '' },
  { ...payload, text: ' '.repeat(10) },
  { ...payload, text: 'x'.repeat(REQUEST_TEXT_MAX_CHARS + 1) },
  { ...payload, targetLanguage: 'unknown' },
  { ...payload, modelId: 'another-model' },
  { ...payload, branchId: 42 },
])('invalid input is rejected before calling the model (case %#)', async (body) => {
  const f = await setup();
  const send = mockSend();
  const response = await f.post(body);
  expect(response.statusCode).toBe(400);
  expect(send).not.toHaveBeenCalled();
});

test('unknown or foreign branch cannot supply context to this translation', async () => {
  const f = await setup();
  const send = mockSend();
  const response = await f.post({ ...payload, branchId: 'main:some-other-chat' });
  expect(response.statusCode).toBe(404);
  expect(send).not.toHaveBeenCalled();
});

test.each([
  ['refused', { status: 'refused', refusal: 'No' }, 422, 'INPUT_TRANSLATION_REFUSED'],
  ['partial', { status: 'partial', text: 'Only half' }, 502, 'INPUT_TRANSLATION_FAILED'],
  ['failed', { status: 'error', text: '' }, 502, 'INPUT_TRANSLATION_FAILED'],
  ['empty', { text: '  ' }, 502, 'INPUT_TRANSLATION_FAILED'],
  [
    'tools',
    { status: 'tool_calls', toolCalls: [{ id: '1', name: 'invented', arguments: {} }] },
    502,
    'INPUT_TRANSLATION_FAILED',
  ],
  ['too long', { text: 'x'.repeat(REQUEST_TEXT_MAX_CHARS + 1) }, 422, 'INPUT_TRANSLATION_TOO_LONG'],
] as const)(
  'does not apply, truncate or automatically retry a %s result',
  async (_, delta, status, error) => {
    const f = await setup();
    const result = { ...success, ...delta } as transport.ProviderResult;
    const send = mockSend(result);
    const before = databaseState(f.app);
    const response = await f.post(payload);
    expect(response.statusCode, response.body).toBe(status);
    expect(response.json()).toEqual({ error });
    expect(send).toHaveBeenCalledTimes(1);
    expect(databaseState(f.app)).toEqual(before);
  }
);

test('server shutdown cancels a pending input translation instead of leaving provider work behind', async () => {
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
  const pending = f.post(payload);
  // light-my-request starts its request when the thenable is consumed.
  const response = Promise.resolve(pending);
  await ready;
  await f.app.close();
  expect(cancelled).toBe(true);
  expect((await response).statusCode).toBe(408);
});
