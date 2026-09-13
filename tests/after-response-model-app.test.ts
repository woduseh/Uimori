import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { ContentPackage } from '../core/content-package.js';
import { packageInstanceId } from '../core/execution-context.js';
import { EXTENSION_PROGRAM_API } from '../core/extension-program.js';
import type { Connection, Content, ModelPreset } from '../core/product.js';
import type { Run } from '../core/types.js';
import { createApp, type App } from '../server/app.js';
import { exportChatBackup, importChatBackup } from '../server/chat-backup.js';
import { behaviorDetail } from '../server/package-behavior-host.js';
import { runBehaviorProgress } from '../server/package-behavior-run.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { Store } from '../server/store.js';
import * as extensionRuntime from '../server/extension-runtime.js';
import { createFixtureChat } from './fixtures/chat.js';
import { loopbackProvider, writeSse } from './fixtures/loopback-provider.js';

const MAIN_MODEL_ID = 'fixture-after-response-main';
const EXTENSION_MODEL_ID = 'fixture-after-response-extension';
const EXTENSION_TEXT = 'AFTER_RESPONSE_EXTENSION_RESULT';
const PROSE = 'The main model completed the raw synthetic scene.\n<STATE>{"count":2}</STATE>';

const owned: {
  directory: string;
  app?: App;
  store?: Store;
  closeProvider?: () => Promise<void>;
}[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const item of owned.splice(0).reverse()) {
    await item.app?.close();
    item.store?.close();
    await item.closeProvider?.();
    const target = resolve(item.directory),
      within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('uimori-after-response-model-app-')
    )
      throw new Error('Unsafe test cleanup');
    await rm(target, { recursive: true, force: true });
  }
});

function definition(): ContentPackage {
  return {
    version: 1,
    id: 'after-response-model-app-fixture',
    revision: 1,
    title: 'Synthetic response model hook',
    description: 'Actual createApp after-turn extension model fixture',
    body: 'Synthetic package body.',
    lore: [],
    controls: [],
    transforms: [],
    instructions: [],
    behavior: {
      revision: 1,
      schemaVersion: 1,
      mode: 'authoritative',
      stateSchema: {
        type: 'record',
        properties: { count: { type: 'number', min: 0, max: 10, integer: true } },
      },
      initialState: { count: 0 },
      actions: [
        {
          id: 'read-and-model-after-response',
          triggers: ['after-turn'],
          automaticInput: {},
          inputSchema: { type: 'record', properties: {} },
          effects: [],
          program: {
            api: EXTENSION_PROGRAM_API,
            capabilities: ['response.read.current', 'model.generate'],
            source:
              'const response = await api.host.call("response.read", {}); const generated = await api.host.call("model.generate", {prompt: "Return one after-response token."}); return {state: {count: generated.status === "completed" ? api.state.count + 1 : api.state.count}, result: {responseChars: response.totalChars, generated: generated.status}};',
          },
        },
      ],
      outputParsers: [
        {
          id: 'native-count',
          format: 'json',
          scope: 'line',
          start: '<STATE>',
          end: '</STATE>',
          fields: [{ path: ['count'], from: ['count'], valueType: 'number' }],
        },
      ],
    },
  };
}

type FixtureOptions = { holdExtension?: boolean; maxCalls?: number };

