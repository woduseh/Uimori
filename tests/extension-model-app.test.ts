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
import { updateModelWorkspace, modelWorkspace } from '../server/prompt-workspace.js';
import { exportChatBackup, importChatBackup } from '../server/chat-backup.js';

const MAIN_MODEL_ID = 'fixture-extension-main';
const EXTENSION_MODEL_ID = 'fixture-extension-host';
const EXTENSION_TEXT = 'EXTENSION_RESULT_PRIVATE_UNTIL_TOOL_RETURN';
const PROSE = 'The main model completed the synthetic scene.';

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
      !basename(target).startsWith('uimori-extension-model-app-')
    )
      throw new Error('Unsafe test cleanup');
    await rm(target, { recursive: true, force: true });
  }
});

function definition(): ContentPackage {
  return {
    version: 1,
    id: 'extension-model-app-fixture',
    revision: 1,
    title: 'Synthetic extension model app',
    description: 'Actual createApp and loopback fixture',
    body: 'Synthetic only.',
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
          id: 'ask-extension',
          triggers: ['model'],
          inputSchema: { type: 'record', properties: {} },
          effects: [],
          program: {
            api: EXTENSION_PROGRAM_API,
            capabilities: ['model.generate'],
            source:
              'const generated = await api.host.call("model.generate", {prompt: "Return one synthetic token."}); return {state: {count: generated.status === "completed" ? api.state.count + 1 : api.state.count}, result: generated};',
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
  let mainCalls = 0;
  let releaseExtension!: () => void;
  let markExtensionStarted!: () => void;
  const extensionStarted = new Promise<void>((resolve) => (markExtensionStarted = resolve));
  const extensionGate = new Promise<void>((resolve) => (releaseExtension = resolve));
  let stateBeforeFinalMain: unknown;
  const provider = await loopbackProvider(async (request, response) => {
    const body = JSON.parse(request.body) as {
      modelId: string;
      stable: { tools: { name: string }[] };
    };
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
    mainCalls++;
    if (mainCalls === 1) {
      const tool = body.stable.tools.find((item) => item.name.startsWith('behavior_'));
      if (!tool) throw new Error('Synthetic behavior tool was not registered');
      await writeSse(response, [
        {
          type: 'tool_delta',
          index: 0,
          id: 'extension-model-app-call',
          name: tool.name,
          argumentsDelta: '{}',
        },
        { type: 'usage', inputTokens: 10, outputTokens: 2, costUsd: null },
        { type: 'done', reason: 'tool_calls' },
      ]);
      return;
    }
    if (app) stateBeforeFinalMain = behaviorDetail(app.store, app.store.chats()[0].id).instances[0];
    await writeSse(response, [
      { type: 'text_delta', delta: PROSE },
      { type: 'usage', inputTokens: 15, outputTokens: 8, costUsd: null },
      { type: 'done', reason: 'stop' },
    ]);
  });
  const directory = await mkdtemp(join(tmpdir(), 'uimori-extension-model-app-'));
  app = await createApp({
    dbPath: join(directory, 'story.sqlite'),
    buildId: 'extension-model-app-test',
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
  let chat = createFixtureChat(app.store, 'Extension model app', 'calm', { botId: content.id });
  chat = app.store.settings(chat.id, chat.settingsRevision, {
    ...chat.settings,
    translation: false,
    status: false,
    maxCalls: options.maxCalls ?? 4,
  });
  const connection = app.store.product.connection({
    title: 'Synthetic extension app provider',
    protocol: 'fixture-sse-v1',
    endpoint: provider.endpoint,
    enabled: true,
  }) as Connection;
  const mainModel = app.store.product.model({
    title: 'Synthetic main model',
    connectionId: connection.id,
    modelId: MAIN_MODEL_ID,
    maxOutputTokens: 128,
    temperature: null,
  }) as ModelPreset;
  const extensionModel = app.store.product.model({
    title: 'Synthetic extension model',
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
      [instanceId]: { packageRevision: attachment.revision, capabilities: ['model.generate'] },
    },
  });
  return {
    app,
    chat,
    provider,
    instanceId,
    extensionStarted,
    releaseExtension,
    stateBeforeFinalMain: () => stateBeforeFinalMain,
  };
}

async function start(app: App, chatId: string) {
  const chat = app.store.chat(chatId);
  const response = await app.inject({
    method: 'POST',
    url: `/api/chats/${chatId}/runs`,
    payload: {
      request: 'Use the package tool, then write the next scene.',
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

test('createApp runs main, extension model and final main turns while publishing code state only with source completion', async () => {
  const f = await fixture();
  const admitted = await start(f.app, f.chat.id);
  const completed = await terminal(f.app, admitted.id);
  expect(completed.status).toBe('completed');
  expect(f.provider.requests.map((request) => JSON.parse(request.body).modelId)).toEqual([
    MAIN_MODEL_ID,
    EXTENSION_MODEL_ID,
    MAIN_MODEL_ID,
  ]);
  expect(f.provider.requests[2].body).toContain(EXTENSION_TEXT);
  expect(f.stateBeforeFinalMain()).toMatchObject({ stateRevision: 0, state: { count: 0 } });
  expect(behaviorDetail(f.app.store, f.chat.id).instances[0]).toMatchObject({
    stateRevision: 1,
    state: { count: 1 },
  });
  expect(f.app.store.source(completed.sourceRevision!).text).toBe(PROSE);
  expect(completed.usage).toMatchObject({
    modelCalls: 3,
    inputTokens: 31,
    outputTokens: 14,
  });
  expect(
    f.app.store.product.attempts(f.chat.id).map((attempt) => [attempt.role, attempt.status])
  ).toEqual([
    ['main', 'tool_calls'],
    ['state', 'completed'],
    ['main', 'completed'],
  ]);

  const directory = await mkdtemp(join(tmpdir(), 'uimori-extension-model-app-archive-'));
  const restored = new Store(join(directory, 'story.sqlite'));
  owned.push({ directory, store: restored });
  const archive = f.app.store.product.export();
  expect(restored.product.import(archive)).toEqual({
    restored: true,
    chats: 1,
  });
  expect(runBehaviorProgress(restored, completed.id)?.states[0]).toMatchObject({
    stateRevision: 1,
    state: { count: 1 },
  });
  expect(restored.product.attempts(f.chat.id).map((attempt) => attempt.role)).toEqual([
    'main',
    'state',
    'main',
  ]);
  const copied = importChatBackup(f.app.store, {
    backup: exportChatBackup(f.app.store, f.chat.id),
    idempotencyKey: 'copy-extension-chat',
  });
  expect(f.app.store.product.profile(copied.chat.id).extensionGrants).toBeUndefined();
  expect(behaviorDetail(f.app.store, copied.chat.id).instances[0]).toMatchObject({
    stateRevision: 1,
    state: { count: 1 },
  });
  expect(f.app.store.product.attempts(copied.chat.id).map((attempt) => attempt.role)).toEqual([
    'main',
    'state',
    'main',
  ]);
  for (const variant of ['missing', 'foreign'] as const) {
    const damaged = structuredClone(archive);
    const row = damaged.tables.attempts.find(
      (item) => JSON.parse(item.request).extensionAction !== undefined
    )!;
    const request = JSON.parse(row.request);
    if (variant === 'missing') delete request.extensionAction;
    else request.extensionAction.instanceId = 'foreign-package:module';
    row.request = JSON.stringify(request);
    const targetDirectory = await mkdtemp(join(tmpdir(), `uimori-extension-model-app-${variant}-`));
    const target = new Store(join(targetDirectory, 'story.sqlite'));
    owned.push({ directory: targetDirectory, store: target });
    expect(() => target.product.import(damaged)).toThrow();
    expect(target.chats()).toHaveLength(0);
  }
  expect(f.provider.requests).toHaveLength(3);
});

test('maxCalls reserves the final main turn and denies extension generation before an attempt', async () => {
  const f = await fixture({ maxCalls: 2 });
  const completed = await terminal(f.app, (await start(f.app, f.chat.id)).id);
  expect(completed.status).toBe('completed');
  expect(f.provider.requests).toHaveLength(2);
  expect(
    f.provider.requests.every((request) => JSON.parse(request.body).modelId === MAIN_MODEL_ID)
  ).toBe(true);
  expect(completed.usage.modelCalls).toBe(2);
  expect(f.app.store.product.attempts(f.chat.id).map((attempt) => attempt.role)).toEqual([
    'main',
    'main',
  ]);
  expect(behaviorDetail(f.app.store, f.chat.id).instances[0]).toMatchObject({
    stateRevision: 0,
    state: { count: 0 },
  });
});

test('revoking the live package grant during the extension request preserves its attempt but rejects its result and state', async () => {
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
  expect(completed.status).toBe('completed');
  expect(f.provider.requests).toHaveLength(3);
  expect(f.provider.requests[2].body).not.toContain(EXTENSION_TEXT);
  expect(f.app.store.product.attempts(f.chat.id).map((attempt) => attempt.role)).toEqual([
    'main',
    'state',
    'main',
  ]);
  expect(completed.usage.modelCalls).toBe(3);
  expect(behaviorDetail(f.app.store, f.chat.id).instances[0]).toMatchObject({
    stateRevision: 0,
    state: { count: 0 },
  });
});

test('cancelling during extension generation settles the sent attempts without source or state publication', async () => {
  const f = await fixture({ holdExtension: true });
  const admitted = await start(f.app, f.chat.id);
  await f.extensionStarted;
  const response = await f.app.inject({
    method: 'POST',
    url: `/api/runs/${admitted.id}/cancel`,
  });
  expect(response.statusCode, response.body).toBe(200);
  expect((response.json() as Run).status).toBe('cancelled');
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
        ['main', 'tool_calls'],
        ['state', 'cancelled'],
      ],
    });
  const cancelled = f.app.store.run(admitted.id);
  expect(cancelled).toMatchObject({
    status: 'cancelled',
    sourceRevision: null,
    usage: { modelCalls: 2 },
  });
  expect(f.provider.requests).toHaveLength(2);
  expect(f.app.store.chat(f.chat.id).headRevision).toBeNull();
  expect(behaviorDetail(f.app.store, f.chat.id).instances[0]).toMatchObject({
    stateRevision: 0,
    state: { count: 0 },
  });
});
