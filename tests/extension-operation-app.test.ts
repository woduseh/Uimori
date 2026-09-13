import { afterEach, expect, test, vi } from 'vitest';
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
import { extensionOperation } from '../server/extension-operations.js';
import { updateModelWorkspace, modelWorkspace } from '../server/prompt-workspace.js';
import { exportChatBackup, importChatBackup } from '../server/chat-backup.js';
import * as extensionRuntime from '../server/extension-runtime.js';
import { readChatVariables } from '../server/chat-variables.js';

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
      !basename(target).startsWith('uimori-extension-operation-app-')
    )
      throw new Error('Unsafe test cleanup');
    await rm(target, { recursive: true, force: true });
  }
});

function definition(sharedVariables = false): ContentPackage {
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
          triggers: ['user'],
          inputSchema: { type: 'record', properties: {} },
          effects: [],
          program: {
            api: EXTENSION_PROGRAM_API,
            capabilities: [
              'model.generate',
              ...(sharedVariables ? ['variables.read' as const, 'variables.write' as const] : []),
            ],
            source:
              'const generated = await api.host.call("model.generate", {prompt: "Return one synthetic token."});' +
              (sharedVariables
                ? 'await api.host.call("variables.set", {key: "generated", value: generated.text}); const shared = await api.host.call("variables.read", {key: "generated"}); if (shared.value !== generated.text) throw new Error("staged variable missing");'
                : '') +
              'return {state: {count: generated.status === "completed" ? api.state.count + 1 : api.state.count}, result: generated};',
          },
        },
      ],
      outputParsers: [],
    },
  };
}

type FixtureOptions = { maxCalls?: number; holdExtension?: boolean; sharedVariables?: boolean };

