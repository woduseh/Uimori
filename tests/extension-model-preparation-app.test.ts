import { afterEach, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp, type App } from '../server/app.js';
import { Store } from '../server/store.js';
import { createFixtureChat } from './fixtures/chat.js';
import { loopbackProvider, writeSse } from './fixtures/loopback-provider.js';
import { EXTENSION_PROGRAM_API } from '../core/extension-program.js';
import { packageInstanceId } from '../core/execution-context.js';
import type { ContentPackage } from '../core/content-package.js';
import type { Connection, Content, ModelPreset } from '../core/product.js';
import type { Run } from '../core/types.js';
import { behaviorDetail } from '../server/package-behavior-host.js';
import { runBehaviorProgress } from '../server/package-behavior-run.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';

const MAIN_MODEL_ID = 'fixture-preparation-main';
const EXTENSION_MODEL_ID = 'fixture-preparation-extension';
const EXTENSION_TEXT = 'PREPARATION_EXTENSION_RESULT';
const PROSE = 'The main model completed the prepared synthetic scene.';

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
      !basename(target).startsWith('uimori-extension-model-preparation-app-')
    )
      throw new Error('Unsafe test cleanup');
    await rm(target, { recursive: true, force: true });
  }
});

function definition(): ContentPackage {
  return {
    version: 1,
    id: 'extension-model-preparation-app-fixture',
    revision: 1,
    title: 'Synthetic extension model preparation',
    description: 'Actual createApp deferred automatic model fixture',
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
        properties: {
          count: { type: 'number', min: 0, max: 10, integer: true },
        },
      },
      initialState: { count: 0 },
      actions: [
        {
          id: 'prepare-with-model',
          triggers: ['before-turn'],
          automaticInput: {},
          inputSchema: { type: 'record', properties: {} },
          effects: [],
          program: {
            api: EXTENSION_PROGRAM_API,
            capabilities: ['model.generate'],
            source:
              'const generated = await api.host.call("model.generate", {prompt: "Return one preparation token."}); return {state: {count: generated.status === "completed" ? api.state.count + 1 : api.state.count}, result: generated};',
          },
        },
      ],
      outputParsers: [],
    },
  };
}

type FixtureOptions = { maxCalls?: number; holdExtension?: boolean };

