import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { ContentPackage } from '../core/content-package.js';
import { packageInstanceId } from '../core/execution-context.js';
import type { Connection, Content, ModelPreset } from '../core/product.js';
import type { Run, RunSnapshot } from '../core/types.js';
import { createApp, type App } from '../server/app.js';
import { readChatVariables } from '../server/chat-variables.js';
import { extensionOperation } from '../server/extension-operations.js';
import { behaviorDetail } from '../server/package-behavior-host.js';
import { runBehaviorProgress } from '../server/package-behavior-run.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import type { Store } from '../server/store.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { loopbackProvider, writeSse } from './fixtures/loopback-provider.js';

const MAIN_MODEL_ID = 'fixture-conversation-main';
const EXTENSION_MODEL_ID = 'fixture-conversation-extension';
const PAST_REQUEST = 'Visible past request.';
const PAST_RESPONSE = 'Visible past response.';
const SIBLING_REQUEST = 'SIBLING_REQUEST_MUST_STAY_HIDDEN';
const SIBLING_RESPONSE = 'SIBLING_RESPONSE_MUST_STAY_HIDDEN';
const CURRENT_REQUEST = 'Current generation request.';
const CURRENT_RESPONSE = 'Current generated response.';
const EXTENSION_RESPONSE = 'Held extension response.';

const owned: {
  directory: string;
  app?: App;
  closeProvider?: () => Promise<void>;
}[] = [];

afterEach(async () => {
  for (const item of owned.splice(0).reverse()) {
    await item.app?.close();
    await item.closeProvider?.();
    const target = resolve(item.directory),
      within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('uimori-extension-conversation-app-')
    )
      throw new Error('Unsafe fixture cleanup');
    await rm(target, { recursive: true, force: true });
  }
});

const readProgram = (
  afterRead = ''
) => `const page = await api.host.call("conversation.page", {limit: 16000});
const messages = page.items.map(item => ({role: item.role, text: item.text}));
${afterRead}
return {state: {count: api.state.count + 1}, result: messages};`;

function definition(userMode: 'success' | 'failure' | 'held'): ContentPackage {
  const held = userMode === 'held';
  const userAfterRead =
    userMode === 'failure'
      ? 'await api.host.call("variables.set", {key: "conversation", value: JSON.stringify(messages)});\nthrow new Error("SYNTHETIC_FAILURE_AFTER_READ");'
      : `await api.host.call("variables.set", {key: "conversation", value: JSON.stringify(messages)});${
          held
            ? '\nawait api.host.call("model.generate", {prompt: "Hold after the conversation read."});'
            : ''
        }`;
  return {
    version: 1,
    id: 'extension-conversation-app-fixture',
    revision: 1,
    title: 'Synthetic conversation reader',
    description: 'Actual createApp conversation integration fixture',
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
          id: 'read-before',
          triggers: ['before-turn'],
          automaticInput: {},
          inputSchema: { type: 'record', properties: {} },
          effects: [],
          program: {
            api: 'uimori-state-action-v1',
            capabilities: ['conversation.read'],
            source: readProgram(),
          },
        },
        {
          id: 'read-after',
          triggers: ['after-turn'],
          automaticInput: {},
          inputSchema: { type: 'record', properties: {} },
          effects: [],
          program: {
            api: 'uimori-state-action-v1',
            capabilities: ['conversation.read'],
            source: readProgram(),
          },
        },
        {
          id: 'read-user',
          triggers: ['user'],
          inputSchema: { type: 'record', properties: {} },
          effects: [],
          program: {
            api: 'uimori-state-action-v1',
            capabilities: [
              'conversation.read',
              'variables.write',
              ...(held ? ['model.generate' as const] : []),
            ],
            source: readProgram(userAfterRead),
          },
        },
      ],
      outputParsers: [],
    },
  };
}

