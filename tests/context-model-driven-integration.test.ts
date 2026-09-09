import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { updateTestProfile } from './fixtures/model-workspace.js';
import { createFixtureChat, injectWithFixtureBot } from './fixtures/chat.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createApp, type App } from '../server/app.js';
import { Store } from '../server/store.js';
import { forkChat } from '../server/chat-fork.js';
import type { ContextDetail } from '../core/context-plan.js';
import type { Connection, ModelPreset } from '../core/product.js';
import type { Run, RunSnapshot, Source, ToolEvent } from '../core/types.js';
import type { Json } from '../core/transport.js';

const endpoint = 'http://127.0.0.1:44996/turn',
  origin = 'http://127.0.0.1:44996';
const paragraph = '비 오는 항구에서 미라는 약속을 기억해요. 진실인지 아직 알 수 없어요.\n';
const workingSummary =
  'MODEL_SUMMARY_CANARY: 3장에서 미라와 선장은 화해했고, 등불 약속의 조건은 아직 정하지 않았어요.';
const finalText = '미라는 등불을 들고 부두 끝으로 걸어갔어요.';
const usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
const owned: { directory: string; app?: App; store?: Store }[] = [];
type Body = {
  role: string;
  stable: { tools: { name: string }[] };
  input: { source: Record<string, Json>; results: ToolEvent[] };
  prompt?: { messages: { content: { text: string }[] }[] };
  bootstrap?: ToolEvent[];
  opaqueState?: Json;
};
const encode = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
const sse = (...events: unknown[]) =>
  new Response(events.map(encode).join(''), { headers: { 'content-type': 'text/event-stream' } });
const complete = (text: string) =>
  sse(
    { type: 'text_delta', delta: text },
    { type: 'usage', inputTokens: 11, outputTokens: 7, costUsd: null },
    { type: 'done', reason: 'stop' }
  );
const toolTurn = (
  calls: { id: string; name: string; args: Record<string, unknown> }[],
  state: string
) =>
  sse(
    ...calls.map((call, index) => ({
      type: 'tool_delta',
      index,
      id: call.id,
      name: call.name,
      argumentsDelta: JSON.stringify(call.args),
    })),
    { type: 'usage', inputTokens: 11, outputTokens: 7, costUsd: null },
    { type: 'opaque_state', state },
    { type: 'done', reason: 'tool_calls' }
  );