async function fixture(options: FixtureOptions = {}) {
  let app: App | undefined;
  let releaseExtension!: () => void;
  let markExtensionStarted!: () => void;
  const extensionStarted = new Promise<void>((resolve) => (markExtensionStarted = resolve));
  const extensionGate = new Promise<void>((resolve) => (releaseExtension = resolve));
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
    await writeSse(response, [
      { type: 'text_delta', delta: PROSE },
      { type: 'usage', inputTokens: 15, outputTokens: 8, costUsd: null },
      { type: 'done', reason: 'stop' },
    ]);
  });
  const directory = await mkdtemp(join(tmpdir(), 'uimori-extension-operation-app-'));
  app = await createApp({
    dbPath: join(directory, 'story.sqlite'),
    buildId: 'extension-model-app-test',
    approvedOrigins: [provider.origin],
  });
  owned.push({ directory, app, closeProvider: provider.close });
  await app.ready();
  const pkg = definition(options.sharedVariables);
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
      [instanceId]: {
        packageRevision: attachment.revision,
        capabilities: [
          'model.generate',
          ...(options.sharedVariables ? ['variables.write' as const] : []),
        ],
      },
    },
  });
  return {
    app,
    chat,
    provider,
    instanceId,
    extensionStarted,
    releaseExtension,
    directory,
    extensionModel,
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

function command(f: Awaited<ReturnType<typeof fixture>>) {
  const detail = behaviorDetail(f.app.store, f.chat.id);
  return {
    actionId: 'ask-extension',
    input: {},
    expectedStateRevision: detail.instances[0].stateRevision,
    expectedSourceHash: detail.sourceHash,
    idempotencyKey: randomUUID(),
  };
}
async function action(f: Awaited<ReturnType<typeof fixture>>, payload = command(f)) {
  return f.app.inject({
    method: 'POST',
    url: `/api/chats/${f.chat.id}/package-behaviors/${encodeURIComponent(f.instanceId)}/actions`,
    payload,
  });
}
async function operationTerminal(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  await expect
    .poll(() => extensionOperation(f.app.store, id).status, { timeout: 15000, interval: 20 })
    .not.toMatch(/queued|running/);
  return extensionOperation(f.app.store, id);
}
function state(f: Awaited<ReturnType<typeof fixture>>) {
  return behaviorDetail(f.app.store, f.chat.id).instances[0];
}
function count(store: Store, table: 'runs' | 'sources' | 'package_behavior_journal') {
  return Number(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
}

test.each([false, true])(
  'user button completes through the local provider and existing state journal without creating prose (shared variables: %s)',
  async (sharedVariables) => {
    const f = await fixture({ maxCalls: 1, sharedVariables });
    const payload = command(f);
    const admitted = await action(f, payload);
    expect(admitted.statusCode, admitted.body).toBe(200);
    const id = admitted.json().operation.operationId as string;
    const result = await operationTerminal(f, id);
    expect(result.status, result.error ?? '').toBe('completed');
    expect(result.usage).toMatchObject({ modelCalls: 1, inputTokens: 6, outputTokens: 4 });
    expect(state(f)).toMatchObject({ stateRevision: 1, state: { count: 1 } });
    const variableState = sharedVariables
      ? { revision: 1, values: { generated: EXTENSION_TEXT } }
      : { revision: 0, values: {} };
    expect(
      readChatVariables(f.app.store, f.chat.id, f.app.store.product.branch(f.chat.id).id)
    ).toEqual(variableState);
    expect(count(f.app.store, 'package_behavior_journal')).toBe(1);
    expect(count(f.app.store, 'runs')).toBe(0);
    expect(count(f.app.store, 'sources')).toBe(0);
    expect(
      f.app.store.db
        .prepare(
          'SELECT a.run_id,a.job_id FROM attempts a JOIN package_extension_operation_attempts e ON e.attempt_id=a.id WHERE e.operation_id=?'
        )
        .get(id)
    ).toMatchObject({ run_id: null, job_id: null });
    const repeated = await action(f, payload);
    expect(repeated.statusCode, repeated.body).toBe(200);
    expect(repeated.json().operation).toEqual({ operationId: id, reused: true });
    expect(
      readChatVariables(f.app.store, f.chat.id, f.app.store.product.branch(f.chat.id).id)
    ).toEqual(variableState);
    expect(
      f.app.store.db
        .prepare('SELECT count(*) AS n FROM chat_variable_journal WHERE chat_id=?')
        .get(f.chat.id)!.n
    ).toBe(sharedVariables ? 1 : 0);
    const changed = await action(f, { ...payload, expectedStateRevision: 1 });
    expect(changed.statusCode).toBe(409);
    expect(f.provider.requests).toHaveLength(1);
    const metadata = await f.app.inject({
      method: 'GET',
      url: `/api/chats/${f.chat.id}/package-behaviors`,
    });
    expect(metadata.json().operations).toEqual([
      expect.objectContaining({
        id,
        status: 'completed',
        usage: expect.objectContaining({ modelCalls: 1 }),
      }),
    ]);
    const publicResult = await f.app.inject({
      method: 'GET',
      url: `/api/chats/${f.chat.id}/extension-operations/${id}?includeResult=1`,
    });
    expect(Object.keys(publicResult.json()).sort()).toEqual([
      'error',
      'generation',
      'hasResult',
      'id',
      'result',
      'status',
    ]);
    const copied = importChatBackup(f.app.store, {
      backup: exportChatBackup(f.app.store, f.chat.id),
      idempotencyKey: randomUUID(),
    });
    expect(behaviorDetail(f.app.store, copied.chat.id).instances[0]).toMatchObject({
      state: { count: 1 },
    });
    expect(
      readChatVariables(f.app.store, copied.chat.id, f.app.store.product.branch(copied.chat.id).id)
    ).toEqual(variableState);
    expect(
      f.app.store.db
        .prepare('SELECT status FROM package_extension_operations WHERE chat_id=?')
        .get(copied.chat.id)
    ).toMatchObject({ status: 'completed' });
    expect(f.provider.requests).toHaveLength(1);
  }
);

test('model disabled after real guest completion leaves an unadopted result and settled usage', async () => {
  const f = await fixture();
  const execute = extensionRuntime.executeExtensionProgram;
  vi.spyOn(extensionRuntime, 'executeExtensionProgram').mockImplementationOnce(async (...args) => {
    const result = await execute(...args);
    f.app.store.product.save(
      'model',
      { ...f.extensionModel, enabled: false },
      f.extensionModel.id,
      f.extensionModel.revision
    );
    return result;
  });
  const admitted = await action(f);
  expect(admitted.statusCode, admitted.body).toBe(200);
  const id = admitted.json().operation.operationId as string;
  const result = await operationTerminal(f, id);
  expect(result).toMatchObject({
    status: 'failed',
    error: 'BEHAVIOR_HOST_MODEL_UNAVAILABLE',
    result: { state: { count: 1 }, result: { text: EXTENSION_TEXT } },
    usage: { modelCalls: 1, inputTokens: 6, outputTokens: 4 },
  });
  expect(state(f)).toMatchObject({ stateRevision: 0, state: { count: 0 } });
  expect(count(f.app.store, 'package_behavior_journal')).toBe(0);
  expect(f.provider.requests).toHaveLength(1);
  expect(f.app.store.product.attempts(f.chat.id)[0].status).toBe('completed');
});

test('held user operation responds promptly, cancels with accounting and never adopts late state', async () => {
  const f = await fixture({ holdExtension: true });
  const admitted = await action(f);
  expect(admitted.statusCode, admitted.body).toBe(200);
  const id = admitted.json().operation.operationId as string;
  await f.extensionStarted;
  expect(state(f)).toMatchObject({ stateRevision: 0, state: { count: 0 } });
  const cancelled = await f.app.inject({
    method: 'POST',
    url: `/api/chats/${f.chat.id}/extension-operations/${id}/cancel`,
    payload: {},
  });
  expect(cancelled.statusCode, cancelled.body).toBe(200);
  f.releaseExtension();
  await expect
    .poll(() => extensionOperation(f.app.store, id).usage, { timeout: 15000, interval: 20 })
    .not.toBeNull();
  expect(extensionOperation(f.app.store, id)).toMatchObject({
    status: 'cancelled',
    usage: { modelCalls: 1 },
  });
  expect(state(f)).toMatchObject({ stateRevision: 0, state: { count: 0 } });
  expect(f.app.store.product.attempts(f.chat.id)).toHaveLength(1);
  expect(f.app.store.product.attempts(f.chat.id)[0].status).not.toBe('running');
  expect(count(f.app.store, 'package_behavior_journal')).toBe(0);
  expect(count(f.app.store, 'runs')).toBe(0);
  const copied = importChatBackup(f.app.store, {
    backup: exportChatBackup(f.app.store, f.chat.id),
    idempotencyKey: randomUUID(),
  });
  expect(
    f.app.store.db
      .prepare('SELECT status FROM package_extension_operations WHERE chat_id=?')
      .get(copied.chat.id)
  ).toMatchObject({ status: 'cancelled' });
});

test.each([false, true])(
  'grant revocation prevents held state adoption with concurrent main=%s',
  async (withMain) => {
    const f = await fixture({ holdExtension: true });
    const admitted = await action(f);
    expect(admitted.statusCode, admitted.body).toBe(200);
    const id = admitted.json().operation.operationId as string;
    await f.extensionStarted;
    const profile = f.app.store.product.profile(f.chat.id);
    f.app.store.product.updateProfile(f.chat.id, {
      expectedRevision: profile.revision,
      attachments: profile.attachments,
      packageAttachments: profile.packageAttachments,
      image: false,
      extensionGrants: {},
    });
    if (withMain) {
      const run = await start(f.app, f.chat.id);
      expect((await terminal(f.app, run.id)).status).toBe('completed');
    }
    expect(extensionOperation(f.app.store, id).status).toBe('running');
    f.releaseExtension();
    expect((await operationTerminal(f, id)).status).toBe('failed');
    expect(state(f).state).toEqual({ count: 0 });
    expect(count(f.app.store, 'sources')).toBe(withMain ? 1 : 0);
  }
);

test('close and reopen retains interrupted operation and never replays its uncertain request', async () => {
  const f = await fixture({ holdExtension: true });
  const payload = command(f);
  const admitted = await action(f, payload);
  expect(admitted.statusCode, admitted.body).toBe(200);
  const id = admitted.json().operation.operationId as string;
  await f.extensionStarted;
  await f.app.close();
  owned.find((item) => item.app === f.app)!.app = undefined;
  f.releaseExtension();
  f.app = await createApp({
    dbPath: join(f.directory, 'story.sqlite'),
    buildId: 'extension-reopened',
    approvedOrigins: [f.provider.origin],
  });
  owned.find((item) => item.directory === f.directory)!.app = f.app;
  await f.app.ready();
  expect(extensionOperation(f.app.store, id).status).toBe('interrupted');
  const replay = await action(f, payload);
  expect(replay.statusCode, replay.body).toBe(200);
  expect(replay.json().operation).toEqual({ operationId: id, reused: true });
  expect(state(f).state).toEqual({ count: 0 });
  expect(f.provider.requests).toHaveLength(1);
});
