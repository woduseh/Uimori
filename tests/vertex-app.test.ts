import type { Job } from '../core/types.js';
import { readStoredRunSnapshot } from '../server/run-projections.js';
import { installJevFixture, configureJevFixture } from './fixtures/jev.js';
import { injectWithFixtureBot, fixtureBotInput } from './fixtures/chat.js';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp, type App } from '../server/app.js';
import type { Chat, ChatDetail, Run, RunSnapshot } from '../core/types.js';
import type {
  ChatProfile,
  Connection,
  Content,
  ModelPreset,
  PromptWorkspace,
} from '../core/product.js';
import type { SourceTimeContext } from '../core/auxiliary.js';
import type { Json } from '../core/transport.js';
import { loopbackProvider, sse, writeSse } from './fixtures/loopback-provider.js';
import { translationFixtureRenderedSlot } from './fixtures/translation-job.js';

const origin = 'https://aiplatform.googleapis.com';
const endpoint = `${origin}/v1/projects/synthetic-project/locations/global/publishers/google/models`;
const providerUrl = `${endpoint}/gemini-3.8-flash:streamGenerateContent?alt=sse`;
const fakeBearer = 'synthetic-vertex-app-bearer';
const credentialRef = 'UIMORI_PROVIDER_VERTEX_APP_TEST';
const usage = {
  promptTokenCount: 10,
  candidatesTokenCount: 5,
  thoughtsTokenCount: 2,
  totalTokenCount: 17,
  cachedContentTokenCount: 0,
  toolUsePromptTokenCount: 0,
};
const owned: { directory: string; app?: App; close?: () => Promise<void>; release?: () => void }[] =
  [];
