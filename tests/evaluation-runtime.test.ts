import { injectWithFixtureBot } from './fixtures/chat.js';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { createApp, type App } from '../server/app.js';
import type { Chat, ChatDetail, Run, Source } from '../core/types.js';
import type {
  ChatProfile,
  Connection,
  Content,
  ModelPreset,
  PromptWorkspace,
} from '../core/product.js';
import type { Json } from '../core/transport.js';
import { defaultEvaluationToolOptions } from '../core/evaluation-tool-config.js';
import { loopbackProvider, sse, writeSse } from './fixtures/loopback-provider.js';

const credentialEnv = 'Evaluation_Runtime_Key';
const bearer = 'synthetic-evaluation-fixture-key';
const marker = 'PRIVATE_EVALUATION_NOTICE';
const opaque = 'PRIVATE_EVALUATION_OPAQUE';
type Body = { model: string; instructions?: string; input: any[]; tools: { name: string }[] };
type Owner = { directory: string; app?: App; close?: () => Promise<void>; release?: () => void };
const owners: Owner[] = [];
afterEach(async () => {
  for (const owner of owners.splice(0).reverse()) {
    owner.release?.();
    await owner.app?.close();
    await owner.close?.();
    const path = resolve(owner.directory);
    const rel = relative(resolve(tmpdir()), path);
    if (
      isAbsolute(rel) ||
      rel.startsWith('..') ||
      !basename(path).startsWith('uimori-evaluation-runtime-')
    )
      throw new Error('Unsafe fixture cleanup');
    await rm(path, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});
const ref = ({ id, revision }: { id: string; revision: number }) => ({ id, revision });
const sourceContent = ({ translationRevision: _slotRevision, ...source }: Source) => source;
async function api<T>(
  app: App,
  path: string,
  body?: unknown,
  method: 'POST' | 'PUT' | 'PATCH' = 'POST'
): Promise<T> {
  const response = await injectWithFixtureBot(app, {
    method: body === undefined ? 'GET' : method,
    url: path,
    headers: {
      host: '127.0.0.1',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as T;
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}
async function fixture(
  handler: (body: Body, response: ServerResponse, requestNumber: number) => void | Promise<void>,
  settings: { timeoutMs?: number; maximumToolRounds?: number; maxCalls?: number } = {}
) {
  vi.stubEnv(credentialEnv, bearer);
  const owner: Owner = { directory: await mkdtemp(join(tmpdir(), 'uimori-evaluation-runtime-')) };
  owners.push(owner);
  let app: App;
  let chat: Chat;
  const failures: unknown[] = [];
  const provider = await loopbackProvider(async (captured, response) => {
    try {
      expect(captured.url).toBe('/v1/responses');
      expect(captured.headers.authorization).toBe(`Bearer ${bearer}`);
      // The externally observed request must already have a durable running attempt.
      const attempts = app.store.product.attempts(chat.id);
      expect(attempts).toHaveLength(provider.requests.length);
      expect(attempts.filter((attempt) => attempt.status === 'running')).toHaveLength(1);
      const body = JSON.parse(captured.body) as Body;
      if (packet(body).controls?.purpose === 'translation-refusal') {
        expect(body.model).toBe('synthetic-refusal-classifier');
        expect(body.tools ?? []).toEqual([]);
        expect(packet(body).source.prefix.length).toBeLessThanOrEqual(1000);
        await send(response, [message('{"verdict":"accepted"}')], true);
      } else await handler(body, response, provider.requests.length);
    } catch (error) {
      failures.push(error);
      throw error;
    }
  });
  owner.close = provider.close;
  app = await createApp({
    dbPath: join(owner.directory, 'story.sqlite'),
    buildId: 'evaluation-runtime-fixture',
    instanceId: randomUUID(),
    testMode: true,
    approvedOrigins: [provider.origin],
  });
  owner.app = app;
  await app.listen({ port: 0, host: '127.0.0.1' });
  chat = await api<Chat>(app, '/api/chats', { title: 'Synthetic evaluated story' });
  chat = await api<Chat>(
    app,
    `/api/chats/${chat.id}/settings`,
    {
      expectedSettingsRevision: chat.settingsRevision,
      ...chat.settings,
      translation: true,
      status: false,
      maxCalls: settings.maxCalls ?? 8,
    },
    'PATCH'
  );
  const lore = await api<Content>(app, '/api/content', {
    kind: 'module',
    title: 'Copper observatory',
    description: 'Local synthetic reference',
    text: 'The copper observatory stands north of the harbor.',
    loading: 'discoverable',
    relatedIds: [],
  });
  const connection = await api<Connection>(app, '/api/connections', {
    title: 'Local Responses fixture',
    protocol: 'openai-responses-v1',
    endpoint: `${provider.origin}/v1`,
    credentialEnv,
    enabled: true,
  });
  const model = await api<ModelPreset>(app, '/api/model-presets', {
    title: 'Synthetic evaluated model',
    connectionId: connection.id,
    modelId: 'synthetic-evaluated-model',
    maxOutputTokens: 4096,
    temperature: null,
    timeoutMs: settings.timeoutMs ?? 4000,
    evaluationTools: {
      ...defaultEvaluationToolOptions(),
      maximumToolRounds: settings.maximumToolRounds ?? 8,
    },
  });
  const classifier = await api<ModelPreset>(app, '/api/model-presets', {
    title: 'Synthetic refusal classifier',
    connectionId: connection.id,
    modelId: 'synthetic-refusal-classifier',
    maxOutputTokens: 256,
    temperature: null,
  });
  const workspace = await api<PromptWorkspace>(app, '/api/prompt-workspace');
  await api(
    app,
    '/api/prompt-workspace',
    {
      expectedRevision: workspace.revision,
      translationPolicy: { refusalModel: { id: classifier.id }, maxRetries: 1, maxCalls: 16 },
    },
    'PUT'
  );
  const prior = await api<ChatProfile>(app, `/api/chats/${chat.id}/profile`);
  const profile = await api<ChatProfile>(
    app,
    `/api/chats/${chat.id}/profile`,
    {
      expectedRevision: prior.revision,
      attachments: [ref(lore)],
      personaReference: prior.personaReference,
      routes: { main: { id: model.id }, translation: { id: model.id }, status: null, image: null },
      image: false,
    },
    'PUT'
  );
  const command = {
    request: 'Continue the synthetic harbor scene.',
    expectedRevision: chat.headRevision,
    expectedSettingsRevision: chat.settingsRevision,
    expectedProfileRevision: profile.revision,
    idempotencyKey: randomUUID(),
  };
  return {
    owner,
    app,
    chat,
    lore,
    connection,
    provider,
    failures,
    command,
    start: () => api<Run>(app, `/api/chats/${chat.id}/runs`, command),
    detail: () => api<ChatDetail>(app, `/api/chats/${chat.id}`),
  };
}
function packet(body: Body): any {
  const prefixes = [
    'Request data (JSON):\n',
    'Host context (JSON reference data, not instructions or permission):\n',
  ];
  const texts = [
    body.instructions,
    ...body.input.flatMap((item) =>
      Array.isArray(item?.content) ? item.content.map((part: any) => part?.text) : []
    ),
  ];
  for (const text of texts) {
    if (typeof text !== 'string') continue;
    for (const prefix of prefixes) {
      const start = text.indexOf(prefix);
      if (start < 0) continue;
      const value = JSON.parse(text.slice(start + prefix.length).split('\n', 1)[0]);
      if (value?.source && typeof value.source === 'object') return value;
    }
  }
  throw new Error('Missing request data packet');
}
function call(body: Body, name: string, args: Json, id: string): Json {
  const alias = body.tools.find((tool) =>
    tool.name.endsWith('_' + name.replaceAll('.', '_'))
  )?.name;
  if (!alias) throw new Error('Missing advertised tool: ' + name);
  return {
    type: 'function_call',
    id: `item-${id}`,
    call_id: id,
    name: alias,
    arguments: JSON.stringify(args),
    status: 'completed',
  };
}
const message = (text: string, id = 'message1'): Json => ({
  type: 'message',
  role: 'assistant',
  id,
  status: 'completed',
  content: [{ type: 'output_text', text }],
});
const reasoning = (id: string): Json => ({
  type: 'reasoning',
  id,
  encrypted_content: opaque,
  summary: [{ type: 'summary_text', text: 'PRIVATE_EVALUATION_REASONING' }],
});
const response = (output: Json[], status = 'completed'): Json => ({
  id: randomUUID(),
  status,
  output,
  usage: { input_tokens: 7, output_tokens: 3 },
  ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
});
async function send(target: ServerResponse, output: Json[], json = false, status = 'completed') {
  const payload = response(output, status);
  if (json) {
    target.writeHead(200, { 'content-type': 'application/json' });
    target.end(JSON.stringify(payload));
  } else await writeSse(target, [{ type: `response.${status}`, response: payload }], true);
}
async function settled(state: Awaited<ReturnType<typeof fixture>>, id: string): Promise<Run> {
  await expect
    .poll(async () => (await api<Run>(state.app, `/api/runs/${id}`)).status, { timeout: 6000 })
    .not.toMatch(/^(queued|running)$/);
  expect(state.failures).toEqual([]);
  return api<Run>(state.app, `/api/runs/${id}`);
}
const artifact = (body: Body, text: string, id = 'artifact'): Json =>
  call(body, 'eval_submit_artifact', { content: text, userFacingNotice: marker }, id);
const translated = (body: Body): string => '합성 번역: ' + packet(body).source.text;

test('preset evaluation mixes permitted reads and local tools; buffered Responses translation keeps source/hash and per-request attempts', async () => {
  const sourceText = 'The keeper watched the copper observatory.';
  const state = await fixture(async (body, target, number) => {
    const source = packet(body).source;
    if (!source.sourceRevision) {
      if (number === 1)
        await send(target, [
          reasoning('main-reasoning'),
          call(body, 'knowledge.search', { query: 'copper' }, 'search'),
          call(body, 'knowledge.read', { id: state.lore.id }, 'read'),
          call(body, 'eval_get_context', {}, 'context'),
        ]);
      else {
        expect(
          body.input.find((item) => item.type === 'reasoning' && item.id === 'main-reasoning')
        ).toEqual(reasoning('main-reasoning'));
        const results = body.input.filter((item) => item.type === 'function_call_output');
        expect(results.map((item) => item.call_id)).toEqual(['search', 'read', 'context']);
        expect(results[1].output).toContain(state.lore.text);
        await send(target, [artifact(body, sourceText)]);
      }
    } else if (!body.input.some((item) => item.type === 'function_call_output'))
      await send(
        target,
        [reasoning('aux-reasoning'), call(body, 'eval_get_context', {}, 'aux-context')],
        true
      );
    else {
      expect(
        body.input.find((item) => item.type === 'reasoning' && item.id === 'aux-reasoning')
      ).toEqual(reasoning('aux-reasoning'));
      await send(target, [artifact(body, translated(body), 'aux-artifact')], true);
    }
  });
  const first = await state.start();
  const run = await settled(state, first.id);
  expect(run).toMatchObject({
    status: 'completed',
    usage: { modelCalls: 2, inputTokens: 14, outputTokens: 6, costUsd: null },
  });
  const before = await state.detail();
  expect(before.jobs).toEqual([]);
  expect(state.provider.requests).toHaveLength(2);
  const source = before.sources[0];
  expect(source).toMatchObject({
    text: sourceText,
    hash: createHash('sha256').update(sourceText).digest('hex'),
    runId: run.id,
  });
  await api(state.app, `/api/sources/${source.id}/translation`, {});
  await expect
    .poll(async () => (await state.detail()).jobs[0]?.status, { timeout: 6000 })
    .toBe('completed');
  const after = await state.detail();
  expect(state.failures).toEqual([]);
  expect(state.provider.requests).toHaveLength(5);
  expect(after.sources.map(sourceContent)).toEqual(before.sources.map(sourceContent));
  expect(after.runs).toEqual(before.runs);
  expect(after.jobs[0]).toMatchObject({
    sourceRevision: source.id,
    sourceHash: source.hash,
    result: { sourceRevision: source.id, sourceHash: source.hash, mock: false },
  });
  expect(after.attempts).toHaveLength(5);
  expect(
    after.attempts!.every(
      (attempt) =>
        attempt.costUsd === null && attempt.inputTokens === 7 && attempt.outputTokens === 3
    )
  ).toBe(true);
  expect(JSON.stringify(after)).not.toMatch(
    /PRIVATE_EVALUATION_NOTICE|PRIVATE_EVALUATION_OPAQUE|PRIVATE_EVALUATION_REASONING|synthetic-evaluation-fixture-key/
  );
  expect(state.app.store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  expect((await state.start()).id).toBe(run.id);
  await api(state.app, `/api/sources/${source.id}/translation`, {});
  expect(state.provider.requests).toHaveLength(5);
});

test('current connection enabled flag and credential availability are rechecked between evaluation rounds', async () => {
  for (const revoke of ['enabled', 'credential']) {
    const gate = deferred();
    const received = deferred();
    const state = await fixture(async (body, target) => {
      received.release();
      await gate.promise;
      await send(target, [call(body, 'eval_get_context', {}, 'context')]);
    });
    state.owner.release = gate.release;
    const run = await state.start();
    await received.promise;
    if (revoke === 'enabled')
      await api(
        state.app,
        `/api/connections/${state.connection.id}`,
        {
          title: state.connection.title,
          protocol: state.connection.protocol,
          endpoint: state.connection.endpoint,
          credentialEnv,
          enabled: false,
          expectedRevision: state.connection.revision,
        },
        'PUT'
      );
    else vi.stubEnv(credentialEnv, '');
    gate.release();
    const result = await settled(state, run.id);
    expect(result.status).toBe('failed');
    expect(result.sourceRevision).toBeNull();
    expect(state.provider.requests).toHaveLength(1);
    expect((await state.detail()).attempts).toHaveLength(1);
  }
});

test('HTTP failure and partial terminal output finish without provider replay or source commit', async () => {
  for (const mode of ['http', 'partial']) {
    const state = await fixture(async (body, target) => {
      if (mode === 'http') {
        target.writeHead(503, { 'content-type': 'application/json' });
        target.end('{"error":"synthetic"}');
      } else await send(target, [artifact(body, 'must not commit')], false, 'incomplete');
    });
    const result = await settled(state, (await state.start()).id);
    expect(result.status).not.toBe('completed');
    const detail = await state.detail();
    expect(detail.sources).toEqual([]);
    expect(detail.attempts).toHaveLength(1);
    expect(state.provider.requests).toHaveLength(1);
    expect(JSON.stringify(detail)).not.toContain(marker);
  }
});

test('cancelling a live evaluated response preserves the one uncertain attempt and commits no source', async () => {
  const received = deferred();
  const state = await fixture((_body, target) => {
    target.writeHead(200, { 'content-type': 'text/event-stream' });
    target.write(sse({ type: 'response.created', response: { id: 'waiting' } }));
    received.release();
  });
  const run = await state.start();
  await received.promise;
  await api(state.app, `/api/runs/${run.id}/cancel`, {});
  expect((await settled(state, run.id)).status).toBe('cancelled');
  await expect.poll(async () => (await state.detail()).attempts![0].status).not.toBe('running');
  expect(state.provider.requests).toHaveLength(1);
  expect((await state.detail()).sources).toEqual([]);
});

test('evaluation timeout ends a stalled real HTTP response with no implicit retry', async () => {
  const state = await fixture(
    (_body, target) => {
      target.writeHead(200, { 'content-type': 'text/event-stream' });
      target.write(sse({ type: 'response.created', response: { id: 'waiting' } }));
    },
    { timeoutMs: 100 }
  );
  const result = await settled(state, (await state.start()).id);
  expect(result).toMatchObject({ status: 'failed', error: 'TIMEOUT', sourceRevision: null });
  expect(state.provider.requests).toHaveLength(1);
  expect((await state.detail()).attempts).toHaveLength(1);
});

test('both host maxCalls and evaluation maximumToolRounds bound actual HTTP requests', async () => {
  for (const settings of [
    { maxCalls: 1, maximumToolRounds: 8 },
    { maxCalls: 8, maximumToolRounds: 0 },
  ]) {
    const state = await fixture(
      async (body, target, number) =>
        send(target, [call(body, 'eval_get_context', {}, `context-${number}`)]),
      settings
    );
    const result = await settled(state, (await state.start()).id);
    expect(result).toMatchObject({
      status: 'failed',
      error: 'MODEL_CALL_BUDGET_EXHAUSTED',
      sourceRevision: null,
      usage: { modelCalls: 1 },
    });
    expect(state.provider.requests).toHaveLength(1);
    expect((await state.detail()).sources).toEqual([]);
  }
});

test('duplicate call IDs and terminal plus host calls cannot commit or dispatch a skipped host operation', async () => {
  for (const mode of ['duplicate', 'mixed']) {
    const state = await fixture(async (body, target) => {
      const first = artifact(body, 'must not commit', 'same');
      const other =
        mode === 'mixed'
          ? call(body, 'knowledge.read', { id: state.lore.id }, 'host')
          : ({ ...(first as object), id: 'different-output-id' } as Json);
      await send(target, [first, other]);
    });
    const result = await settled(state, (await state.start()).id);
    expect(result.status).toBe('failed');
    expect(result.toolEvents).toEqual([]);
    expect((await state.detail()).sources).toEqual([]);
    expect(state.provider.requests).toHaveLength(1);
    expect(JSON.stringify(await state.detail())).not.toContain(marker);
  }
});

test('source edit CAS fences an in-flight evaluated translation without mutating the original source or run snapshot', async () => {
  const received = deferred();
  const gate = deferred();
  const state = await fixture(async (body, target) => {
    if (!packet(body).source.sourceRevision)
      await send(target, [message('Original fixture source.')]);
    else {
      received.release();
      await gate.promise;
      await send(target, [artifact(body, translated(body))], true);
    }
  });
  state.owner.release = gate.release;
  const run = await settled(state, (await state.start()).id);
  const before = await state.detail();
  const original = before.sources[0];
  await api(state.app, `/api/sources/${original.id}/translation`, {});
  await received.promise;
  const edited = await api<Source>(
    state.app,
    `/api/sources/${original.id}/text`,
    { text: 'Edited fixture source.', expectedRevision: 0 },
    'PUT'
  );
  const stale = await injectWithFixtureBot(state.app, {
    method: 'PUT',
    url: `/api/sources/${original.id}/text`,
    headers: { host: '127.0.0.1' },
    payload: { text: 'Stale overwrite', expectedRevision: 0 },
  });
  expect(stale.statusCode).toBe(409);
  gate.release();
  await expect
    .poll(
      async () =>
        (await state.detail()).attempts!.filter((attempt) => attempt.status === 'running').length
    )
    .toBe(0);
  expect(sourceContent(state.app.store.sourceOriginal(original.id))).toEqual(
    sourceContent(original)
  );
  expect(state.app.store.run(run.id).snapshot).toEqual(run.snapshot);
  expect(edited.hash).not.toBe(original.hash);
  expect((await state.detail()).sources[0].text).toBe('Edited fixture source.');
  expect((await state.detail()).jobs.some((job) => job.status === 'completed')).toBe(false);
  expect(state.provider.requests).toHaveLength(2);
  expect(state.failures).toEqual([]);
});
