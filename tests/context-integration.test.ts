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
async function setup(options: { evaluated?: boolean; count?: number } = {}) {
  const item = await directory();
  const app = (item.app = await createApp({
    dbPath: join(item.directory, 'story.sqlite'),
    buildId: 'synthetic-context-test',
    approvedOrigins: [origin],
  }));
  await app.ready();
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
        `과거 장면 ${index}.\n${paragraph.repeat(60)}`,
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
  app.store.product.updateProfile(chat.id, {
    expectedRevision: profile.revision,
    attachments: [],
    personaReference: profile.personaReference,
    routes: { main: { id: model.id }, translation: null, status: null, image: null },
    image: profile.image,
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
  ) => complete(body.role === 'memory' ? summary : finalText)
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
    const summaries = bodies.filter((body) => body.role === 'memory'),
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
      ...summaries.map(() => 'memory'),
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
    const summaries = bodies.filter((body) => body.role === 'memory');
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
      expect(body.role).toBe('memory');
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
    expect(bodies.map((body) => body.role)).toEqual(['memory']);
  });

  test('an edit while summary completes prevents the main call and retains its incurred attempt', async () => {
    const { app, chatId, sources } = await setup(),
      bodies: Body[] = [];
    let release!: (response: Response) => void;
    recordRequests(app, bodies, (body) => {
      expect(body.role).toBe('memory');
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
    ).toMatchObject([{ role: 'memory', status: 'completed' }]);
    expect(bodies.map((body) => body.role)).toEqual(['memory']);
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