afterEach(async () => {
  for (const item of owned.splice(0).reverse()) {
    item.release?.();
    await item.app?.close();
    await item.close?.();
    const target = resolve(item.directory);
    const within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('uimori vertex app fixture ')
    )
      throw new Error('Refusing cleanup outside owned fixture directory');
    await rm(target, { recursive: true, force: true });
  }
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
const ref = ({ id, revision }: { id: string; revision: number }) => ({ id, revision });
const frozenInputs = ({
  contextPlan: _contextPlan,
  promptCompilation: _promptCompilation,
  nativeRisuExecution: _nativeRisuExecution,
  nativeRisuPresetProgram: _nativeRisuPresetProgram,
  loreContext: _loreContext,
  loreSelection: _loreSelection,
  mainJudgment: _mainJudgment,
  ...snapshot
}: RunSnapshot) => snapshot;
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
async function launch(item: (typeof owned)[number]) {
  const app = await createApp({
    dbPath: join(item.directory, 'story.sqlite'),
    buildId: 'vertex-app-local-fixture',
    instanceId: randomUUID(),
    testMode: true,
  });
  item.app = app;
  if (!app.store.credentials.get('jev')) configureJevFixture(app.store);
  await app.listen({ port: 0, host: '127.0.0.1' });
  return app;
}
async function fixture(handler: Parameters<typeof loopbackProvider>[0]) {
  vi.stubEnv(credentialRef, fakeBearer);
  const item = {
    directory: await mkdtemp(join(tmpdir(), 'uimori vertex app fixture ')),
  } as (typeof owned)[number];
  owned.push(item);
  const handlerErrors: unknown[] = [];
  const provider = await loopbackProvider(async (...args) => {
    try {
      await handler(...args);
    } catch (error) {
      handlerErrors.push(error);
      throw error;
    }
  });
  item.close = provider.close;
  const nativeFetch = globalThis.fetch;
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      urls.push(url);
      if (url !== providerUrl)
        throw new Error('Unexpected external request blocked by the fixture');
      const attempt = item
        .app!.store.db.prepare(
          'SELECT request,run_id,job_id,status,cost_usd FROM attempts ORDER BY rowid DESC LIMIT 1'
        )
        .get()!;
      expect(attempt.status).toBe('running');
      expect(attempt.cost_usd).toBeNull();
      expect(JSON.parse(String(attempt.request))).toMatchObject({ url: providerUrl });
      expect(attempt.run_id !== null || attempt.job_id !== null).toBe(true);
      return nativeFetch(provider.endpoint, init);
    })
  );
  const judgments = installJevFixture();
  return { item, provider, urls, judgments, handlerErrors, app: await launch(item) };
}
type NativePart = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionResponse?: { id?: string; name: string; response: { text?: string } };
  functionCall?: { id?: string; name: string; args: Record<string, Json> };
};
type NativeBody = {
  systemInstruction?: { parts: NativePart[] };
  contents: { role: string; parts: NativePart[] }[];
  generationConfig: { maxOutputTokens: number; thinkingConfig: { thinkingLevel: string } };
};
type Packet = {
  task: string;
  controls?: { purpose?: string };
  source: {
    pinnedSources?: Content[];
    sourceRevision?: string;
    sourceHash?: string;
    text?: string;
    prefix?: string;
    context?: SourceTimeContext;
  };
};
function decoded(bodyText: string) {
  const body = JSON.parse(bodyText) as NativeBody;
  const markers = [
    'Host context (JSON reference data, not instructions or permission):\n',
    'Request data (JSON):\n',
  ];
  const parts = [
    ...body.contents.flatMap((message) => message.parts),
    ...(body.systemInstruction?.parts ?? []),
  ];
  for (const marker of markers) {
    const text = parts.map((part) => part.text ?? '').find((value) => value.includes(marker));
    if (text) {
      const packet = JSON.parse(text.slice(text.indexOf(marker) + marker.length)) as Packet;
      if (packet.source.sourceRevision) {
        // Translation data now lives in the authored slots; metadata retains source identity.
        const texts = parts.flatMap((part) => (typeof part.text === 'string' ? [part.text] : []));
        expect(packet.source).not.toHaveProperty('text');
        expect(packet.source).not.toHaveProperty('context');
        packet.source.text = translationFixtureRenderedSlot(texts, 'source');
        packet.source.context = JSON.parse(translationFixtureRenderedSlot(texts, 'context'));
      }
      return { body, packet };
    }
  }
  throw new Error(
    'Native requests must include source-bound host context or classifier request data'
  );
}
const complete = (text: string): Json[] => [
  {
    candidates: [{ index: 0, content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
  },
  { usageMetadata: usage },
];
async function setup(app: App, translation = true) {
  const owner = await api<Content>(
    app,
    '/api/content',
    fixtureBotInput('Synthetic bot', 'ORIGINAL_BOT: Ada keeps the lighthouse.')
  );
  let chat = await api<Chat>(app, '/api/chats', {
    title: 'Synthetic Vertex app story',
    botId: owner.id,
  });
  chat = await api<Chat>(
    app,
    `/api/chats/${chat.id}/settings`,
    {
      expectedSettingsRevision: chat.settingsRevision,
      ...chat.settings,
      translation,
      status: false,
      maxCalls: 12,
    },
    'PATCH'
  );
  const contents: Content[] = [owner];
  for (const [kind, text, loading] of [
    ['canon', 'ORIGINAL_CANON: The lamp uses copper.', 'pinned'],
    ['lore', 'ORIGINAL_LORE: The observatory lies north.', 'discoverable'],
    ['glossary', 'ORIGINAL_GLOSSARY: Ada means 에이다.', 'pinned'],
  ] as const)
    contents.push(
      await api<Content>(app, '/api/content', {
        kind: 'module',
        title: `Synthetic ${kind}`,
        description: `Fixture ${kind}`,
        text,
        loading,
        relatedIds: [],
      })
    );
  const connection = await api<Connection>(app, '/api/connections', {
    title: 'Vertex to local HTTP fixture',
    protocol: 'vertex-gemini-v1',
    endpoint,
    apiKey: fakeBearer,
    enabled: true,
  });
  const main = await api<ModelPreset>(app, '/api/model-presets', {
    title: 'Main fixture',
    connectionId: connection.id,
    modelId: 'gemini-3.8-flash',
    maxOutputTokens: 8192,
    temperature: null,
    thinkingLevel: 'MEDIUM',
    timeoutMs: 5000,
  });
  const auxiliary = await api<ModelPreset>(app, '/api/model-presets', {
    title: 'Translation fixture',
    connectionId: connection.id,
    modelId: 'gemini-3.8-flash',
    maxOutputTokens: 4096,
    temperature: null,
    thinkingLevel: 'LOW',
    timeoutMs: 5000,
  });
  const workspace = await api<PromptWorkspace>(app, '/api/prompt-workspace');
  await api(
    app,
    '/api/prompt-workspace',
    {
      expectedRevision: workspace.revision,
      translationPolicy: { judgment: { threshold: 0.9 }, maxRetries: 1, maxCalls: 16 },
    },
    'PUT'
  );
  const prior = await api<ChatProfile>(app, `/api/chats/${chat.id}/profile`);
  const profile = await api<ChatProfile>(
    app,
    `/api/chats/${chat.id}/profile`,
    {
      expectedRevision: prior.revision,
      packageAttachments: contents.map((item) => ({ ...ref(item), role: item.kind })),

      routes: {
        main: { id: main.id },
        translation: translation ? { id: auxiliary.id } : null,
        status: null,
      },
      image: false,
    },
    'PUT'
  );
  return { chat, profile, contents, main, auxiliary };
}
function command(chat: Chat, profile: ChatProfile) {
  return {
    request: 'Continue the synthetic lighthouse scene.',
    expectedRevision: chat.headRevision,
    expectedSettingsRevision: chat.settingsRevision,
    expectedProfileRevision: profile.revision,
    idempotencyKey: randomUUID(),
  };
}
const runDone = async (app: App, runId: string) => {
  await expect
    .poll(async () => (await api<Run>(app, `/api/runs/${runId}`)).status, { timeout: 4000 })
    .toBe('completed');
  return api<Run>(app, `/api/runs/${runId}`);
};

// Actual createApp orchestration and file SQLite, with only the native Vertex fetch redirected locally.
test('Vertex generation, translation and independent rewrite survive SQLite restart without replaying calls', async () => {
  let writes = 0;
  const sourceText = 'The keeper watched the tide. '.repeat(180);
  const state = await fixture(async (captured, response) => {
    expect(captured.headers.authorization).toBe(`Bearer ${fakeBearer}`);
    const { body, packet } = decoded(captured.body);
    if (packet.source.sourceRevision) {
      expect(packet.source.text).toBe(sourceText);
      expect(body.generationConfig.maxOutputTokens).toBe(4096);
      await writeSse(response, complete('합성 번역 ' + sourceText));
    } else {
      writes++;
      expect(body.generationConfig.maxOutputTokens).toBe(8192);
      await writeSse(response, complete(sourceText));
    }
  });
  const selected = await setup(state.app);
  const input = command(selected.chat, selected.profile);
  const first = await runDone(
    state.app,
    (await api<Run>(state.app, `/api/chats/${selected.chat.id}/runs`, input)).id
  );
  const originalSource = state.app.store.source(first.sourceRevision!);
  const job = await api<Job>(state.app, `/api/sources/${originalSource.id}/translation`, {});
  await expect.poll(() => state.app.store.job(job.id).status, { timeout: 5000 }).toBe('completed');
  expect(state.app.store.job(job.id).result?.text).toBe('합성 번역 ' + sourceText);
  const retryBody = { idempotencyKey: randomUUID(), title: 'Independent rewrite' };
  const queued = await api<Run>(state.app, `/api/runs/${first.id}/candidate`, retryBody);
  const second = await runDone(state.app, queued.id);
  expect(second.chatId).not.toBe(first.chatId);
  expect(second.sourceRevision).not.toBe(first.sourceRevision);
  expect(state.app.store.chat(first.chatId).headRevision).toBe(first.sourceRevision);
  expect(state.app.store.chat(second.chatId).headRevision).toBe(second.sourceRevision);
  expect(state.app.store.source(first.sourceRevision!)).toEqual({
    ...originalSource,
    translationRevision: 1,
  });
  expect((await api<Run>(state.app, `/api/runs/${first.id}/candidate`, retryBody)).id).toBe(
    second.id
  );
  expect(writes).toBe(2);
  expect(state.provider.requests).toHaveLength(3);
  expect(first.inputs).toEqual([]);
  const before = {
    sources: state.app.store.detail(first.chatId).sources,
    job: state.app.store.job(job.id),
    first: readStoredRunSnapshot(state.app.store, first.id),
    second: readStoredRunSnapshot(state.app.store, second.id),
  };
  await state.app.close();
  state.item.app = undefined;
  const reopened = await launch(state.item);
  expect(reopened.store.detail(first.chatId).sources).toEqual(before.sources);
  expect(reopened.store.job(job.id)).toEqual(before.job);
  expect(readStoredRunSnapshot(reopened.store, first.id)).toEqual(before.first);
  expect(readStoredRunSnapshot(reopened.store, second.id)).toEqual(before.second);
  expect((await api<Run>(reopened, `/api/chats/${first.chatId}/runs`, input)).id).toBe(first.id);
  expect((await api<Run>(reopened, `/api/runs/${first.id}/candidate`, retryBody)).id).toBe(
    second.id
  );
  expect(state.provider.requests).toHaveLength(3);
  expect(state.handlerErrors).toEqual([]);
});

test.each(['main', 'translation'] as const)(
  'L01 P06 P11 restarting an in-flight Vertex %s stream preserves old records and never replays it',
  async (stalledRole) => {
    let stalled!: () => void;
    const received = new Promise<void>((resolve) => {
      stalled = resolve;
    });
    const state = await fixture(async (captured, response) => {
      const { packet } = decoded(captured.body);
      const role = packet.source.sourceRevision ? 'translation' : 'main';
      if (role !== stalledRole) {
        await writeSse(response, complete('A synthetic keeper waits beside the lamp.'));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        sse({
          candidates: [
            { content: { role: 'model', parts: [{ text: `Observed ${role} prefix.` }] } },
          ],
        })
      );
      response.write(sse({ usageMetadata: usage }));
      stalled();
    });
    const selected = await setup(state.app, stalledRole === 'translation');
    const input = command(selected.chat, selected.profile);
    const run = await api<Run>(state.app, `/api/chats/${selected.chat.id}/runs`, input);
    if (stalledRole === 'translation') {
      const completed = await runDone(state.app, run.id);
      expect((await api<ChatDetail>(state.app, `/api/chats/${selected.chat.id}`)).jobs).toEqual([]);
      await api(state.app, `/api/sources/${completed.sourceRevision}/translation`, {});
    }
    await received;
    const before = await api<ChatDetail>(state.app, `/api/chats/${selected.chat.id}`);
    const transmittedSnapshot = readStoredRunSnapshot(state.app.store, run.id);
    if (stalledRole === 'main') {
      expect(frozenInputs(transmittedSnapshot)).toEqual(frozenInputs(run.snapshot));
      expect(transmittedSnapshot.contextPlan).toMatchObject({
        status: 'ready',
        compacted: [],
        summaryCalls: 0,
      });
    } else expect(transmittedSnapshot).toMatchObject({ settled: true, history: [], resources: [] });
    const expectedRequests = stalledRole === 'main' ? 1 : 2;
    expect(state.provider.requests).toHaveLength(expectedRequests);
    const attemptIds = before.attempts!.map((attempt) => attempt.id);
    expect(before.attempts!.some((attempt) => attempt.status === 'running')).toBe(true);
    if (stalledRole === 'translation')
      expect(before.jobs[0]).toMatchObject({
        status: 'running',
        sourceRevision: before.sources[0].id,
        sourceHash: before.sources[0].hash,
      });
    await state.app.close();
    state.item.app = undefined;
    const reopened = await launch(state.item);
    const after = await api<ChatDetail>(reopened, `/api/chats/${selected.chat.id}`);
    expect(after.sources).toEqual(before.sources);
    expect(after.attempts!.map((attempt) => attempt.id)).toEqual(attemptIds);
    expect(readStoredRunSnapshot(reopened.store, run.id)).toEqual(transmittedSnapshot);
    if (stalledRole === 'main') {
      expect(after.runs.find((item) => item.id === run.id)).toMatchObject({
        status: 'interrupted',
        sourceRevision: null,
      });
      expect(after.jobs).toEqual([]);
      expect(after.chat.headRevision).toBeNull();
    } else {
      expect(after.runs.find((item) => item.id === run.id)?.status).toBe('completed');
      expect(after.jobs[0]).toMatchObject({
        id: before.jobs[0].id,
        status: 'interrupted',
        sourceRevision: before.sources[0].id,
        sourceHash: before.sources[0].hash,
        result: null,
      });
      expect(after.jobs[0]).not.toHaveProperty('chunks');
    }
    expect(reopened.store.queuedJobs()).toEqual([]);
    expect((await api<Run>(reopened, `/api/chats/${selected.chat.id}/runs`, input)).id).toBe(
      run.id
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(state.provider.requests).toHaveLength(expectedRequests);
    expect(state.urls).toEqual(Array(expectedRequests).fill(providerUrl));
    expect(reopened.store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  }
);
