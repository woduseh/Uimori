import {
  modelWorkspace,
  updateModelWorkspace,
  updatePromptWorkspace,
} from '../server/prompt-workspace.js';
import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import { DEFAULT_MAIN_PROMPT } from '../core/prompts.js';
import { updateTestProfile } from './fixtures/model-workspace.js';
import { createFixtureChat, injectWithFixtureBot } from './fixtures/chat.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createApp, type App } from '../server/app.js';
import { Store } from '../server/store.js';
import { forkChat } from '../server/chat-fork.js';
import { estimateContextTokens } from '../core/context-budget.js';
import { defaultEvaluationToolOptions } from '../core/evaluation-tool-config.js';
import type { Connection, ModelPreset } from '../core/product.js';
import type { Run, RunSnapshot, Source } from '../core/types.js';

const endpoint = 'http://127.0.0.1:44997/turn',
  origin = 'http://127.0.0.1:44997';
const credential = 'SYNTHETIC_CONTEXT_TEST_CREDENTIAL';
const secret = 'synthetic-context-credential-never-persist';
const summary =
  '미라는 항구에서 과거의 약속을 기억했어요. 그 약속의 진실은 아직 불확실해요. 사용자 요청은 미라의 선택을 대신 정하지 말라는 것이었어요.';
const finalText = '미라는 지도 가장자리에 손을 얹었어요. 부두의 불빛은 아직 켜져 있었어요.';
const paragraph = '비 오는 항구에서 미라는 약속을 기억해요. 진실인지 아직 알 수 없어요.\n';
const usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
const owned: { directory: string; app?: App; store?: Store }[] = [];
type Body = {
  role: string;
  modelId: string;
  stable: { tools: unknown[] };
  input: {
    source?: {
      previousSummary?: string | null;
      fragments?: { role: string; sourceRevision: string; text: string }[];
    };
  };
  [key: string]: unknown;
};
const encode = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
const sse = (...events: unknown[]) =>
  new Response(events.map(encode).join(''), { headers: { 'content-type': 'text/event-stream' } });
const complete = (text: string, inputTokens = 11) =>
  sse(
    { type: 'text_delta', delta: text },
    { type: 'usage', inputTokens, outputTokens: 7, costUsd: null },
    { type: 'done', reason: 'stop' }
  );