async function fixture(options: FixtureOptions = {}) {
  let releaseExtension!: () => void;
  let markExtensionStarted!: () => void;
  const extensionStarted = new Promise<void>((resolve) => (markExtensionStarted = resolve));
  const extensionGate = new Promise<void>((resolve) => (releaseExtension = resolve));
  const provider = await loopbackProvider(async (request, response) => {
    const body = JSON.parse(request.body) as { modelId: string };
    if (body.modelId === EXTENSION_MODEL_ID) {
      markExtensionStarted();
      if (options.holdExtension) await extensionGate;
      await writeSse(response, [
        { type: 'text_delta', delta: EXTENSION_TEXT },
        { type: 'usage', inputTokens: 6, outputTokens: 4, costUsd: null },
        { type: 'done', reason: 'stop' },
      ]);
      return;
    }
    if (body.modelId !== MAIN_MODEL_ID) throw new Error('Unexpected synthetic model');
    await writeSse(response, [
      { type: 'text_delta', delta: PROSE },
      { type: 'usage', inputTokens: 12, outputTokens: 8, costUsd: null },
      { type: 'done', reason: 'stop' },
    ]);
  });
  const directory = await mkdtemp(join(tmpdir(), 'uimori-after-response-model-app-'));
  const app = await createApp({
    dbPath: join(directory, 'story.sqlite'),
    buildId: 'after-response-model-app-test',
    approvedOrigins: [provider.origin],
  });
  owned.push({ directory, app, closeProvider: provider.close });
  await app.ready();

  const pkg = definition();
  const content = app.store.product.content({
    kind: 'bot',
    title: pkg.title,
    description: pkg.description,
    text: pkg.body,
    loading: 'pinned',
    relatedIds: [],
    package: pkg,
  }) as Content;
  let chat = createFixtureChat(app.store, 'After response extension model app', 'calm', {
    botId: content.id,
  });
  chat = app.store.settings(chat.id, chat.settingsRevision, {
    ...chat.settings,
    translation: false,
    status: false,
    maxCalls: options.maxCalls ?? 2,
  });
  const connection = app.store.product.connection({
    title: 'Synthetic after response provider',
    protocol: 'fixture-sse-v1',
    endpoint: provider.endpoint,
    enabled: true,
  }) as Connection;
  const mainModel = app.store.product.model({
    title: 'Synthetic after response main model',
    connectionId: connection.id,
    modelId: MAIN_MODEL_ID,
    maxOutputTokens: 128,
    temperature: null,
  }) as ModelPreset;
  const extensionModel = app.store.product.model({
    title: 'Synthetic after response extension model',
    connectionId: connection.id,
    modelId: EXTENSION_MODEL_ID,
    maxOutputTokens: 64,
    temperature: null,
  }) as ModelPreset;
  const workspace = modelWorkspace(app.store);
  updateModelWorkspace(app.store, {
    expectedRevision: workspace.revision,
    routes: { ...workspace.routes, main: { id: mainModel.id } },
    extensionModel: { id: extensionModel.id },
    translationPolicy: workspace.translationPolicy,
  });
  const profile = app.store.product.profile(chat.id);
  const attachment = profile.packageAttachments!.find((item) => item.id === content.id)!;
  const instanceId = packageInstanceId(attachment);
  app.store.product.updateProfile(chat.id, {
    expectedRevision: profile.revision,
    attachments: profile.attachments,
    packageAttachments: profile.packageAttachments,
    image: false,
    extensionGrants: {
      [instanceId]: {
        packageRevision: attachment.revision,
        capabilities: ['model.generate'],
      },
    },
  });
  return { app, chat, content, provider, instanceId, extensionStarted, releaseExtension };
}

async function emptyStore() {
  const directory = await mkdtemp(join(tmpdir(), 'uimori-after-response-model-app-restored-'));
  const store = new Store(join(directory, 'story.sqlite'));
  owned.push({ directory, store });
  return store;
}

