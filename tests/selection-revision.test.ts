import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import * as transport from '../core/transport.js';
import {
  NEARBY_CONTEXT_CHARS,
  surroundingDraft,
  validRevisionRange,
} from '../core/selection-revision.js';
import { SOURCE_TEXT_MAX_CHARS } from '../core/content-limits.js';
import { createApp, type App } from '../server/app.js';
import { latestTranslation, requestTranslation } from '../server/source-editing.js';
import { deleteChat } from '../server/chat-deletion.js';
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
async function setup(withModel = true, timeoutMs?: number, translation: string | null = null) {
  const path = mkdtempSync(join(tmpdir(), 'uimori-selection-revision-'));
  const app = await createApp({
    dbPath: join(path, 'app.sqlite'),
    buildId: 'selection-revision-test',
    testMode: true,
  });
  owned.push({ app, path });
  const { store } = app;
  const bot = store.product.content(fixtureBotInput());
  const chat = importChatTranscript(
    store,
    {
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
            translation,
          },
        ],
      },
    },
    'library'
  ).chat;
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
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
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
    target: 'source' as const,
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
  expect(late.json()).toEqual({ code: 'SELECTION_REVISION_STALE' });
  expect(f.store.source(f.source.id).text).toBe('다른 창에서 저장한 원문.');
  const early = await f.post();
  expect(early.statusCode).toBe(409);
  expect(send).toHaveBeenCalledTimes(1);
});

test('refused, partial, empty, tool-call, or oversized results cannot change the source and are never retried', async () => {
  const f = await setup();
  const before = authoredState(f.app);
  const cases: { delta: Partial<transport.ProviderResult>; status: number; error?: string }[] = [
    { delta: { status: 'refused', refusal: 'No' }, status: 422 },
    { delta: { status: 'partial', text: 'unfinished' }, status: 502 },
    { delta: { text: '' }, status: 502 },
    {
      delta: { status: 'tool_calls', toolCalls: [{ id: '1', name: 'save', arguments: {} }] },
      status: 502,
    },
    {
      delta: { text: 'x'.repeat(SOURCE_TEXT_MAX_CHARS) },
      status: 422,
      error: 'SELECTION_REVISION_TOO_LONG',
    },
  ];
  for (const { delta, status, error } of cases) {
    vi.restoreAllMocks();
    const send = mockSend({ ...success, ...delta });
    const response = await f.post();
    expect(response.statusCode, JSON.stringify(delta).slice(0, 80)).toBe(status);
    if (error) expect(response.json()).toEqual({ code: error });
    expect(send).toHaveBeenCalledTimes(1);
    expect(authoredState(f.app)).toEqual(before);
  }
  expect(f.store.source(f.source.id)).toEqual(f.source);
});

test('invalid selection and absent helper model never send a provider call', async () => {
  const f = await setup(false);
  const send = mockSend();
  const invalid = await f.post({ ...f.payload, end: f.payload.start });
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json()).toEqual({ code: 'SELECTION_REVISION_RANGE_INVALID' });
  const schemaRefused = await f.post({ ...f.payload, instruction: ' ' });
  expect(schemaRefused.statusCode).toBe(400);
  expect(schemaRefused.headers['cache-control']).toBe('no-store');
  const response = await f.post();
  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({ code: 'MODEL_REQUIRED', params: { role: 'helper' } });
  expect(send).not.toHaveBeenCalled();
  expect(validRevisionRange('A😀B', 1, 2)).toBe(false);
  expect(validRevisionRange('A😀B', 2, 3)).toBe(false);
  expect(validRevisionRange('A😀B', 1, 3)).toBe(true);
});

test('a source another tab deleted answers the revision conflict and never spends a call', async () => {
  const f = await setup();
  const send = mockSend();
  deleteChat(f.store, f.chat.id);
  const response = await f.post({ ...f.payload, end: f.payload.start });
  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({ code: 'REVISION_CONFLICT' });
  expect(response.headers['cache-control']).toBe('no-store');
  expect(send).not.toHaveBeenCalled();
  expect(f.store.db.prepare('SELECT count(*) AS n FROM attempts').get()!.n).toBe(0);
});

test('nearby context keeps whole paragraphs next to the selection and marks the excerpt', () => {
  const paragraph = (n: number) => `문단 ${n} `.padEnd(400, '가');
  const before = `${Array.from({ length: 20 }, (_, i) => paragraph(i)).join('\n\n')}\n\n`;
  const after = `\n\n${Array.from({ length: 20 }, (_, i) => paragraph(100 + i)).join('\n\n')}`;
  const selected = '선택한 문장.';
  const draft = before + selected + after;
  const range = [before.length, before.length + selected.length] as const;
  expect(surroundingDraft(draft, ...range, 'scene')).toEqual({ before, after });
  const near = surroundingDraft(draft, ...range, 'nearby');
  expect(near.excerpt).toBe(true);
  expect(before.endsWith(near.before)).toBe(true);
  expect(after.startsWith(near.after)).toBe(true);
  expect(near.before.startsWith('문단 ')).toBe(true);
  expect(near.after.endsWith('가')).toBe(true);
  for (const side of [near.before, near.after]) {
    expect(side.length).toBeLessThanOrEqual(NEARBY_CONTEXT_CHARS);
    expect(side.length).toBeGreaterThan(NEARBY_CONTEXT_CHARS / 2);
  }
  const pairs = '😀'.repeat(NEARBY_CONTEXT_CHARS);
  const at = pairs.length + 1;
  const cut = surroundingDraft(`${pairs}a끝a${pairs}`, at, at + 1, 'nearby');
  expect(/\p{Cs}/u.test(cut.before + cut.after)).toBe(false);
  expect(cut.before.length).toBe(NEARBY_CONTEXT_CHARS - 1);
  expect(cut.after.length).toBe(NEARBY_CONTEXT_CHARS - 1);
});