beforeEach(() => {
  vi.stubEnv(credential, secret);
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('Unexpected network in synthetic context integration test')
  );
});
afterEach(async () => {
  for (const item of owned.splice(0).reverse()) {
    await item.app?.close();
    item.store?.close();
    const target = resolve(item.directory),
      within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('uimori-context-integration-')
    )
      throw new Error('Unsafe test cleanup');
    await rm(target, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function directory() {
  const item: (typeof owned)[number] = {
    directory: await mkdtemp(join(tmpdir(), 'uimori-context-integration-')),
  };
  owned.push(item);
  return item;
}
async function setup(options: { evaluated?: boolean; count?: number; short?: boolean } = {}) {
  const item = await directory();
  const app = (item.app = await createApp({
    dbPath: join(item.directory, 'story.sqlite'),
    buildId: 'synthetic-context-test',
    approvedOrigins: [origin],
  }));
  await app.ready();
  // Keep these compression boundaries on the same short synthetic instructions.
  updatePromptWorkspace(app.store, {
    expectedRevision: modelWorkspace(app.store).revision,
    main: {
      title: 'Synthetic context instructions',
      program: createDefaultPromptProgram(DEFAULT_MAIN_PROMPT),
      values: {},
    },
  });
  let chat = createFixtureChat(app.store, '합성 긴 한국어 대화');
  chat = app.store.settings(chat.id, chat.settingsRevision, {
    ...chat.settings,
    translation: false,
    status: false,
    maxCalls: 16,
  });
  const sources: Source[] = [];
  for (let index = 0; index < (options.count ?? 5); index++) {
    const request = `사용자 ${index}: 미라의 선택을 대신 정하지 말아 주세요.`;
    const current = app.store.chat(chat.id);
    const run = app.store.createRun(
      chat.id,
      {
        request,
        expectedRevision: current.headRevision,
        expectedSettingsRevision: current.settingsRevision,
        idempotencyKey: randomUUID(),
      },
      (captured) =>
        ({
          chatId: chat.id,
          parentRevision: captured.headRevision,
          settingsRevision: captured.settingsRevision,
          settings: captured.settings,
          request,
          history: app.store.history(captured.headRevision),
          resources: [],
        }) satisfies RunSnapshot
    ).run;
    app.store.startRun(run.id);
    sources.push(
      app.store.completeRun(
        run.id,
        `과거 장면 ${index}.\n${paragraph.repeat(options.short ? 1 : 60)}`,
        usage,
        run.snapshot.settings
      )
    );
  }
  const connection = app.store.product.connection({
    title: 'Synthetic memory and main',
    protocol: 'fixture-sse-v1',
    endpoint,
    credentialEnv: credential,
    enabled: true,
  }) as Connection;
  const model = app.store.product.model({
    title: 'Synthetic context model',
    connectionId: connection.id,
    modelId: 'synthetic-context-model',
    inputTokenLimit: 8192,
    maxOutputTokens: 8192,
    temperature: null,
    ...(options.evaluated
      ? { evaluationTools: { ...defaultEvaluationToolOptions(), maximumToolRounds: 0 } }
      : {}),
  }) as ModelPreset;
  const profile = app.store.product.profile(chat.id);
  updateTestProfile(app.store.product, chat.id, {
    expectedRevision: profile.revision,
    attachments: [],

    routes: { main: { id: model.id }, translation: null, status: null, image: null },
    image: profile.image,
  });
  const workspace = modelWorkspace(app.store);
  updateModelWorkspace(app.store, {
    expectedRevision: workspace.revision,
    routes: workspace.routes,
    translationPolicy: workspace.translationPolicy,
    contextModel: { id: model.id },
  });
  return { app, chatId: chat.id, sources, model, connection };
}
async function start(
  app: App,
  chatId: string,
  request = '이어서 미라가 지도를 살펴보는 장면을 써 주세요.'
) {
  const chat = app.store.chat(chatId);
  const response = await injectWithFixtureBot(app, {
    method: 'POST',
    url: `/api/chats/${chatId}/runs`,
    headers: { host: '127.0.0.1' },
    payload: {
      request,
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as Run;
}
async function terminal(app: App, id: string) {
  let run!: Run;
  await vi.waitFor(
    () => {
      run = app.store.run(id);
      expect(['queued', 'running', 'waiting_for_state']).not.toContain(run.status);
    },
    { timeout: 10_000, interval: 20 }
  );
  return run;
}
function recordRequests(
  app: App,
  bodies: Body[],
  respond: (body: Body, options: RequestInit | undefined) => Response | Promise<Response> = (
    body
  ) => complete(body.role === 'context' ? summary : finalText)
) {
  vi.mocked(fetch).mockImplementation(async (url, options) => {
    expect(String(url)).toBe(endpoint);
    const body = JSON.parse(String(options?.body)) as Body;
    bodies.push(body);
    const rows = app.store.db
      .prepare(
        "SELECT status,request FROM attempts WHERE status='running' ORDER BY rowid DESC LIMIT 1"
      )
      .all() as { status: string; request: string }[];
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].request).role).toBe(body.role);
    expect(estimateContextTokens(body)).toBeLessThanOrEqual(8192);
    expect(body).not.toHaveProperty('contextBudget');
    return respond(body, options);
  });
}
async function restored(archive: unknown) {
  const item = await directory(),
    store = (item.store = new Store(join(item.directory, 'restored.sqlite')));
  store.product.import(archive);
  return store;
}

describe('automatic input summaries through real App and file SQLite', () => {
  test('summarizes old Korean pairs, sends bounded main input, preserves originals, and reuses the checkpoint on the next run', async () => {
    const { app, chatId, sources } = await setup(),
      bodies: Body[] = [];
    recordRequests(app, bodies);
    const run = await terminal(app, (await start(app, chatId)).id),
      plan = run.snapshot.contextPlan!;
    expect(run.status, run.error ?? '').toBe('completed');
    expect(plan.status).toBe('ready');
    expect(plan.compacted.length).toBeGreaterThan(0);
    expect(plan.recentSourceRevisions).toEqual(
      expect.arrayContaining(sources.slice(-2).map((source) => source.id))
    );
    expect(run.snapshot.history.map((source) => source.text)).toEqual(
      sources.map((source) => source.text)
    );
    for (const source of sources) {
      expect(app.store.sourceOriginal(source.id).text).toBe(source.text);
      expect(
        run.snapshot
          .logicalHistory!.filter((message) => message.sourceRevision === source.id)
          .map((message) => message.role)
      ).toEqual(['user', 'assistant']);
    }
    const summaries = bodies.filter((body) => body.role === 'context'),
      main = bodies.filter((body) => body.role === 'main');
    expect(summaries.length).toBeGreaterThan(0);
    expect(main).toHaveLength(1);
    expect(summaries.every((body) => body.stable.tools.length === 0)).toBe(true);
    for (const ref of plan.compacted) {
      const parts = summaries
        .flatMap((body) => body.input.source!.fragments!)
        .filter((part) => part.sourceRevision === ref.revision);
      expect(parts.some((part) => part.role === 'user' && part.text.includes('대신 정하지'))).toBe(
        true
      );
      expect(
        parts
          .filter((part) => part.role === 'assistant')
          .map((part) => part.text)
          .join('')
      ).toBe(sources.find((source) => source.id === ref.revision)!.text);
      expect(JSON.stringify(main[0])).not.toContain(
        sources.find((source) => source.id === ref.revision)!.text
      );
    }
    expect(JSON.stringify(main[0])).toContain(summary);
    const attempts = app.store.product
      .attempts(chatId)
      .filter((attempt) => attempt.runId === run.id);
    expect(attempts.map((attempt) => attempt.role)).toEqual([
      ...summaries.map(() => 'context'),
      'main',
    ]);
    expect(run.usage).toEqual({
      modelCalls: attempts.length,
      inputTokens: 11 * attempts.length,
      outputTokens: 7 * attempts.length,
      costUsd: null,
    });
    expect(plan.usage.modelCalls).toBe(summaries.length);
    bodies.length = 0;
    const next = await terminal(
      app,
      (await start(app, chatId, '다음으로 바람이 부는 장면을 써 주세요.')).id
    );
    expect(next.status, next.error ?? '').toBe('completed');
    expect(next.snapshot.contextPlan).toMatchObject({ summary, summaryCalls: 0 });
    expect(bodies.map((body) => body.role)).toEqual(['main']);
    expect(next.usage.modelCalls).toBe(1);
    expect(JSON.stringify(app.store.product.attempts(chatId))).not.toContain(secret);
  });

  test('editing a compacted source invalidates reuse while its earlier frozen summary and source remain intact', async () => {
    const { app, chatId, sources } = await setup(),
      bodies: Body[] = [];
    recordRequests(app, bodies);
    const first = await terminal(app, (await start(app, chatId)).id);
    expect(first.status, first.error ?? '').toBe('completed');
    const oldSnapshot = structuredClone(first.snapshot),
      changedId = first.snapshot.contextPlan!.compacted[0].revision;
    const changed = app.store.editSource(changedId, {
      expectedRevision: 0,
      text: `수정된 사용자 확인 사항.\n${sources.find((source) => source.id === changedId)!.text}`,
    });
    bodies.length = 0;
    const next = await terminal(app, (await start(app, chatId)).id);
    expect(next.status, next.error ?? '').toBe('completed');
    const summaries = bodies.filter((body) => body.role === 'context');
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries[0].input.source!.previousSummary).toBeNull();
    expect(
      next.snapshot.contextPlan!.compacted.find((ref) => ref.revision === changedId)?.hash
    ).toBe(changed.hash);
    expect(app.store.run(first.id).snapshot).toEqual(oldSnapshot);
    expect(app.store.sourceOriginal(changedId).text).toBe(
      sources.find((source) => source.id === changedId)!.text
    );
  });

  test('cancelling an in-flight summary retains observed usage without creating prose or starting main', async () => {
    const { app, chatId, sources } = await setup(),
      bodies: Body[] = [];
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    recordRequests(app, bodies, (body, options) => {
      expect(body.role).toBe('context');
      const response = new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
          controller.enqueue(
            new TextEncoder().encode(
              encode({ type: 'usage', inputTokens: 37, outputTokens: 9, costUsd: null })
            )
          );
          options?.signal?.addEventListener(
            'abort',
            () => controller.error(new Error('Synthetic cancellation')),
            { once: true }
          );
        },
      });
      return new Response(response, { headers: { 'content-type': 'text/event-stream' } });
    });
    const started = await start(app, chatId);
    await vi.waitFor(() => expect(stream).toBeDefined());
    const response = await injectWithFixtureBot(app, {
      method: 'POST',
      url: `/api/runs/${started.id}/cancel`,
      headers: { host: '127.0.0.1' },
    });
    expect(response.statusCode).toBe(200);
    await vi.waitFor(() =>
      expect(
        app.store.product
          .attempts(chatId)
          .filter((attempt) => attempt.runId === started.id)
          .at(-1)?.status
      ).toBe('cancelled')
    );
    const cancelled = app.store.run(started.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.usage).toEqual({
      modelCalls: 1,
      inputTokens: 37,
      outputTokens: 9,
      costUsd: null,
    });
    expect(cancelled.sourceRevision).toBeNull();
    expect(app.store.chat(chatId).headRevision).toBe(sources.at(-1)!.id);
    expect(bodies.map((body) => body.role)).toEqual(['context']);
  });

  test('an edit while summary completes prevents the main call and retains its incurred attempt', async () => {
    const { app, chatId, sources } = await setup(),
      bodies: Body[] = [];
    let release!: (response: Response) => void;
    recordRequests(app, bodies, (body) => {
      expect(body.role).toBe('context');
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    const started = await start(app, chatId);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    app.store.editSource(sources[0].id, {
      expectedRevision: 0,
      text: `중간 수정.\n${sources[0].text}`,
    });
    release(complete(summary));
    const failed = await terminal(app, started.id);
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('CONTEXT_PROGRESS_SAVE_FAILED');
    expect(failed.sourceRevision).toBeNull();
    expect(failed.usage).toEqual({
      modelCalls: 1,
      inputTokens: 11,
      outputTokens: 7,
      costUsd: null,
    });
    expect(
      app.store.product.attempts(chatId).filter((attempt) => attempt.runId === failed.id)
    ).toMatchObject([{ role: 'context', status: 'completed' }]);
    expect(bodies.map((body) => body.role)).toEqual(['context']);
    expect(app.store.chat(chatId).headRevision).toBe(sources.at(-1)!.id);
  });

  test('forks and JSON-restores summary snapshots with mapped provenance, scrubs credentials, and rejects summary tampering', async () => {
    const { app, chatId, connection } = await setup(),
      bodies: Body[] = [];
    recordRequests(app, bodies);
    const run = await terminal(app, (await start(app, chatId)).id);
    expect(run.status, run.error ?? '').toBe('completed');
    const fork = forkChat(app.store, chatId, {
      fromRevision: run.sourceRevision,
      idempotencyKey: randomUUID(),
    });
    const forkRun = app.store.run(app.store.source(fork.headRevision!).runId),
      forkPlan = forkRun.snapshot.contextPlan!;
    expect(forkPlan.summary).toBe(summary);
    expect(forkPlan.compacted.length).toBe(run.snapshot.contextPlan!.compacted.length);
    expect(
      forkPlan.compacted.every((ref) => app.store.source(ref.revision).chatId === fork.id)
    ).toBe(true);
    expect(app.store.product.attempts(fork.id)).toEqual([]);
    const archive = JSON.parse(JSON.stringify(app.store.product.export())),
      copy = await restored(archive);
    expect(copy.run(run.id).snapshot.contextPlan).toEqual(run.snapshot.contextPlan);
    expect(copy.run(forkRun.id).snapshot.contextPlan).toEqual(forkPlan);
    expect(copy.product.get<Connection>('connection', connection.id)).toMatchObject({
      enabled: false,
    });
    expect(copy.product.get<Connection>('connection', connection.id)).not.toHaveProperty(
      'credentialEnv'
    );
    expect(copy.run(run.id).snapshot.profile!.models.main!.connection).not.toHaveProperty(
      'credentialEnv'
    );
    expect(copy.run(forkRun.id).snapshot.profile!.models.main!.connection.enabled).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(bodies.length);
    const tampered = structuredClone(archive),
      row = tampered.tables.runs.find((value: { id: string }) => value.id === run.id),
      snapshot = JSON.parse(row.snapshot);
    snapshot.contextPlan.summary = '위조된 요약은 원래 응답과 달라요.';
    row.snapshot = JSON.stringify(snapshot);
    const item = await directory(),
      rejected = (item.store = new Store(join(item.directory, 'rejected.sqlite')));
    expect(() => rejected.product.import(tampered)).toThrow();
    expect(rejected.chats()).toEqual([]);
  });

  test('summary calls share the host budget while a zero-round evaluation preset still receives its first main call', async () => {
    const { app, chatId } = await setup({ evaluated: true }),
      bodies: Body[] = [];
    recordRequests(app, bodies);
    const run = await terminal(app, (await start(app, chatId)).id);
    expect(run.status, run.error ?? '').toBe('completed');
    expect(run.snapshot.contextPlan!.summaryCalls).toBeGreaterThan(0);
    expect(bodies.filter((body) => body.role === 'main')).toHaveLength(1);
    expect(run.usage.modelCalls).toBe(bodies.length);
    expect(bodies.length).toBeLessThanOrEqual(run.snapshot.settings.maxCalls);
  });
});

async function contextApi(
  app: App,
  chatId: string,
  method: 'GET' | 'PUT' | 'POST',
  path: string,
  body?: unknown,
  status = 200
) {
  const result = await app.inject({
    method,
    url: '/api/chats/' + chatId + path,
    headers: { host: '127.0.0.1' },
    ...(body === undefined
      ? {}
      : {
          payload: JSON.stringify(body),
          headers: { host: '127.0.0.1', 'content-type': 'application/json' },
        }),
  });
  expect(result.statusCode, result.body).toBe(status);
  return result.json();
}
const contextCommand = (
  detail: { activeRevision: number; headRevision: string | null },
  key: string = randomUUID()
) => ({
  expectedRevision: detail.activeRevision,
  expectedHeadRevision: detail.headRevision,
  idempotencyKey: key,
});
async function contextTerminal(app: App, id: string) {
  await vi.waitFor(
    () =>
      expect(['completed', 'failed', 'cancelled', 'interrupted']).toContain(
        app.store.context.job(id).status
      ),
    { timeout: 5000, interval: 10 }
  );
  return app.store.context.job(id);
}
describe('standalone context summaries and explicit corrections', () => {
  test('an unset main model rejects new summary operations while preserving accepted command receipts', async () => {
    const { app, chatId } = await setup({ count: 0 });
    const initial = await contextApi(app, chatId, 'GET', '/context');
    const editCommand = { ...contextCommand(initial), summary: '모델 해제 뒤에도 보존할 요약' };
    const saved = await contextApi(app, chatId, 'PUT', '/context/summary', editCommand);
    const compactCommand = contextCommand(saved);
    const queued = await contextApi(app, chatId, 'POST', '/context/compact', compactCommand);
    const completed = await contextTerminal(app, queued.id);
    expect(completed).toMatchObject({ status: 'completed', noop: true });
    const workspace = modelWorkspace(app.store);
    updateModelWorkspace(app.store, {
      expectedRevision: workspace.revision,
      routes: { ...workspace.routes, main: null },
      translationPolicy: workspace.translationPolicy,
    });
    expect(await contextApi(app, chatId, 'PUT', '/context/summary', editCommand)).toEqual(saved);
    expect(await contextApi(app, chatId, 'POST', '/context/compact', compactCommand)).toMatchObject(
      { id: completed.id, status: 'completed', noop: true }
    );
    const before = await contextApi(app, chatId, 'GET', '/context');
    expect(
      await contextApi(
        app,
        chatId,
        'PUT',
        '/context/summary',
        { ...contextCommand(before), summary: '저장되면 안 되는 새 요약' },
        409
      )
    ).toMatchObject({ error: 'MODEL_REQUIRED:main' });
    expect(
      await contextApi(app, chatId, 'POST', '/context/compact', contextCommand(before), 409)
    ).toMatchObject({ error: 'MODEL_REQUIRED:main' });
    expect(await contextApi(app, chatId, 'GET', '/context')).toEqual(before);
    expect(app.store.product.attempts(chatId)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
  test('a manual job can use its entire one-call budget and its attempt survives archive restore', async () => {
    const { app, chatId } = await setup({ count: 4, short: true }),
      bodies: Body[] = [];
    recordRequests(app, bodies);
    const chat = app.store.chat(chatId);
    app.store.settings(chatId, chat.settingsRevision, { ...chat.settings, maxCalls: 1 });
    const detail = await contextApi(app, chatId, 'GET', '/context');
    const job = await contextTerminal(
      app,
      (await contextApi(app, chatId, 'POST', '/context/compact', contextCommand(detail))).id
    );
    expect(job.status, job.error ?? '').toBe('completed');
    expect(job.snapshot.contextPlan!.summaryCalls).toBe(1);
    expect(bodies).toHaveLength(1);
    const copy = await restored(app.store.product.export());
    expect(copy.context.job(job.id).snapshot.contextPlan).toEqual(job.snapshot.contextPlan);
  });
  test('an unset context model permits short main input and a no-op but blocks required compaction', async () => {
    const short = await setup({ count: 1, short: true });
    const workspace = modelWorkspace(short.app.store);
    updateModelWorkspace(short.app.store, {
      expectedRevision: workspace.revision,
      routes: workspace.routes,
      translationPolicy: workspace.translationPolicy,
      contextModel: null,
    });
    const bodies: Body[] = [];
    recordRequests(short.app, bodies);
    expect((await terminal(short.app, (await start(short.app, short.chatId)).id)).status).toBe(
      'completed'
    );
    expect(bodies.map((body) => body.role)).toEqual(['main']);
    const detail = await contextApi(short.app, short.chatId, 'GET', '/context');
    const noop = await contextTerminal(
      short.app,
      (
        await contextApi(
          short.app,
          short.chatId,
          'POST',
          '/context/compact',
          contextCommand(detail)
        )
      ).id
    );
    expect(noop.status).toBe('completed');
    expect(noop.noop).toBe(true);
    expect(bodies).toHaveLength(1);
    const long = await setup();
    const next = modelWorkspace(long.app.store);
    updateModelWorkspace(long.app.store, {
      expectedRevision: next.revision,
      routes: next.routes,
      translationPolicy: next.translationPolicy,
      contextModel: null,
    });
    const failed = await terminal(long.app, (await start(long.app, long.chatId)).id);
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('MODEL_REQUIRED:context');
    expect(bodies).toHaveLength(1);
    expect(long.app.store.product.attempts(long.chatId)).toHaveLength(0);
  });
  test('explicit notes enter both summary input and the next real main body without extraction jobs', async () => {
    const { app, chatId } = await setup({ count: 4, short: true }),
      bodies: Body[] = [];
    recordRequests(app, bodies);
    const detail = await contextApi(app, chatId, 'GET', '/context'),
      noteText = 'USER_CORRECTION_CANARY: The lighthouse is red, not blue.';
    await contextApi(app, chatId, 'POST', '/notes', {
      text: noteText,
      author: 'user',
      expectedRevision: 0,
      expectedHeadRevision: detail.headRevision,
      idempotencyKey: randomUUID(),
    });
    const manual = await contextTerminal(
      app,
      (await contextApi(app, chatId, 'POST', '/context/compact', contextCommand(detail))).id
    );
    expect(manual.status, manual.error ?? '').toBe('completed');
    expect(JSON.stringify(bodies.find((body) => body.role === 'context')?.input.source)).toContain(
      noteText
    );
    const main = await terminal(app, (await start(app, chatId)).id);
    expect(main.status, main.error ?? '').toBe('completed');
    expect(JSON.stringify(bodies.find((body) => body.role === 'main'))).toContain(noteText);
    expect(main.snapshot.story?.notes[0].text).toBe(noteText);
    expect(
      app.store.db.prepare('SELECT COUNT(*) AS n FROM story_jobs WHERE chat_id=?').get(chatId)?.n
    ).toBe(0);
  });
  test('cancelling a manual request rejects late completion and emits only one terminal event', async () => {
    const { app, chatId } = await setup({ count: 4, short: true });
    let release!: (value: Response) => void, announce!: () => void;
    const waiting = new Promise<void>((resolve) => (announce = resolve)),
      pending = new Promise<Response>((resolve) => (release = resolve));
    vi.mocked(fetch).mockImplementation(async () => {
      announce();
      return pending;
    });
    const detail = await contextApi(app, chatId, 'GET', '/context'),
      queued = await contextApi(app, chatId, 'POST', '/context/compact', contextCommand(detail));
    await waiting;
    await contextApi(app, chatId, 'POST', `/context/jobs/${queued.id}/cancel`, {});
    release(complete(summary));
    await vi.waitFor(
      () => expect(app.store.product.attempts(chatId)[0].status).not.toBe('running'),
      { timeout: 5000 }
    );
    expect(app.store.context.job(queued.id).status).toBe('cancelled');
    expect(app.store.context.detail(chatId).checkpoint).toBeNull();
    app.store.context.fail(queued.id, 'LATE_FAILURE');
    app.store.context.cancel(chatId, queued.id);
    expect(
      app.store.db
        .prepare(
          "SELECT kind FROM events WHERE entity_id=? AND kind IN ('context.job.completed','context.job.failed','context.job.cancelled')"
        )
        .all(queued.id)
        .map((row) => row.kind)
    ).toEqual(['context.job.cancelled']);
    const copy = await restored(app.store.product.export());
    expect(copy.context.job(queued.id).status).toBe('cancelled');
    expect(copy.context.detail(chatId).checkpoint).toBeNull();
  });
  test('manual compaction works below automatic threshold, repeated compact is a no-op, and neither creates a main Run', async () => {
    const { app, chatId, sources } = await setup({ count: 4, short: true }),
      bodies: Body[] = [];
    recordRequests(app, bodies);
    const before = app.store.detail(chatId).runs.length,
      detail = await contextApi(app, chatId, 'GET', '/context');
    const queued = await contextApi(
      app,
      chatId,
      'POST',
      '/context/compact',
      contextCommand(detail)
    );
    const job = await contextTerminal(app, queued.id);
    expect(job.status, job.error ?? '').toBe('completed');
    expect(job.noop).toBe(false);
    expect(job.snapshot.contextPlan!.compacted).toHaveLength(2);
    expect(job.snapshot.contextPlan!.recentSourceRevisions).toEqual(
      sources.slice(-2).map((s) => s.id)
    );
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.every((body) => body.role === 'context')).toBe(true);
    expect(app.store.detail(chatId).runs).toHaveLength(before);
    expect(app.store.chat(chatId).headRevision).toBe(sources.at(-1)!.id);
    const nextDetail = await contextApi(app, chatId, 'GET', '/context');
    expect(nextDetail.usable).toBe(true);
    const calls = bodies.length;
    const noop = await contextTerminal(
      app,
      (await contextApi(app, chatId, 'POST', '/context/compact', contextCommand(nextDetail))).id
    );
    expect(noop.status).toBe('completed');
    expect(noop.noop).toBe(true);
    expect(bodies).toHaveLength(calls);
    expect(noop.checkpoint).toEqual(job.checkpoint);
    const copy = await restored(app.store.product.export());
    expect(copy.context.detail(chatId).checkpoint?.plan.summary).toBe(summary);
    expect(copy.context.job(job.id).status).toBe('completed');
  });
  test('summary editing and restoration need no Run and exact replay creates no duplicate revision', async () => {
    const { app, chatId } = await setup({ count: 0 });
    const d = await contextApi(app, chatId, 'GET', '/context');
    const firstCommand = { ...contextCommand(d, 'edit-one'), summary: 'A user-authored summary.' };
    const first = await contextApi(app, chatId, 'PUT', '/context/summary', firstCommand);
    expect(first.activeRevision).toBe(1);
    expect(first.checkpoint.origin).toBe('edit');
    expect(first.usable).toBe(true);
    const changed = await contextApi(app, chatId, 'PUT', '/context/summary', {
      ...contextCommand(first),
      summary: 'The corrected summary.',
    });
    expect(changed.activeRevision).toBe(2);
    const replay = await contextApi(app, chatId, 'PUT', '/context/summary', firstCommand);
    expect(replay.checkpoint.id).toBe(first.checkpoint.id);
    expect(app.store.context.detail(chatId).activeRevision).toBe(2);
    const reverted = await contextApi(app, chatId, 'PUT', '/context/summary', {
      ...contextCommand(changed),
      restoreCheckpoint: {
        id: first.checkpoint.id,
        revision: first.checkpoint.revision,
        hash: first.checkpoint.hash,
      },
    });
    expect(reverted.activeRevision).toBe(3);
    expect(reverted.checkpoint.plan.summary).toBe(firstCommand.summary);
    await contextApi(
      app,
      chatId,
      'PUT',
      '/context/summary',
      { ...contextCommand(first), summary: 'Stale update' },
      409
    );
    expect(app.store.detail(chatId).runs).toEqual([]);
    expect(app.store.product.attempts(chatId)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    const copy = await restored(app.store.product.export());
    expect(copy.context.detail(chatId).checkpoint?.plan.summary).toBe(firstCommand.summary);
  });
  test('a late automatic result remains an immutable candidate after an authored summary edit wins CAS', async () => {
    const { app, chatId } = await setup();
    let release!: (value: Response) => void, announced!: () => void;
    const started = new Promise<void>((resolve) => (announced = resolve)),
      pending = new Promise<Response>((resolve) => (release = resolve));
    let delayed = false;
    vi.mocked(fetch).mockImplementation(async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      if (body.role === 'context' && !delayed) {
        delayed = true;
        announced();
        return pending;
      }
      return complete(body.role === 'context' ? summary : finalText);
    });
    const run = await start(app, chatId);
    await started;
    const detail = await contextApi(app, chatId, 'GET', '/context');
    const edited = await contextApi(app, chatId, 'PUT', '/context/summary', {
      ...contextCommand(detail),
      summary: 'User correction takes precedence as the active summary.',
    });
    release(complete(summary));
    const completed = await terminal(app, run.id);
    expect(completed.status, completed.error ?? '').toBe('completed');
    const current = await contextApi(app, chatId, 'GET', '/context');
    expect(current.checkpoint.id).toBe(edited.checkpoint.id);
    expect(current.activeRevision).toBe(edited.activeRevision);
    expect(completed.snapshot.contextPlan!.checkpoint?.id).not.toBe(edited.checkpoint.id);
    expect(
      app.store.context.checkpoint(completed.snapshot.contextPlan!.checkpoint!).activated
    ).toBe(false);
    expect(completed.snapshot.contextPlan!.summary).toBe(summary);
    const copy = await restored(app.store.product.export());
    expect(copy.run(run.id).snapshot.contextPlan).toEqual(completed.snapshot.contextPlan);
  });
  test('source-anchored notes enforce revision and head CAS, retire by replacement, and invalidate active summary reuse', async () => {
    const { app, chatId } = await setup({ count: 3, short: true });
    const base = await contextApi(app, chatId, 'GET', '/context');
    const edited = await contextApi(app, chatId, 'PUT', '/context/summary', {
      ...contextCommand(base),
      summary: 'Earlier derived summary.',
    });
    const command = {
      text: 'The lighthouse is red, as explicitly corrected by the user.',
      author: 'user',
      expectedRevision: 0,
      expectedHeadRevision: base.headRevision,
      idempotencyKey: 'note-one',
    };
    const note = await contextApi(app, chatId, 'POST', '/notes', command);
    expect(note.note.kind).toBe('author-note');
    expect(note.note.atRevision).toBe(base.headRevision);
    expect(await contextApi(app, chatId, 'POST', '/notes', command)).toEqual(note);
    const invalid = await contextApi(app, chatId, 'GET', '/context');
    expect(invalid.checkpoint.id).toBe(edited.checkpoint.id);
    expect(invalid.usable).toBe(false);
    expect(invalid.invalidReason).toBeTruthy();
    await contextApi(
      app,
      chatId,
      'POST',
      '/notes',
      { ...command, idempotencyKey: 'stale', text: 'Stale' },
      409
    );
    await contextApi(
      app,
      chatId,
      'POST',
      '/notes',
      { ...command, expectedRevision: 1, expectedHeadRevision: null, idempotencyKey: 'wrong-head' },
      409
    );
    await contextApi(app, chatId, 'POST', '/notes', {
      ...command,
      text: '',
      retired: true,
      replacesId: note.note.id,
      expectedRevision: 1,
      idempotencyKey: 'retire',
    });
    expect(app.store.story.detail(chatId).notes).toEqual([]);
    expect(app.store.story.notes.revision(chatId)).toBe(2);
    expect(
      app.store.db.prepare('SELECT COUNT(*) AS n FROM author_notes WHERE chat_id=?').get(chatId)?.n
    ).toBe(2);
    const copy = await restored(app.store.product.export());
    expect(copy.story.detail(chatId).notes).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
  test('manual checkpoints created after the selected fork point are excluded while eligible summary edits remap', async () => {
    const { app, chatId, sources } = await setup({ count: 4, short: true });
    const detail = await contextApi(app, chatId, 'GET', '/context');
    const edited = await contextApi(app, chatId, 'PUT', '/context/summary', {
      ...contextCommand(detail),
      summary: 'Eligible manual summary.',
    });
    const copy = forkChat(app.store, chatId, {
      fromRevision: sources.at(-1)!.id,
      idempotencyKey: 'copy-checkpoint',
    });
    const copied = app.store.context.detail(copy.id);
    expect(copied.checkpoint?.plan.summary).toBe('Eligible manual summary.');
    expect(copied.checkpoint?.id).not.toBe(edited.checkpoint.id);
    expect(copied.usable).toBe(true);
    expect(
      copied.checkpoint?.plan.compacted.every(
        (ref) => app.store.source(ref.revision).chatId === copy.id
      )
    ).toBe(true);
    const old = forkChat(app.store, chatId, {
      fromRevision: sources[0].id,
      idempotencyKey: 'earlier-checkpoint',
    });
    expect(app.store.context.detail(old.id).checkpoint).toBeNull();
    const restoredCopy = await restored(app.store.product.export());
    expect(restoredCopy.context.detail(copy.id).checkpoint?.plan.summary).toBe(
      'Eligible manual summary.'
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