async function fixture(options: FixtureOptions = {}) {
  let app: App | undefined;
  let releaseExtension!: () => void;
  let markExtensionStarted!: () => void;
  const extensionStarted = new Promise<void>((resolve) => (markExtensionStarted = resolve));
  const extensionGate = new Promise<void>((resolve) => (releaseExtension = resolve));
  let stateBeforeMain: unknown;
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
    if (app) stateBeforeMain = behaviorDetail(app.store, app.store.chats()[0].id).instances[0];
    await writeSse(response, [
      { type: 'text_delta', delta: PROSE },
      { type: 'usage', inputTokens: 12, outputTokens: 8, costUsd: null },
      { type: 'done', reason: 'stop' },
    ]);
  });
  const directory = await mkdtemp(join(tmpdir(), 'uimori-extension-model-preparation-app-'));
  app = await createApp({
    dbPath: join(directory, 'story.sqlite'),
    buildId: 'extension-model-preparation-app-test',
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
  let chat = createFixtureChat(app.store, 'Extension model preparation app', 'calm', {
    botId: content.id,
  });
  chat = app.store.settings(chat.id, chat.settingsRevision, {
    ...chat.settings,
    translation: false,
    status: false,
    maxCalls: options.maxCalls ?? 2,
  });
  const connection = app.store.product.connection({
    title: 'Synthetic preparation provider',
    protocol: 'fixture-sse-v1',
    endpoint: provider.endpoint,
    enabled: true,
  }) as Connection;
  const mainModel = app.store.product.model({
    title: 'Synthetic preparation main model',
    connectionId: connection.id,
    modelId: MAIN_MODEL_ID,
    maxOutputTokens: 128,
    temperature: null,
  }) as ModelPreset;
  const extensionModel = app.store.product.model({
    title: 'Synthetic preparation extension model',
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
  return {
    app,
    chat,
    contentId: content.id,
    provider,
    instanceId,
    extensionStarted,
    releaseExtension,
    stateBeforeMain: () => stateBeforeMain,
  };
}

async function start(app: App, chatId: string) {
  const chat = app.store.chat(chatId);
  const response = await app.inject({
    method: 'POST',
    url: `/api/chats/${chatId}/runs`,
    payload: {
      request: 'Prepare the package and write the next scene.',
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

test('createApp executes before-turn model preparation before main input but publishes its state only with source completion', async () => {
  const f = await fixture();
  const admitted = await start(f.app, f.chat.id);
  const completed = await terminal(f.app, admitted.id);

  expect(completed.status).toBe('completed');
  expect(f.provider.requests.map((request) => JSON.parse(request.body).modelId)).toEqual([
    EXTENSION_MODEL_ID,
    MAIN_MODEL_ID,
  ]);
  expect(f.provider.requests[1].body).toContain('STATE_COUNT=1');
  expect(f.stateBeforeMain()).toMatchObject({
    stateRevision: 0,
    state: { count: 0 },
  });
  expect(f.app.store.source(completed.sourceRevision!).text).toBe(PROSE);
  expect(behaviorDetail(f.app.store, f.chat.id).instances[0]).toMatchObject({
    stateRevision: 1,
    state: { count: 1 },
  });
  expect(completed.usage).toMatchObject({
    modelCalls: 2,
    inputTokens: 18,
    outputTokens: 12,
  });
  const attempts = f.app.store.product.attempts(f.chat.id);
  expect(attempts.map((attempt) => [attempt.role, attempt.status])).toEqual([
    ['state', 'completed'],
    ['main', 'completed'],
  ]);
  expect(attempts[0]).toMatchObject({
    request: {
      extensionAction: {
        instanceId: f.instanceId,
        actionId: 'prepare-with-model',
        packageId: f.contentId,
        packageRevision: 1,
        trigger: 'before-turn',
      },
    },
  });

  const directory = await mkdtemp(
    join(tmpdir(), 'uimori-extension-model-preparation-app-archive-')
  );
  const restored = new Store(join(directory, 'story.sqlite'));
  owned.push({ directory, store: restored });
  expect(restored.product.import(f.app.store.product.export())).toEqual({
    restored: true,
    chats: 1,
  });
  expect(restored.product.attempts(f.chat.id)[0]).toMatchObject({
    request: { extensionAction: { trigger: 'before-turn' } },
  });
  expect(f.provider.requests).toHaveLength(2);
});

test('a candidate reuses completed before-turn model preparation without reissuing or recharging it', async () => {
  const f = await fixture();
  const original = await terminal(f.app, (await start(f.app, f.chat.id)).id);
  const response = await f.app.inject({
    method: 'POST',
    url: `/api/runs/${original.id}/candidate`,
    payload: { idempotencyKey: randomUUID(), title: 'Prepared extension candidate' },
  });
  expect(response.statusCode, response.body).toBe(200);
  const candidate = await terminal(f.app, (response.json() as Run).id);

  expect(candidate).toMatchObject({ status: 'completed', snapshot: { candidateOf: original.id } });
  expect(f.provider.requests.map((request) => JSON.parse(request.body).modelId)).toEqual([
    EXTENSION_MODEL_ID,
    MAIN_MODEL_ID,
    MAIN_MODEL_ID,
  ]);
  expect(f.provider.requests[2].body).toContain('STATE_COUNT=1');
  expect(candidate.usage).toMatchObject({ modelCalls: 1, inputTokens: 12, outputTokens: 8 });
  expect(f.app.store.product.attempts(f.chat.id).map((attempt) => attempt.role)).toEqual([
    'state',
    'main',
    'main',
  ]);
  expect(runBehaviorProgress(f.app.store, candidate.id)).toMatchObject({
    preparation: { status: 'ready', completed: 1, total: 1 },
    states: [{ state: { count: 1 }, stateRevision: 1 }],
  });
});

test('maxCalls reserves the main turn and rejects before-turn extension generation before a provider attempt', async () => {
  const f = await fixture({ maxCalls: 1 });
  const completed = await terminal(f.app, (await start(f.app, f.chat.id)).id);

  expect(completed.status).toBe('completed');
  expect(f.provider.requests.map((request) => JSON.parse(request.body).modelId)).toEqual([
    MAIN_MODEL_ID,
  ]);
  expect(completed.usage.modelCalls).toBe(1);
  expect(f.app.store.product.attempts(f.chat.id).map((attempt) => attempt.role)).toEqual(['main']);
  expect(behaviorDetail(f.app.store, f.chat.id).instances[0]).toMatchObject({
    stateRevision: 0,
    state: { count: 0 },
  });
});

test('skipping pending model preparation settles its extension attempt and continues main without late state publication', async () => {
  const f = await fixture({ holdExtension: true });
  const admitted = await start(f.app, f.chat.id);
  await f.extensionStarted;
  const skip = await f.app.inject({
    method: 'POST',
    url: `/api/runs/${admitted.id}/skip-package-preparation`,
    payload: {
      chatId: f.chat.id,
      branchId: admitted.snapshot.branchId,
      expectedRevision: admitted.parentRevision,
      idempotencyKey: randomUUID(),
    },
  });
  expect(skip.statusCode, skip.body).toBe(200);
  f.releaseExtension();
  const completed = await terminal(f.app, admitted.id);

  expect(completed.status).toBe('completed');
  expect(f.provider.requests.map((request) => JSON.parse(request.body).modelId)).toEqual([
    EXTENSION_MODEL_ID,
    MAIN_MODEL_ID,
  ]);
  expect(f.provider.requests[1].body).toContain('STATE_COUNT=null');
  expect(completed.usage.modelCalls).toBe(2);
  expect(
    f.app.store.product.attempts(f.chat.id).map((attempt) => [attempt.role, attempt.status])
  ).toEqual([
    ['state', 'cancelled'],
    ['main', 'completed'],
  ]);
  expect(behaviorDetail(f.app.store, f.chat.id).instances[0]).toMatchObject({
    stateRevision: 0,
    state: { count: 0 },
  });
});

test('cancelling during before-turn extension generation settles its usage without sending main or publishing source and state', async () => {
  const f = await fixture({ holdExtension: true });
  const admitted = await start(f.app, f.chat.id);
  await f.extensionStarted;
  const cancelled = await f.app.inject({
    method: 'POST',
    url: `/api/runs/${admitted.id}/cancel`,
  });
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
    .toEqual({ usage: 1, attempts: [['state', 'cancelled']] });
  const run = f.app.store.run(admitted.id);
  expect(run).toMatchObject({
    status: 'cancelled',
    sourceRevision: null,
    usage: { modelCalls: 1 },
  });
  expect(f.provider.requests).toHaveLength(1);
  expect(f.app.store.chat(f.chat.id).headRevision).toBeNull();
  expect(behaviorDetail(f.app.store, f.chat.id).instances[0]).toMatchObject({
    stateRevision: 0,
    state: { count: 0 },
  });
});
