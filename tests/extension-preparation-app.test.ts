import { afterEach, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp, type App } from '../server/app.js';
import { Store } from '../server/store.js';
import { createFixtureChat } from './fixtures/chat.js';
import { updateTestProfile } from './fixtures/model-workspace.js';
import { loopbackProvider, writeSse } from './fixtures/loopback-provider.js';
import { promptWorkspace, updatePromptWorkspace } from '../server/prompt-workspace.js';
import { EXTENSION_PROGRAM_API } from '../core/extension-program.js';
import type { ContentPackage } from '../core/content-package.js';
import type { Connection, Content, ModelPreset, PromptPreset } from '../core/product.js';
import type { Run } from '../core/types.js';
import { behaviorDetail } from '../server/package-behavior-host.js';
import { runBehaviorProgress } from '../server/package-behavior-run.js';
import { validateRunSnapshot } from '../server/snapshot-archive.js';

const prose = 'The fixture model completed the scene after package preparation.';
const owned: {
  directory: string;
  app?: App;
  store?: Store;
  closeProvider?: () => Promise<void>;
}[] = [];

afterEach(async () => {
  for (const item of owned.splice(0).reverse()) {
    await item.app?.close();
    item.store?.close();
    await item.closeProvider?.();
    const target = resolve(item.directory),
      within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('uimori-extension-preparation-app-')
    )
      throw new Error('Unsafe test cleanup');
    await rm(target, { recursive: true, force: true });
  }
});

function packageDefinition(programSource: string): ContentPackage {
  return {
    version: 1,
    id: 'extension-preparation-app-fixture',
    revision: 1,
    title: 'Synthetic deferred preparation',
    description: 'Actual application execution fixture',
    body: 'Synthetic package body.',
    lore: [],
    controls: [],
    transforms: [],
    instructions: [
      {
        id: 'prepared-state',
        target: 'main',
        text: '',
        template: [
          { kind: 'text', text: 'STATE_COUNT=' },
          { kind: 'value', expression: { context: ['state', 'count'] } },
        ],
      },
    ],
    behavior: {
      revision: 1,
      schemaVersion: 1,
      mode: 'authoritative',
      stateSchema: {
        type: 'record',
        properties: { count: { type: 'number', min: 0, max: 100, integer: true } },
      },
      initialState: { count: 0 },
      actions: [
        {
          id: 'prepare-count',
          triggers: ['before-turn'],
          automaticInput: {},
          inputSchema: { type: 'record', properties: {} },
          effects: [],
          program: { api: EXTENSION_PROGRAM_API, source: programSource },
        },
      ],
      outputParsers: [],
    },
  };
}

async function fixture(programSource: string) {
  const directory = await mkdtemp(join(tmpdir(), 'uimori-extension-preparation-app-'));
  const provider = await loopbackProvider(async (_request, response) =>
    writeSse(response, [
      { type: 'text_delta', delta: prose },
      { type: 'usage', inputTokens: 12, outputTokens: 8, costUsd: null },
      { type: 'done', reason: 'stop' },
    ])
  );
  const app = await createApp({
    dbPath: join(directory, 'story.sqlite'),
    buildId: 'extension-preparation-app-test',
    approvedOrigins: [provider.origin],
  });
  owned.push({ directory, app, closeProvider: provider.close });
  await app.ready();

  const pkg = packageDefinition(programSource);
  const content = app.store.product.content({
    kind: 'bot',
    title: pkg.title,
    description: pkg.description,
    text: pkg.body,
    loading: 'pinned',
    relatedIds: [],
    package: pkg,
  }) as Content;
  let chat = createFixtureChat(app.store, 'Deferred preparation app path', 'calm', {
    botId: content.id,
  });
  chat = app.store.settings(chat.id, chat.settingsRevision, {
    ...chat.settings,
    translation: false,
    status: false,
    maxCalls: 4,
  });

  const connection = app.store.product.connection({
    title: 'Synthetic deferred provider',
    protocol: 'fixture-sse-v1',
    endpoint: provider.endpoint,
    enabled: true,
  }) as Connection;
  const model = app.store.product.model({
    title: 'Synthetic deferred model',
    connectionId: connection.id,
    modelId: 'fixture-deferred-model',
    inputTokenLimit: 8192,
    maxOutputTokens: 128,
    temperature: null,
  }) as ModelPreset;
  const profile = app.store.product.profile(chat.id);
  updateTestProfile(app.store.product, chat.id, {
    expectedRevision: profile.revision,
    attachments: profile.attachments,
    routes: { ...profile.routes, main: { id: model.id } },
    image: false,
  });
  const prompt = app.store.product.promptPreset({
    title: 'Synthetic package prompt',
    role: 'main',
    text: '',
    program: {
      version: 1,
      controls: [],
      blocks: [
        { id: 'bot', title: 'Bot', kind: 'slot', role: 'system', slot: 'bot' },
        { id: 'current', title: 'Current', kind: 'current' },
      ],
    },
  }) as PromptPreset;
  updatePromptWorkspace(app.store, {
    expectedRevision: promptWorkspace(app.store).revision,
    main: { title: prompt.title, program: prompt.program, values: {} },
  });
  return { app, provider, chat, content };
}

async function emptyStore() {
  const directory = await mkdtemp(join(tmpdir(), 'uimori-extension-preparation-app-'));
  const store = new Store(join(directory, 'restored.sqlite'));
  owned.push({ directory, store });
  return store;
}

