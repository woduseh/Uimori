import { observeExecutions, observedExecution } from './fixtures/execution-observer.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { updateTestProfile } from './fixtures/model-workspace.js';
import { createFixtureChat, injectWithFixtureBot, setFixtureModelRoutes } from './fixtures/chat.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createApp, type App } from '../server/app.js';
import { Store } from '../server/store.js';
import type { ContextDetail } from '../core/context-plan.js';
import type { Connection, ModelPreset } from '../core/product.js';
import type { Run, RunSnapshot, Source, ToolEvent } from '../core/types.js';
import type { Json } from '../core/transport.js';

const endpoint = 'http://127.0.0.1:44996/turn',
  _origin = 'http://127.0.0.1:44996';
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
  }));
  await app.ready();
  observeExecutions(app.store);
  let chat = createFixtureChat(app.store, '합성 모델 주도 문맥 대화');
  chat = app.store.settings(chat.id, chat.settingsRevision, {
    ...chat.settings,
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
    routes: { main: { id: model.id }, translation: null, status: null },
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
      run = observedExecution(app.store, id);
      expect(['queued', 'running']).not.toContain(run.status);
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
const toolEvents = (app: App, runId: string) => observedExecution(app.store, runId).toolEvents;

describe('model-written summary and window switch through the real App and file SQLite', () => {
  test('Anthropic context.new bootstrap uses its declared wire name through HTTP admission and saved Reader output', async () => {
    const { app, chatId, sources } = await setup({ count: 3 });
    const api = async (url: string, payload?: unknown) => {
      const response = await app.inject({
        method: payload === undefined ? 'GET' : 'POST',
        url,
        headers: { host: '127.0.0.1', 'content-type': 'application/json' },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json();
    };
    const key = 'synthetic-anthropic-context-key';
    const connection = await api('/api/connections', {
      title: 'Native Anthropic fixture',
      protocol: 'anthropic-messages-v1',
      endpoint: 'http://127.0.0.1:44996/v1',
      enabled: true,
      apiKey: key,
    });
    const model = await api('/api/model-presets', {
      title: 'Native context tools',
      connectionId: connection.id,
      modelId: 'claude-opus-5',
      inputTokenLimit: 32768,
      maxOutputTokens: 4096,
      temperature: null,
      contextTools: true,
    });
    expect(JSON.stringify(await api(`/api/connections/${connection.id}`))).not.toContain(key);
    expect((await api(`/api/model-presets/${model.id}`)).contextTools).toBe(true);
    await setFixtureModelRoutes(app, { main: { id: model.id }, translation: null, status: null });
    expect(fetch).not.toHaveBeenCalled();

    type NativeTool = {
      name: string;
      input_schema: {
        type: string;
        properties: Record<string, Json>;
        additionalProperties: boolean;
      };
    };
    type NativeBlock = {
      type: string;
      id?: string;
      name?: string;
      input?: Json;
      tool_use_id?: string;
      content?: string;
    };
    type NativeBody = {
      tools: NativeTool[];
      messages: { role: string; content: NativeBlock[] }[];
      model: string;
    };
    const bodies: NativeBody[] = [];
    const violations: string[] = [];
    vi.mocked(fetch).mockImplementation(async (url, options) => {
      expect(String(url)).toBe('http://127.0.0.1:44996/v1/messages');
      expect(new Headers(options?.headers).get('x-api-key')).toBe(key);
      const body = JSON.parse(String(options?.body)) as NativeBody;
      bodies.push(body);
      expect(body.model).toBe('claude-opus-5');
      const declaration = body.tools.find((tool) => 'keepRecent' in tool.input_schema.properties)!;
      expect(declaration.input_schema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        properties: { keepRecent: { type: 'integer', minimum: 0 }, summary: { type: 'string' } },
      });
      const declaredNames = new Set(body.tools.map((tool) => tool.name));
      // Anthropic's client-tool contract (2026-09-26), independently enforced by this fixture.
      // https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools#specifying-client-tools
      for (const tool of body.tools) expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,128}$/u);
      const uses = body.messages.flatMap((message) =>
        message.content.filter((part) => part.type === 'tool_use')
      );
      for (const use of uses) {
        if (!use.name || !/^[a-zA-Z0-9_-]{1,128}$/u.test(use.name) || !declaredNames.has(use.name))
          violations.push(`Invalid or undeclared Anthropic tool_use name: ${use.name}`);
      }
      if (violations.length)
        return new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: violations.at(-1) },
          }),
          { status: 400 }
        );
      const first = bodies.length === 1;
      expect(bodies.length).toBeLessThanOrEqual(2);
      if (first) expect(uses).toEqual([]);
      else {
        expect(uses).toEqual([
          {
            type: 'tool_use',
            id: 'native-context-switch',
            name: declaration.name,
            input: { keepRecent: 1, summary: workingSummary },
          },
        ]);
        expect(body.messages[0].role).toBe('assistant');
        expect(body.messages[1].role).toBe('user');
        const result = body.messages[1].content[0];
        expect(result).toMatchObject({ type: 'tool_result', tool_use_id: 'native-context-switch' });
        expect(JSON.parse(result.content!)).toMatchObject({
          switched: true,
          compactedExchanges: 2,
          retained: [{ sceneNumber: 3, revision: sources[2].id }],
        });
        expect(body.tools).toEqual(bodies[0].tools);
        expect(JSON.stringify(body.messages)).toContain(workingSummary);
        expect(JSON.stringify(body.messages)).not.toContain('CHAPTER_0_CANARY');
      }
      return sse(
        {
          type: 'message_start',
          message: {
            id: `native-${bodies.length}`,
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 11, output_tokens: 0 },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: first
            ? { type: 'tool_use', id: 'native-context-switch', name: declaration.name, input: {} }
            : { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: first
            ? {
                type: 'input_json_delta',
                partial_json: JSON.stringify({ keepRecent: 1, summary: workingSummary }),
              }
            : { type: 'text_delta', text: finalText },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: first ? 'tool_use' : 'end_turn', stop_sequence: null },
          usage: { output_tokens: 7 },
        },
        { type: 'message_stop' }
      );
    });
    const run = await terminal(app, (await start(app, chatId)).id);
    expect(violations).toEqual([]);
    expect(run.status, run.error ?? '').toBe('completed');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(toolEvents(app, run.id)).toMatchObject([
      { name: 'context.new', denied: false, result: { switched: true } },
    ]);
    expect(toolEvents(app, run.id)).toHaveLength(1);
    expect(
      app.store.db.prepare('SELECT COUNT(*) AS count FROM sources WHERE run_id=?').get(run.id)
    ).toEqual({ count: 1 });
    expect(app.store.source(run.sourceRevision!).text).toBe(finalText);
    const reader = await api(`/api/chats/${chatId}/reader`);
    expect(reader.sources.find((source: Source) => source.id === run.sourceRevision)?.text).toBe(
      finalText
    );
    expect(reader.runs.find((entry: Run) => entry.id === run.id)?.status).toBe('completed');
    expect(fetch).toHaveBeenCalledTimes(2);
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
    expect(current).not.toHaveProperty('checkpoints');
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
