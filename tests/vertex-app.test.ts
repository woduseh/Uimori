import { injectWithFixtureBot, fixtureBotInput } from './fixtures/chat.js';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createApp, type App } from '../server/app.js';
import type { Chat, ChatDetail, Run, RunSnapshot } from '../core/types.js';
import type { ChatProfile, Connection, Content, ModelPreset } from '../core/product.js';
import type { SourceTimeContext } from '../core/auxiliary.js';
import type { Json } from '../core/transport.js';
import { loopbackProvider, sse, writeSse } from './fixtures/loopback-provider.js';

const origin = 'https://aiplatform.googleapis.com';
const endpoint = `${origin}/v1/projects/synthetic-project/locations/global/publishers/google/models`;
const providerUrl = `${endpoint}/gemini-3.8-flash:streamGenerateContent?alt=sse`;
const fakeBearer = 'synthetic-vertex-app-bearer';
const credentialEnv = 'NARRATIVE_PROVIDER_VERTEX_APP_TEST';
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
    approvedOrigins: [origin],
  });
  item.app = app;
  await app.listen({ port: 0, host: '127.0.0.1' });
  return app;
}
async function fixture(handler: Parameters<typeof loopbackProvider>[0]) {
  vi.stubEnv(credentialEnv, fakeBearer);
  const item = {
    directory: await mkdtemp(join(tmpdir(), 'uimori vertex app fixture ')),
  } as (typeof owned)[number];
  owned.push(item);
  const provider = await loopbackProvider(handler);
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
  return { item, provider, urls, app: await launch(item) };
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
  source: {
    pinnedSources?: Content[];
    sourceRevision?: string;
    sourceHash?: string;
    chunkId?: string;
    blocks?: { anchor: string; text: string }[];
    context?: SourceTimeContext;
  };
};
function decoded(bodyText: string) {
  const body = JSON.parse(bodyText) as NativeBody;
  const marker = 'Host context (JSON reference data, not instructions or permission):\n';
  const parts = [
    ...body.contents.flatMap((message) => message.parts),
    ...(body.systemInstruction?.parts ?? []),
  ];
  const text = parts.map((part) => part.text ?? '').find((value) => value.includes(marker));
  expect(text, 'AST requests retain an explicit source-bound host context').toBeDefined();
  return { body, packet: JSON.parse(text!.slice(text!.indexOf(marker) + marker.length)) as Packet };
}
const complete = (text: string): Json[] => [
  {
    candidates: [{ index: 0, content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
  },
  { usageMetadata: usage },
];
const read = (id: string, contentId: string): Json[] => [
  {
    candidates: [
      {
        index: 0,
        content: {
          role: 'model',
          parts: [
            { thought: true, text: 'PRIVATE_VERTEX_APP_THOUGHT' },
            {
              functionCall: { id, name: 'knowledge.read', args: { id: contentId } },
              thoughtSignature: 'PRIVATE_VERTEX_APP_SIGNATURE',
            },
          ],
        },
        finishReason: 'STOP',
      },
    ],
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
    credentialEnv,
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
  const prior = await api<ChatProfile>(app, `/api/chats/${chat.id}/profile`);
  const profile = await api<ChatProfile>(
    app,
    `/api/chats/${chat.id}/profile`,
    {
      expectedRevision: prior.revision,
      attachments: contents.filter((item) => item.kind !== 'bot').map(ref),
      personaReference: prior.personaReference,
      routes: {
        main: { id: main.id },
        translation: translation ? { id: auxiliary.id } : null,
        status: null,
        image: null,
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
test('L01 P05 P07 P08 P09 preserves source-time Main/Aux snapshots, long chunks and sibling ownership across duplicate commands and restart', async () => {
  let firstReceived!: () => void;
  const received = new Promise<void>((resolve) => {
    firstReceived = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let mainRequests = 0;
  let completedMain = 0;
  const paragraph =
    'The keeper watched the tide turn beneath the copper lamp and listened to the wind. '.repeat(
      31
    );
  const sourceTexts = ['Alpha', 'Beta'].map((name) =>
    [
      name + ' beginning. ' + paragraph,
      name + ' middle. ' + paragraph,
      name + ' ending. ' + paragraph,
    ].join('\n\n')
  );
  const state = await fixture(async (captured, response) => {
    expect(captured.headers.authorization).toBe(`Bearer ${fakeBearer}`);
    const { body, packet } = decoded(captured.body);
    const last = body.contents.at(-1)!;
    if (!packet.source.chunkId) {
      mainRequests++;
      expect(body.generationConfig).toMatchObject({
        maxOutputTokens: 8192,
        thinkingConfig: { thinkingLevel: 'MEDIUM' },
      });
      if (body.contents.length === 1) {
        if (mainRequests === 1) {
          firstReceived();
          await gate;
        }
        await writeSse(
          response,
          read(
            'main-read-lore',
            selected.contents.find((item) => item.title === 'Synthetic lore')!.id
          )
        );
      } else {
        expect(last.parts[0].functionResponse).toMatchObject({
          id: 'main-read-lore',
          name: 'knowledge.read',
          response: { text: 'ORIGINAL_LORE: The observatory lies north.' },
        });
        expect(body.contents[1].parts[1].thoughtSignature).toBe('PRIVATE_VERTEX_APP_SIGNATURE');
        await writeSse(response, complete(sourceTexts[completedMain++]));
      }
    } else {
      expect(body.generationConfig).toMatchObject({
        maxOutputTokens: 4096,
        thinkingConfig: { thinkingLevel: 'LOW' },
      });
      expect(
        packet.source.context!.packages?.pinned.find((entry) => entry.sourceKind === 'bot')?.text
      ).toContain('ORIGINAL_BOT');
      expect(
        packet.source.context!.references.find((item) => item.text.includes('ORIGINAL_GLOSSARY'))
      ).toBeDefined();
      if (body.contents.length === 1)
        await writeSse(
          response,
          read(
            `aux-${packet.source.chunkId}`,
            selected.contents.find((item) => item.title === 'Synthetic glossary')!.id
          )
        );
      else {
        expect(last.parts[0].functionResponse?.response.text).toContain('ORIGINAL_GLOSSARY');
        expect(body.contents[1].parts[1].thoughtSignature).toBe('PRIVATE_VERTEX_APP_SIGNATURE');
        await writeSse(
          response,
          complete(
            JSON.stringify({
              sourceRevision: packet.source.sourceRevision,
              sourceHash: packet.source.sourceHash,
              chunkId: packet.source.chunkId,
              segments: packet.source.blocks!.map((block) => ({
                anchors: [block.anchor],
                text: `합성 번역 ${block.text}`,
              })),
            })
          )
        );
      }
    }
  });
  state.item.release = release;
  const { app } = state;
  const selected = await setup(app);
  await api(app, '/api/test/control', { action: 'hold', barrier: 'translation' });
  const input = command(selected.chat, selected.profile);
  const originalRun = await api<Run>(app, `/api/chats/${selected.chat.id}/runs`, input);
  await received;
  const originalSnapshot = structuredClone(app.store.run(originalRun.id).snapshot);
  expect(frozenInputs(originalSnapshot)).toEqual(frozenInputs(originalRun.snapshot));
  expect(originalSnapshot.contextPlan).toMatchObject({
    status: 'ready',
    compacted: [],
    summaryCalls: 0,
  });
  const edited: Content[] = [];
  for (const content of selected.contents)
    edited.push(
      await api<Content>(
        app,
        `/api/content/${content.id}`,
        {
          kind: content.kind,
          title: content.title,
          description: content.description,
          loading: content.loading,
          relatedIds: content.relatedIds,
          text: 'FUTURE_MUTATION_' + content.kind,
          ...(content.package
            ? { package: { ...content.package, body: 'FUTURE_MUTATION_' + content.kind } }
            : {}),
          expectedRevision: content.revision,
        },
        'PUT'
      )
    );
  await api(
    app,
    `/api/chats/${selected.chat.id}/profile`,
    {
      expectedRevision: selected.profile.revision,
      attachments: edited.filter((item) => item.kind !== 'bot').map(ref),
      packageAttachments: edited
        .filter((item) => item.kind === 'bot')
        .map((item) => ({ ...ref(item), role: 'bot' })),
      personaReference: false,
      routes: selected.profile.routes,
      image: false,
    },
    'PUT'
  );
  release();
  const first = await runDone(app, originalRun.id);
  expect(first.snapshot).toEqual(originalSnapshot);
  expect(first.usage).toEqual({ modelCalls: 2, inputTokens: 20, outputTokens: 14, costUsd: null });
  expect((await api<Run>(app, `/api/chats/${selected.chat.id}/runs`, input)).id).toBe(first.id);
  expect(state.provider.requests).toHaveLength(2);
  const candidateInput = { idempotencyKey: randomUUID(), title: 'Sibling Beta' };
  const candidate = await api<Run>(app, `/api/runs/${first.id}/candidate`, candidateInput);
  const second = await runDone(app, candidate.id);
  expect((await api<Run>(app, `/api/runs/${first.id}/candidate`, candidateInput)).id).toBe(
    second.id
  );
  expect(state.provider.requests).toHaveLength(4);
  const { branchId: _firstBranch, candidateOf: _firstCandidate, ...firstFrozen } = first.snapshot;
  const { branchId: secondBranch, candidateOf, ...secondFrozen } = second.snapshot;
  expect(secondFrozen).toEqual(firstFrozen);
  expect(candidateOf).toBe(first.id);
  expect(second.parentRevision).toBe(first.parentRevision);
  expect((await api<ChatDetail>(app, `/api/chats/${selected.chat.id}`)).jobs).toEqual([]);
  await api(app, `/api/sources/${first.sourceRevision}/translation`, {});
  await api(app, `/api/sources/${second.sourceRevision}/translation`, {});
  await api(app, '/api/test/control', { action: 'release', barrier: 'translation' });
  await expect
    .poll(
      async () =>
        (await api<ChatDetail>(app, `/api/chats/${selected.chat.id}`)).jobs.map(
          (job) => job.status
        ),
      { timeout: 5000 }
    )
    .toEqual(['completed', 'completed']);
  const detail = await api<ChatDetail>(app, `/api/chats/${selected.chat.id}`);
  expect(detail.chat.headRevision).toBe(first.sourceRevision);
  expect(detail.branches!.find((branch) => branch.id === secondBranch)?.headRevision).toBe(
    second.sourceRevision
  );
  expect(detail.sources).toHaveLength(2);
  expect(detail.jobs).toHaveLength(2);
  for (const [index, run] of [first, second].entries()) {
    const source = detail.sources.find((item) => item.id === run.sourceRevision)!;
    expect(source).toMatchObject({
      text: sourceTexts[index],
      hash: createHash('sha256').update(sourceTexts[index]).digest('hex'),
      runId: run.id,
      parentRevision: run.parentRevision,
    });
    const job = detail.jobs.find((item) => item.sourceRevision === source.id)!;
    expect(job).toMatchObject({
      chatId: selected.chat.id,
      sourceHash: source.hash,
      status: 'completed',
      result: { mock: false, sourceRevision: source.id, sourceHash: source.hash },
    });
    expect(job.chunks).toHaveLength(3);
    expect(job.chunks!.every((chunk) => chunk.status === 'completed' && chunk.attempt === 1)).toBe(
      true
    );
    expect(job.result!.segments!.flatMap((segment) => segment.anchors)).toEqual(
      source.blocks!.map((block) => block.anchor)
    );
    const packets = state.provider.requests
      .map((request) => decoded(request.body).packet)
      .filter((packet) => packet.source.sourceRevision === source.id);
    expect(packets).toHaveLength(6);
    expect(packets.every((packet) => packet.source.sourceHash === source.hash)).toBe(true);
    expect(new Set(packets.map((packet) => packet.source.chunkId)).size).toBe(3);
  }
  expect(state.provider.requests).toHaveLength(16);
  expect(state.urls).toEqual(Array(16).fill(providerUrl));
  expect(JSON.stringify(state.provider.requests)).not.toContain('FUTURE_MUTATION');
  expect(detail.attempts).toHaveLength(16);
  expect(JSON.stringify(detail.attempts)).not.toMatch(
    /PRIVATE_VERTEX_APP_THOUGHT|PRIVATE_VERTEX_APP_SIGNATURE|synthetic-vertex-app-bearer/u
  );
  expect(app.store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  await app.close();
  state.item.app = undefined;
  const reopened = await launch(state.item);
  const restored = await api<ChatDetail>(reopened, `/api/chats/${selected.chat.id}`);
  expect(restored.sources).toEqual(detail.sources);
  expect(restored.jobs).toEqual(detail.jobs);
  expect(restored.runs).toEqual(detail.runs);
  expect(restored.attempts).toEqual(detail.attempts);
  expect(reopened.store.queuedJobs()).toEqual([]);
  expect(state.provider.requests).toHaveLength(16);
  expect((await api<Run>(reopened, `/api/chats/${selected.chat.id}/runs`, input)).id).toBe(
    first.id
  );
  expect((await api<Run>(reopened, `/api/runs/${first.id}/candidate`, candidateInput)).id).toBe(
    second.id
  );
  expect(state.provider.requests).toHaveLength(16);
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
      const role = packet.source.chunkId ? 'translation' : 'main';
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
    const transmittedSnapshot = before.runs.find((item) => item.id === run.id)!.snapshot;
    expect(frozenInputs(transmittedSnapshot)).toEqual(frozenInputs(run.snapshot));
    expect(transmittedSnapshot.contextPlan).toMatchObject({
      status: 'ready',
      compacted: [],
      summaryCalls: 0,
    });
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
    expect(after.runs.find((item) => item.id === run.id)!.snapshot).toEqual(transmittedSnapshot);
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
      expect(after.jobs[0].chunks!.every((chunk) => chunk.status === 'interrupted')).toBe(true);
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