async function start(app: App, chatId: string) {
  const chat = app.store.chat(chatId);
  const response = await app.inject({
    method: 'POST',
    url: `/api/chats/${chatId}/runs`,
    payload: {
      request: 'Continue after preparing the package state.',
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      expectedProfileRevision: app.store.product.profile(chatId).revision,
      idempotencyKey: randomUUID(),
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as Run;
}

async function terminal(app: App, runId: string) {
  let result!: Run;
  await expect
    .poll(
      () => {
        result = app.store.run(runId);
        return result.status;
      },
      { timeout: 10_000, interval: 20 }
    )
    .not.toMatch(/queued|running|waiting_for_state/);
  return result;
}

test('actual app prepares deferred state before prompt budgeting and commits it with the source', async () => {
  const f = await fixture(
    'return {state: {count: api.state.count + 1}, result: api.state.count + 1};'
  );
  const admitted = await start(f.app, f.chat.id);
  expect(admitted.snapshot).toMatchObject({
    packageStates: [{ state: { count: 0 }, stateRevision: 0 }],
    behaviorExecution: { deferredAutomatic: true, automaticResults: [] },
  });
  expect(admitted.snapshot.contextPlan).toBeUndefined();
  expect(admitted.snapshot.contextBase).toBeDefined();

  const completed = await terminal(f.app, admitted.id);
  expect(completed.status).toBe('completed');
  expect(f.provider.requests).toHaveLength(1);
  expect(f.provider.requests[0].body).toContain('STATE_COUNT=1');
  expect(f.app.store.source(completed.sourceRevision!).text).toBe(prose);
  expect(runBehaviorProgress(f.app.store, admitted.id)).toMatchObject({
    preparation: { status: 'ready', completed: 1, total: 1 },
    states: [{ state: { count: 1 }, stateRevision: 1 }],
  });
  expect(behaviorDetail(f.app.store, f.chat.id).instances[0]).toMatchObject({
    state: { count: 1 },
    stateRevision: 1,
  });
  expect(completed.snapshot).toMatchObject({
    request: admitted.request,
    packageStates: [{ state: { count: 0 }, stateRevision: 0 }],
    behaviorExecution: { deferredAutomatic: true, automaticResults: [] },
    contextPlan: {
      status: 'ready',
      estimatedInputTokens: expect.any(Number),
      budget: { inputTokenLimit: 8192 },
    },
    promptCompilation: expect.any(Object),
  });
  expect(() => validateRunSnapshot(f.app.store, completed.snapshot, completed.id)).not.toThrow();
  const restored = await emptyStore();
  expect(restored.product.import(f.app.store.product.export())).toEqual({
    restored: true,
    chats: 1,
  });
  expect(runBehaviorProgress(restored, completed.id)).toEqual(
    runBehaviorProgress(f.app.store, completed.id)
  );

  const candidateResponse = await f.app.inject({
    method: 'POST',
    url: `/api/runs/${admitted.id}/candidate`,
    payload: { idempotencyKey: randomUUID(), title: 'Prepared candidate' },
  });
  expect(candidateResponse.statusCode, candidateResponse.body).toBe(200);
  const candidate = await terminal(f.app, (candidateResponse.json() as Run).id);
  expect(candidate.status).toBe('completed');
  expect(candidate.snapshot.branchId).not.toBe(completed.snapshot.branchId);
  expect(f.provider.requests).toHaveLength(2);
  expect(f.provider.requests[1].body).toContain('STATE_COUNT=1');
  expect(
    behaviorDetail(f.app.store, f.chat.id, candidate.snapshot.branchId).instances[0]
  ).toMatchObject({ state: { count: 1 }, stateRevision: 1 });
  expect(candidate.snapshot).toMatchObject({
    packageStates: [{ state: { count: 0 }, stateRevision: 0 }],
    behaviorExecution: { deferredAutomatic: true, automaticResults: [] },
  });
});

test('recoverable deferred failure removes its state view and still completes model prose', async () => {
  const f = await fixture('return {state: {count: 999}, result: 999};');
  const admitted = await start(f.app, f.chat.id);
  const completed = await terminal(f.app, admitted.id);

  expect(completed.status).toBe('completed');
  expect(f.provider.requests).toHaveLength(1);
  expect(f.provider.requests[0].body).toContain('STATE_COUNT=null');
  expect(f.provider.requests[0].body).toContain('unavailable');
  expect(f.app.store.source(completed.sourceRevision!).text).toBe(prose);
  expect(runBehaviorProgress(f.app.store, admitted.id)).toMatchObject({
    entries: [],
    states: [{ state: { count: 0 }, stateRevision: 0 }],
    preparation: { status: 'failed', completed: 0, total: 1 },
  });
  expect(behaviorDetail(f.app.store, f.chat.id).instances[0]).toMatchObject({
    state: { count: 0 },
    stateRevision: 0,
  });
  expect(completed.snapshot).toMatchObject({
    packageStates: [{ state: { count: 0 }, stateRevision: 0 }],
    behaviorExecution: { deferredAutomatic: true, automaticResults: [] },
    contextPlan: { status: 'ready' },
  });
  expect(completed.snapshot.packageBehaviorUnavailable).toBeUndefined();
});