const promptText = (body: Body) =>
  body.prompt!.messages.flatMap((message) => message.content.map((part) => part.text)).join('\n');
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('Unexpected network in synthetic model-driven context test')
  );
});
afterEach(async () => {
  for (const item of owned.splice(0).reverse()) {
    await item.app?.close();
    item.store?.close();
    const target = resolve(item.directory),
      within = relative(await realpath(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('uimori-context-model-')
    )
      throw new Error('Unsafe test cleanup');
    await rm(target, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});
async function directory() {
  const item: (typeof owned)[number] = {
    directory: await mkdtemp(join(await realpath(tmpdir()), 'uimori-context-model-')),
  };
  owned.push(item);
  return item;
}
async function setup(options: { count?: number; contextTools?: boolean } = {}) {
  const item = await directory();
  const app = (item.app = await createApp({
    dbPath: join(item.directory, 'story.sqlite'),
    buildId: 'synthetic-context-model-test',
    approvedOrigins: [origin],
  }));
  await app.ready();
  let chat = createFixtureChat(app.store, '합성 모델 주도 문맥 대화');
  chat = app.store.settings(chat.id, chat.settingsRevision, {
    ...chat.settings,
    translation: false,
    status: false,
    maxCalls: 8,
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
        `CHAPTER_${index}_CANARY 과거 장면 ${index}.\n${paragraph.repeat(3)}`,
        usage,
        run.snapshot.settings
      )
    );
  }
  const connection = app.store.product.connection({
    title: 'Synthetic main',
    protocol: 'fixture-sse-v1',
    endpoint,
    enabled: true,
  }) as Connection;
  const model = app.store.product.model({
    title: 'Synthetic context-tool model',
    connectionId: connection.id,
    modelId: 'synthetic-context-tool-model',
    inputTokenLimit: 32768,
    maxOutputTokens: 4096,
    temperature: null,
    ...(options.contextTools === false ? {} : { contextTools: true }),
  }) as ModelPreset;
  const profile = app.store.product.profile(chat.id);
  updateTestProfile(app.store.product, chat.id, {
    expectedRevision: profile.revision,
    attachments: [],
    routes: { main: { id: model.id }, translation: null, status: null, image: null },
    image: profile.image,
  });
  // No summary model on purpose: the model-driven path must not depend on one.
  const workspace = modelWorkspace(app.store);
  updateModelWorkspace(app.store, {
    expectedRevision: workspace.revision,
    routes: workspace.routes,
    translationPolicy: workspace.translationPolicy,
    contextModel: null,
  });
  return { app, chatId: chat.id, sources, model, connection };
}
async function start(app: App, chatId: string, request = '등불 약속을 이어서 써 주세요.') {
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
function script(rounds: ((body: Body, n: number) => Response | Promise<Response>)[]) {
  const bodies: Body[] = [];
  vi.mocked(fetch).mockImplementation(async (url, options) => {
    expect(String(url)).toBe(endpoint);
    const body = JSON.parse(String(options?.body)) as Body;
    bodies.push(body);
    expect(body.role).toBe('main');
    const round = rounds[bodies.length - 1];
    if (!round) throw new Error(`Unexpected provider round ${bodies.length}`);
    return round(body, bodies.length);
  });
  return bodies;
}
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
    url: `/api/chats/${chatId}${path}`,
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
const toolEvents = (app: App, runId: string) =>
  (
    app.store.db
      .prepare('SELECT event FROM tool_events WHERE run_id=? ORDER BY seq')
      .all(runId) as {
      event: string;
    }[]
  ).map((row) => JSON.parse(row.event) as ToolEvent);
async function restored(archive: unknown) {
  const item = await directory(),
    store = (item.store = new Store(join(item.directory, 'restored.sqlite')));
  store.product.import(archive);
  return store;
}

describe('model-written summary and window switch through the real App and file SQLite', () => {
  test('a run saves a model checkpoint, switches windows, recovers a compacted original, and the next run reuses it without a summary model', async () => {
    const { app, chatId, sources } = await setup();
    const compactedId = sources[0].id;
    const bodies = script([
      () => toolTurn([{ id: 'c1', name: 'story.list', args: {} }], 'OPAQUE_1'),
      () =>
        toolTurn(
          [{ id: 'c2', name: 'context.write', args: { summary: workingSummary } }],
          'OPAQUE_2'
        ),
      () => toolTurn([{ id: 'c3', name: 'context.new', args: { keepRecent: 2 } }], 'OPAQUE_3'),
      () =>
        toolTurn(
          [{ id: 'c4', name: 'story.read', args: { id: compactedId, limit: 30 } }],
          'OPAQUE_4'
        ),
      () => complete(finalText),
    ]);
    const run = await terminal(app, (await start(app, chatId)).id);
    expect(run.status, run.error ?? '').toBe('completed');
    expect(bodies).toHaveLength(5);
    expect(run.usage.modelCalls).toBe(5);
    expect(app.store.product.attempts(chatId).map((attempt) => attempt.role)).toEqual(
      Array(5).fill('main')
    );
    // The frozen run input is untouched; the model's mid-run work lives in tool events and checkpoints.
    expect(run.snapshot.contextPlan).toMatchObject({
      status: 'ready',
      compacted: [],
      summary: null,
      summaryCalls: 0,
    });
    const events = toolEvents(app, run.id);
    expect(events.map((event) => event.name)).toEqual([
      'story.list',
      'context.write',
      'context.new',
      'story.read',
    ]);
    expect(events[1].result).toMatchObject({ saved: true, activated: true });
    expect(events[2].result).toMatchObject({
      switched: true,
      compactedExchanges: 3,
      retained: sources.slice(-2).map((source) => source.id),
      droppedToolResults: 2,
      activated: true,
    });
    const reread = events[3].result as { text: string; source: { revision: string } };
    expect(reread.source.revision).toBe(compactedId);
    expect(sources[0].text.startsWith(reread.text)).toBe(true);
    expect(reread.text).toContain('CHAPTER_0_CANARY');
    const fresh = bodies[3];
    expect(fresh).not.toHaveProperty('opaqueState');
    expect(fresh.input.results).toEqual([]);
    expect(fresh.bootstrap!.map((item) => item.name)).toEqual(['context.new']);
    for (const index of [0, 1, 2])
      expect(promptText(fresh)).not.toContain(`CHAPTER_${index}_CANARY`);
    for (const index of [3, 4]) expect(promptText(fresh)).toContain(`CHAPTER_${index}_CANARY`);
    expect(promptText(fresh)).toContain(workingSummary);
    expect(promptText(bodies[0])).toContain('CHAPTER_0_CANARY');
    expect(bodies[0].stable.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['context.read', 'context.write', 'context.new', 'story.list'])
    );
    const detail = (await contextApi(app, chatId, 'GET', '/context')) as ContextDetail;
    expect(detail.activeRevision).toBe(2);
    expect(detail.usable).toBe(true);
    expect(detail.checkpoint).toMatchObject({
      origin: 'model',
      revision: 2,
      activated: true,
      plan: { summary: workingSummary, summaryCalls: 0 },
    });
    expect(detail.checkpoint!.plan.compacted.map((ref) => ref.revision)).toEqual(
      sources.slice(0, 3).map((source) => source.id)
    );
    expect(
      detail.checkpoints.map((entry) => [entry.origin, entry.revision, entry.activated])
    ).toEqual([
      ['model', 2, true],
      ['model', 1, true],
    ]);
    for (const source of sources)
      expect(app.store.sourceOriginal(source.id).text).toBe(source.text);
    // Next run: the model checkpoint is the active input; no summary model is configured or called.
    const nextBodies = script([() => complete('다음 장면.')]);
    const next = await terminal(app, (await start(app, chatId, '다음 장면을 써 주세요.')).id);
    expect(next.status, next.error ?? '').toBe('completed');
    expect(next.snapshot.contextPlan).toMatchObject({
      summary: workingSummary,
      summaryCalls: 0,
      checkpoint: { id: detail.checkpoint!.id },
    });
    expect(next.snapshot.contextPlan!.compacted).toHaveLength(3);
    expect(next.snapshot.contextPlan!.recentSourceRevisions).toEqual([
      ...sources.slice(-2).map((source) => source.id),
      run.sourceRevision,
    ]);
    expect(nextBodies).toHaveLength(1);
    expect(promptText(nextBodies[0])).toContain(workingSummary);
    expect(promptText(nextBodies[0])).not.toContain('CHAPTER_0_CANARY');
    expect(promptText(nextBodies[0])).toContain('CHAPTER_4_CANARY');
    expect(nextBodies[0].input.source.contextWindow).toMatchObject({
      compactedExchanges: 3,
      retainedExchanges: 3,
    });
    // Archive round trip and fork keep the model checkpoint as an ordinary immutable checkpoint.
    const copy = await restored(JSON.parse(JSON.stringify(app.store.product.export())));
    expect(copy.context.detail(chatId).checkpoint).toMatchObject({
      origin: 'model',
      plan: { summary: workingSummary },
    });
    expect(copy.run(next.id).snapshot.contextPlan).toEqual(next.snapshot.contextPlan);
    const fork = forkChat(app.store, chatId, {
      fromRevision: next.sourceRevision,
      idempotencyKey: randomUUID(),
    });
    const forkDetail = app.store.context.detail(fork.id);
    expect(forkDetail.checkpoint).toMatchObject({
      origin: 'model',
      plan: { summary: workingSummary },
    });
    expect(
      forkDetail.checkpoint!.plan.compacted.every(
        (ref) => app.store.source(ref.revision).chatId === fork.id
      )
    ).toBe(true);
  });

  test('a user summary edit during the run wins CAS: the late model write stays an inactive candidate', async () => {
    const { app, chatId } = await setup({ count: 3 });
    let edited!: ContextDetail;
    script([
      async () => {
        const detail = (await contextApi(app, chatId, 'GET', '/context')) as ContextDetail;
        edited = (await contextApi(app, chatId, 'PUT', '/context/summary', {
          expectedRevision: detail.activeRevision,
          expectedHeadRevision: detail.headRevision,
          idempotencyKey: randomUUID(),
          summary: 'USER_SUMMARY_CANARY: 사용자가 정한 요약이 우선이에요.',
        })) as ContextDetail;
        return toolTurn(
          [{ id: 'c1', name: 'context.write', args: { summary: workingSummary } }],
          'OPAQUE_1'
        );
      },
      () => complete(finalText),
    ]);
    const run = await terminal(app, (await start(app, chatId)).id);
    expect(run.status, run.error ?? '').toBe('completed');
    const events = toolEvents(app, run.id);
    expect(events[0].result).toMatchObject({ saved: true, activated: false });
    const current = (await contextApi(app, chatId, 'GET', '/context')) as ContextDetail;
    expect(current.checkpoint!.id).toBe(edited.checkpoint!.id);
    expect(current.checkpoint!.origin).toBe('edit');
    const candidate = current.checkpoints.find((entry) => entry.origin === 'model')!;
    expect(candidate).toMatchObject({ activated: false, plan: { summary: workingSummary } });
    const bodies = script([() => complete('다음 장면.')]);
    const next = await terminal(app, (await start(app, chatId, '다음 장면을 써 주세요.')).id);
    expect(next.status, next.error ?? '').toBe('completed');
    expect(next.snapshot.contextPlan!.summary).toContain('USER_SUMMARY_CANARY');
    expect(promptText(bodies[0])).toContain('USER_SUMMARY_CANARY');
    expect(promptText(bodies[0])).not.toContain('MODEL_SUMMARY_CANARY');
  });

  test('the preset flag is validated, frozen into the run, and absent by default', async () => {
    const { app, chatId, connection, model } = await setup({ count: 1, contextTools: false });
    expect(app.store.product.modelSnapshot(model.id)).not.toHaveProperty('contextTools');
    expect(() =>
      app.store.product.model({
        title: 'Invalid flag',
        connectionId: connection.id,
        modelId: 'synthetic-invalid',
        maxOutputTokens: 1024,
        temperature: null,
        contextTools: 'yes',
      })
    ).toThrow();
    const enabled = app.store.product.model(
      {
        title: model.title,
        connectionId: connection.id,
        modelId: model.modelId,
        maxOutputTokens: model.maxOutputTokens,
        temperature: null,
        inputTokenLimit: 32768,
        contextTools: true,
        expectedRevision: model.revision,
      },
      model.id
    ) as ModelPreset;
    expect(enabled.contextTools).toBe(true);
    const bodies = script([() => complete(finalText)]);
    const run = await terminal(app, (await start(app, chatId)).id);
    expect(run.status, run.error ?? '').toBe('completed');
    expect(run.snapshot.profile!.models.main!.contextTools).toBe(true);
    expect(bodies[0].stable.tools.map((tool) => tool.name)).toContain('context.new');
    const disabled = app.store.product.model(
      {
        title: model.title,
        connectionId: connection.id,
        modelId: model.modelId,
        maxOutputTokens: model.maxOutputTokens,
        temperature: null,
        inputTokenLimit: 32768,
        contextTools: false,
        expectedRevision: enabled.revision,
      },
      model.id
    ) as ModelPreset;
    expect(disabled).not.toHaveProperty('contextTools');
    expect(run.snapshot.profile!.models.main!.contextTools).toBe(true);
  });
});