function completeTurn(
  store: Store,
  chatId: string,
  branchId: string,
  request: string,
  response: string
) {
  const chat = store.chat(chatId),
    branch = store.product.branch(chatId, branchId),
    profile = store.product.snapshot(chatId);
  const snapshot: RunSnapshot = {
    chatId,
    branchId,
    parentRevision: branch.headRevision,
    settingsRevision: chat.settingsRevision,
    settings: chat.settings,
    request,
    history: store.history(branch.headRevision),
    profile,
    resources: store.product.resources(chatId, profile),
  };
  const run = store.createRun(
    chatId,
    {
      request,
      expectedRevision: snapshot.parentRevision,
      expectedSettingsRevision: snapshot.settingsRevision,
      expectedProfileRevision: profile.revision,
      branchId,
      idempotencyKey: randomUUID(),
    },
    () => snapshot
  ).run;
  expect(store.startRun(run.id)).toBe(true);
  return store.completeRun(
    run.id,
    response,
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
}

type FixtureOptions = {
  grantConversation?: boolean;
  holdExtension?: boolean;
  userMode?: 'success' | 'failure' | 'held';
};

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
        { type: 'text_delta', delta: EXTENSION_RESPONSE },
        { type: 'usage', inputTokens: 4, outputTokens: 3, costUsd: null },
        { type: 'done', reason: 'stop' },
      ]);
      return;
    }
    await writeSse(response, [
      { type: 'text_delta', delta: CURRENT_RESPONSE },
      { type: 'usage', inputTokens: 8, outputTokens: 5, costUsd: null },
      { type: 'done', reason: 'stop' },
    ]);
  });
  const directory = await mkdtemp(join(tmpdir(), 'uimori-extension-conversation-app-'));
  const app = await createApp({
    dbPath: join(directory, 'story.sqlite'),
    buildId: 'extension-conversation-app-test',
    approvedOrigins: [provider.origin],
  });
  owned.push({ directory, app, closeProvider: provider.close });
  await app.ready();

  const initial = app.store.product.content(fixtureBotInput('Conversation owner')) as Content;
  let chat = app.store.createChat('Conversation integration', 'calm', { botId: initial.id });
  chat = app.store.settings(chat.id, chat.settingsRevision, {
    ...chat.settings,
    translation: false,
    status: false,
    maxCalls: 4,
  });
  const mainBranch = app.store.product.branch(chat.id).id;
  const first = completeTurn(app.store, chat.id, mainBranch, PAST_REQUEST, PAST_RESPONSE);
  const sibling = app.store.product.createBranch(chat.id, {
    title: 'Hidden sibling',
    fromRevision: first.id,
  });
  completeTurn(app.store, chat.id, sibling.id, SIBLING_REQUEST, SIBLING_RESPONSE);

  const pkg = definition(options.userMode ?? 'success');
  const content = app.store.product.content(
    {
      kind: initial.kind,
      title: pkg.title,
      description: pkg.description,
      text: pkg.body,
      loading: initial.loading,
      relatedIds: [],
      package: pkg,
      expectedRevision: initial.revision,
    },
    initial.id
  ) as Content;
  const connection = app.store.product.connection({
    title: 'Synthetic conversation provider',
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
  const grantConversation = options.grantConversation ?? true;
  app.store.product.updateProfile(chat.id, {
    expectedRevision: profile.revision,
    attachments: profile.attachments,
    packageAttachments: profile.packageAttachments,
    image: false,
    extensionGrants: grantConversation
      ? {
          [instanceId]: {
            packageRevision: attachment.revision,
            capabilities: [
              'conversation.read',
              'variables.write',
              ...(options.userMode === 'held' ? ['model.generate' as const] : []),
            ],
          },
        }
      : {},
  });
  return {
    app,
    chat,
    content,
    provider,
    mainBranch,
    sibling,
    instanceId,
    extensionStarted,
    releaseExtension,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function state(f: Fixture) {
  return behaviorDetail(f.app.store, f.chat.id, f.mainBranch).instances[0];
}

function actionCommand(f: Fixture) {
  const detail = behaviorDetail(f.app.store, f.chat.id, f.mainBranch);
  return {
    actionId: 'read-user',
    input: {},
    expectedStateRevision: detail.instances[0].stateRevision,
    expectedSourceHash: detail.sourceHash,
    idempotencyKey: randomUUID(),
  };
}

async function action(f: Fixture) {
  return f.app.inject({
    method: 'POST',
    url: `/api/chats/${f.chat.id}/package-behaviors/${encodeURIComponent(f.instanceId)}/actions`,
    payload: actionCommand(f),
  });
}

async function operationTerminal(f: Fixture, id: string) {
  await expect
    .poll(() => extensionOperation(f.app.store, id).status, { timeout: 15_000, interval: 20 })
    .not.toMatch(/queued|running/);
  return extensionOperation(f.app.store, id);
}

async function startGeneration(f: Fixture) {
  const chat = f.app.store.chat(f.chat.id);
  const response = await f.app.inject({
    method: 'POST',
    url: `/api/chats/${f.chat.id}/runs`,
    payload: {
      request: CURRENT_REQUEST,
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      expectedProfileRevision: f.app.store.product.profile(f.chat.id).revision,
      idempotencyKey: randomUUID(),
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as Run;
}

async function runTerminal(f: Fixture, runId: string) {
  await expect
    .poll(() => f.app.store.run(runId).status, { timeout: 15_000, interval: 20 })
    .not.toMatch(/queued|running|waiting_for_state/);
  return f.app.store.run(runId);
}

const visiblePast = [
  { role: 'user', text: PAST_REQUEST },
  { role: 'assistant', text: PAST_RESPONSE },
];

test('HTTP user action adopts only its captured branch conversation, variables and receipt', async () => {
  const f = await fixture();
  const admitted = await action(f);
  expect(admitted.statusCode, admitted.body).toBe(200);
  const id = admitted.json().operation.operationId as string;
  const completed = await operationTerminal(f, id);

  expect(completed.status, completed.error ?? '').toBe('completed');
  expect(completed.snapshot.extensionConversation).toMatchObject({
    chatId: f.chat.id,
    branchId: f.mainBranch,
    parentRevision: completed.snapshot.sourceRevision,
    admissionRunId: null,
  });
  expect(completed.result).toMatchObject({
    state: { count: 1 },
    result: visiblePast,
    conversation: { viewHash: expect.stringMatching(/^[a-f0-9]{64}$/u) },
  });
  expect(JSON.stringify(completed)).not.toContain('SIBLING_');
  expect(readChatVariables(f.app.store, f.chat.id, f.mainBranch)).toEqual({
    revision: 1,
    values: { conversation: JSON.stringify(visiblePast) },
  });
  expect(state(f)).toMatchObject({ stateRevision: 1, state: { count: 1 } });
  const payload = JSON.parse(
    String(f.app.store.db.prepare('SELECT payload FROM package_behavior_journal').get()!.payload)
  );
  expect(payload.program.conversation).toEqual(completed.result!.conversation);
  expect(f.provider.requests).toHaveLength(0);
});

test('actual generation appends its current request before turn and current response only after turn', async () => {
  const f = await fixture();
  const run = await startGeneration(f);
  const completed = await runTerminal(f, run.id);
  expect(completed.status, completed.error ?? '').toBe('completed');
  expect(completed.snapshot.extensionConversation).toMatchObject({
    chatId: f.chat.id,
    branchId: f.mainBranch,
    parentRevision: run.parentRevision,
    admissionRunId: run.id,
  });
  const progress = runBehaviorProgress(f.app.store, run.id)!;
  expect(progress.entries.find((entry) => entry.actionId === 'read-before')?.result).toEqual([
    ...visiblePast,
    { role: 'user', text: CURRENT_REQUEST },
  ]);
  expect(progress.afterResponse!.packages[0].entries[0]).toMatchObject({
    actionId: 'read-after',
    result: [
      ...visiblePast,
      { role: 'user', text: CURRENT_REQUEST },
      { role: 'assistant', text: CURRENT_RESPONSE },
    ],
    program: { conversation: { viewHash: expect.stringMatching(/^[a-f0-9]{64}$/u) } },
  });
  expect(JSON.stringify(progress)).not.toContain('SIBLING_');
  expect(state(f)).toMatchObject({ stateRevision: 2, state: { count: 2 } });
});

test('missing conversation grant leaves no capture and cannot fall back to current database history', async () => {
  const f = await fixture({ grantConversation: false });
  const admitted = await action(f);
  expect(admitted.statusCode, admitted.body).toBe(200);
  const id = admitted.json().operation.operationId as string;
  const failed = await operationTerminal(f, id);

  expect(failed).toMatchObject({
    status: 'failed',
    error: 'BEHAVIOR_PROGRAM_FAILED',
    result: null,
  });
  expect(failed.snapshot).not.toHaveProperty('extensionConversation');
  expect(state(f)).toMatchObject({ stateRevision: 0, state: { count: 0 } });
  expect(readChatVariables(f.app.store, f.chat.id, f.mainBranch)).toEqual({
    revision: 0,
    values: {},
  });
  expect(
    f.app.store.db.prepare('SELECT count(*) AS n FROM package_behavior_journal').get()!.n
  ).toBe(0);
});

test('guest failure after reading and live grant revocation both discard staged effects', async () => {
  for (const mode of ['failure', 'held'] as const) {
    const f = await fixture({ userMode: mode, holdExtension: mode === 'held' });
    const admitted = await action(f);
    expect(admitted.statusCode, admitted.body).toBe(200);
    const id = admitted.json().operation.operationId as string;
    if (mode === 'held') {
      await f.extensionStarted;
      const profile = f.app.store.product.profile(f.chat.id);
      f.app.store.product.updateProfile(f.chat.id, {
        expectedRevision: profile.revision,
        attachments: profile.attachments,
        packageAttachments: profile.packageAttachments,
        image: false,
        extensionGrants: {
          [f.instanceId]: {
            packageRevision: f.content.revision,
            capabilities: ['model.generate', 'variables.write'],
          },
        },
      });
      f.releaseExtension();
    }
    const failed = await operationTerminal(f, id);
    expect(failed.status).toBe('failed');
    if (mode === 'held') expect(failed.error).toBe('BEHAVIOR_PROGRAM_CONTEXT_CHANGED');
    expect(state(f)).toMatchObject({ stateRevision: 0, state: { count: 0 } });
    expect(readChatVariables(f.app.store, f.chat.id, f.mainBranch)).toEqual({
      revision: 0,
      values: {},
    });
    expect(
      f.app.store.db.prepare('SELECT count(*) AS n FROM package_behavior_journal').get()!.n
    ).toBe(0);
  }
});