test('a nearby request on a short draft sends the same context, and an unknown context never sends', async () => {
  const f = await setup();
  const send = mockSend();
  expect((await f.post({ ...f.payload, context: 'nearby' })).statusCode).toBe(200);
  expect(JSON.parse(send.mock.calls[0][1].input.task).surroundingDraft).toEqual({
    before: '아침이었다.\n\n',
    after: '\n\n그는 떠났다.\n이 줄은 저장하지 않은 문맥이다.',
  });
  expect((await f.post({ ...f.payload, context: 'chapter' })).statusCode).toBe(400);
  expect(send).toHaveBeenCalledTimes(1);
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

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const translated = '아침이 밝았다.\n\n미라는 울었다.\n\n그가 떠났다.';
function translationPayload(f: Awaited<ReturnType<typeof setup>>) {
  const job = latestTranslation(f.store, f.source.id)!;
  const text = job.result!.text!;
  const start = text.indexOf('미라는 울었다.');
  return {
    job,
    body: {
      target: 'translation',
      draft: text,
      start,
      end: start + '미라는 울었다.'.length,
      instruction: '더 담담하게.',
      expectedSourceHash: f.source.hash,
      expectedRevision: job.revision!,
      expectedTextHash: sha256(text),
    },
  };
}

test('a translation passage is revised against the shown translation without storing anything', async () => {
  const f = await setup(true, undefined, translated);
  const { body } = translationPayload(f);
  const before = authoredState(f.app);
  const send = mockSend();
  const response = await f.post(body);
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toEqual({ text: success.text });
  expect(send).toHaveBeenCalledTimes(1);
  expect(JSON.parse(send.mock.calls[0][1].input.task)).toMatchObject({
    selectedPassage: '미라는 울었다.',
    surroundingDraft: { before: '아침이 밝았다.\n\n', after: '\n\n그가 떠났다.' },
  });
  expect(authoredState(f.app)).toEqual(before);
});

test('a changed translation is rejected before a call and after the response; a foreign draft never sends', async () => {
  const f = await setup(true, undefined, translated);
  const { body } = translationPayload(f);
  const send = mockSend(success, () => {
    f.store.editTranslation(f.source.id, {
      text: '다른 창에서 고친 번역.',
      expectedRevision: body.expectedRevision,
      expectedSourceHash: f.source.hash,
    });
  });
  const late = await f.post(body);
  expect(late.statusCode).toBe(409);
  expect(late.json()).toEqual({ code: 'SELECTION_REVISION_TRANSLATION_STALE' });
  expect((await f.post(body)).statusCode).toBe(409);
  expect(send).toHaveBeenCalledTimes(1);
  const current = translationPayload(f).body;
  const foreign = await f.post({ ...current, start: 0, end: 2, draft: `${current.draft} ` });
  expect(foreign.statusCode).toBe(409);
  expect(send).toHaveBeenCalledTimes(1);
});

test('saving a translation checks the shown text hash and cancels a running retranslation', async () => {
  const f = await setup(true, undefined, translated);
  const shown = latestTranslation(f.store, f.source.id)!;
  const running = requestTranslation(f.store, f.source.id, true);
  expect(running.status).toBe('queued');
  const put = (payload: object) =>
    f.app.inject({ method: 'PUT', url: `/api/sources/${f.source.id}/translation`, payload });
  const base = {
    text: translated.replace('미라는 울었다.', '미라는 고개를 숙였다.'),
    expectedRevision: running.revision!,
    expectedSourceHash: f.source.hash,
  };
  const wrong = await put({ ...base, expectedTextHash: sha256('다른 번역') });
  expect(wrong.statusCode).toBe(409);
  expect(f.store.job(running.id).status).toBe('queued');
  expect(latestTranslation(f.store, f.source.id)!.id).toBe(running.id);
  const saved = await put({ ...base, expectedTextHash: sha256(shown.result!.text!) });
  expect(saved.statusCode, saved.body).toBe(200);
  expect(f.store.job(running.id).status).toBe('cancelled');
  expect(latestTranslation(f.store, f.source.id)!.result!.text).toBe(base.text);
  expect((await put({ ...base, expectedTextHash: sha256(base.text) })).statusCode).toBe(409);
});