async function start(app: App, chatId: string) {
  const chat = app.store.chat(chatId);
  const response = await app.inject({
    method: 'POST',
    url: `/api/chats/${chatId}/runs`,
    payload: {
      request: 'Write one synthetic response.',
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
      { timeout: 15_000, interval: 20 }
    )
    .not.toMatch(/queued|running|waiting_for_state/);
  return result;
}

function state(app: App, chatId: string) {
  return behaviorDetail(app.store, chatId).instances[0];
}

test('createApp runs main before the response hook model, keeps source raw, and archives its receipt without replay', async () => {
  const f = await fixture();
  const completed = await terminal(f.app, (await start(f.app, f.chat.id)).id);

  expect(completed.status).toBe('completed');
  expect(f.provider.requests.map((request) => JSON.parse(request.body).modelId)).toEqual([
    MAIN_MODEL_ID,
    EXTENSION_MODEL_ID,
  ]);
  expect(f.app.store.source(completed.sourceRevision!).text).toBe(PROSE);
  expect(completed.usage).toMatchObject({ modelCalls: 2, inputTokens: 18, outputTokens: 12 });
  expect(state(f.app, f.chat.id)).toMatchObject({ stateRevision: 2, state: { count: 3 } });
  expect(runBehaviorProgress(f.app.store, completed.id)?.afterResponse).toMatchObject({
    status: 'completed',
    packages: [
      {
        status: 'ready',
        before: { stateRevision: 1, state: { count: 2 } },
        after: { stateRevision: 2, state: { count: 3 } },
        entries: [
          {
            actionId: 'read-and-model-after-response',
            trigger: 'after-turn',
            result: { responseChars: PROSE.length, generated: 'completed' },
          },
        ],
      },
    ],
  });
  expect(f.app.store.product.attempts(f.chat.id)).toMatchObject([
    { role: 'main', status: 'completed' },
    {
      role: 'state',
      status: 'completed',
      request: {
        extensionAction: {
          instanceId: f.instanceId,
          actionId: 'read-and-model-after-response',
          packageId: f.content.id,
          packageRevision: 1,
          trigger: 'after-turn',
        },
      },
    },
  ]);

  const execute = vi.spyOn(extensionRuntime, 'executeExtensionProgram');
  const restored = await emptyStore();
  expect(restored.product.import(f.app.store.product.export())).toEqual({
    restored: true,
    chats: 1,
  });
  expect(runBehaviorProgress(restored, completed.id)?.afterResponse).toEqual(
    runBehaviorProgress(f.app.store, completed.id)?.afterResponse
  );
  expect(restored.product.attempts(f.chat.id)[1]).toMatchObject({
    request: { extensionAction: { trigger: 'after-turn' } },
  });

  const copiedStore = await emptyStore();
  const copied = importChatBackup(copiedStore, {
    backup: exportChatBackup(f.app.store, f.chat.id),
    idempotencyKey: randomUUID(),
  });
  const copiedRun = copiedStore
    .detail(copied.chat.id)
    .runs.find(
      (run) => run.sourceRevision && copiedStore.source(run.sourceRevision).text === PROSE
    )!;
  expect(runBehaviorProgress(copiedStore, copiedRun.id)?.afterResponse).toEqual(
    runBehaviorProgress(f.app.store, completed.id)?.afterResponse
  );
  expect(execute).not.toHaveBeenCalled();
  expect(f.provider.requests).toHaveLength(2);
});

test('maxCalls=1 leaves the completed main source and native parser state when after-turn generation is unavailable', async () => {
  const f = await fixture({ maxCalls: 1 });
  const completed = await terminal(f.app, (await start(f.app, f.chat.id)).id);

  expect(completed).toMatchObject({ status: 'completed', usage: { modelCalls: 1 } });
  expect(f.provider.requests.map((request) => JSON.parse(request.body).modelId)).toEqual([
    MAIN_MODEL_ID,
  ]);
  expect(f.app.store.source(completed.sourceRevision!).text).toBe(PROSE);
  expect(state(f.app, f.chat.id)).toMatchObject({ stateRevision: 1, state: { count: 2 } });
  expect(runBehaviorProgress(f.app.store, completed.id)?.afterResponse?.packages[0]).toMatchObject({
    status: 'failed',
    before: { stateRevision: 1, state: { count: 2 } },
    after: { stateRevision: 1, state: { count: 2 } },
    entries: [],
  });
  expect(f.app.store.product.attempts(f.chat.id).map((attempt) => attempt.role)).toEqual(['main']);
});

test('skipping an in-flight after-turn model settles its cancelled attempt then commits main text without late state', async () => {
  const f = await fixture({ holdExtension: true });
  const admitted = await start(f.app, f.chat.id);
  await f.extensionStarted;

  const skipping = f.app.inject({
    method: 'POST',
    url: `/api/runs/${admitted.id}/skip-package-after-response`,
    payload: {
      chatId: f.chat.id,
      branchId: admitted.snapshot.branchId,
      expectedRevision: admitted.parentRevision,
      idempotencyKey: randomUUID(),
    },
  });
  await expect
    .poll(() => runBehaviorProgress(f.app.store, admitted.id)?.afterResponse?.status, {
      timeout: 15_000,
      interval: 20,
    })
    .toBe('skipped');
  f.releaseExtension();
  const skipped = await skipping;
  expect(skipped.statusCode, skipped.body).toBe(200);
  const completed = await terminal(f.app, admitted.id);

  expect(completed).toMatchObject({ status: 'completed', usage: { modelCalls: 2 } });
  expect(f.app.store.source(completed.sourceRevision!).text).toBe(PROSE);
  expect(state(f.app, f.chat.id)).toMatchObject({ stateRevision: 1, state: { count: 2 } });
  expect(f.app.store.product.attempts(f.chat.id)).toMatchObject([
    { role: 'main', status: 'completed' },
    { role: 'state', status: 'cancelled' },
  ]);
});

test('cancelling an in-flight after-turn model settles its usage but publishes neither source nor state', async () => {
  const f = await fixture({ holdExtension: true });
  const admitted = await start(f.app, f.chat.id);
  await f.extensionStarted;
  const cancelled = await f.app.inject({ method: 'POST', url: `/api/runs/${admitted.id}/cancel` });
  expect(cancelled.statusCode, cancelled.body).toBe(200);
  f.releaseExtension();
  await expect
    .poll(
      () => ({
        usage: f.app.store.run(admitted.id).usage?.modelCalls,
        attempts: f.app.store.product
          .attempts(f.chat.id)
          .map((attempt) => [attempt.role, attempt.status]),
      }),
      { timeout: 15_000, interval: 20 }
    )
    .toEqual({
      usage: 2,
      attempts: [
        ['main', 'completed'],
        ['state', 'cancelled'],
      ],
    });

  expect(f.app.store.run(admitted.id)).toMatchObject({
    status: 'cancelled',
    sourceRevision: null,
    usage: { modelCalls: 2 },
  });
  expect(state(f.app, f.chat.id)).toMatchObject({ stateRevision: 0, state: { count: 0 } });
});

test('revoking the exact package grant while after-turn generation is in flight prevents late state adoption', async () => {
  const f = await fixture({ holdExtension: true });
  const admitted = await start(f.app, f.chat.id);
  await f.extensionStarted;
  const profile = f.app.store.product.profile(f.chat.id);
  f.app.store.product.updateProfile(f.chat.id, {
    expectedRevision: profile.revision,
    attachments: profile.attachments,
    packageAttachments: profile.packageAttachments,
    image: profile.image,
    extensionGrants: {},
  });
  f.releaseExtension();
  const completed = await terminal(f.app, admitted.id);

  expect(completed).toMatchObject({ status: 'completed', usage: { modelCalls: 2 } });
  expect(f.app.store.source(completed.sourceRevision!).text).toBe(PROSE);
  expect(state(f.app, f.chat.id)).toMatchObject({ stateRevision: 1, state: { count: 2 } });
  expect(runBehaviorProgress(f.app.store, completed.id)?.afterResponse?.packages[0]).toMatchObject({
    status: 'failed',
    before: { stateRevision: 1, state: { count: 2 } },
    after: { stateRevision: 1, state: { count: 2 } },
    entries: [],
  });
  expect(f.app.store.product.attempts(f.chat.id)).toMatchObject([
    { role: 'main', status: 'completed' },
    { role: 'state', status: 'completed' },
  ]);
});
