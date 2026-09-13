import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { ContentPackage } from '../core/content-package.js';
import { packageInstanceId } from '../core/execution-context.js';
import { EXTENSION_PROGRAM_API } from '../core/extension-program.js';
import type { Connection, Content, ModelPreset, PromptPreset } from '../core/product.js';
import type { Run } from '../core/types.js';
import { createApp, type App } from '../server/app.js';
import { behaviorDetail } from '../server/package-behavior-host.js';
import { runBehaviorProgress } from '../server/package-behavior-run.js';
import { promptWorkspace, updatePromptWorkspace } from '../server/prompt-workspace.js';
import { readerRuns } from '../server/reader.js';
import { Store } from '../server/store.js';
import { exportChatBackup, importChatBackup } from '../server/chat-backup.js';
import * as extensionRuntime from '../server/extension-runtime.js';
import { createFixtureChat } from './fixtures/chat.js';
import { loopbackProvider, writeSse } from './fixtures/loopback-provider.js';
import { updateTestProfile } from './fixtures/model-workspace.js';

const ORIGINAL = 'Original scene 🙂.\n<STATE>{"count":2}</STATE>';
const CANDIDATE = 'A different candidate scene.\n<STATE>{"count":4}</STATE>';
const PRIVATE_FAILURE = 'PRIVATE_AFTER_RESPONSE_FAILURE';

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
      !basename(target).startsWith('uimori-after-response-app-')
    )
      throw new Error('Unsafe test cleanup');
    await rm(target, { recursive: true, force: true });
  }
});

function definition(programSource: string): ContentPackage {
  return {
    version: 1,
    id: 'after-response-app-fixture',
    revision: 1,
    title: 'Synthetic response hook',
    description: 'Actual createApp response hook fixture',
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
        properties: { count: { type: 'number', min: 0, max: 10_000, integer: true } },
      },
      initialState: { count: 0 },
      actions: [
        {
          id: 'read-response',
          triggers: ['after-turn'],
          automaticInput: {},
          inputSchema: { type: 'record', properties: {} },
          effects: [],
          program: {
            api: EXTENSION_PROGRAM_API,
            capabilities: ['response.read.current', 'model.generate'],
            source: programSource,
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

const successfulProgram =
  'const response = await api.host.call("response.read", {}); return {state: {count: api.state.count + response.totalChars}, result: {contentHash: response.contentHash, totalChars: response.totalChars, candidate: response.text.includes("candidate")}};';

async function fixture(programSource = successfulProgram) {
  let responseIndex = 0;
  const provider = await loopbackProvider(async (_request, response) => {
    const text = responseIndex++ === 0 ? ORIGINAL : CANDIDATE;
    await writeSse(response, [
      { type: 'text_delta', delta: text },
      { type: 'usage', inputTokens: 12, outputTokens: 8, costUsd: null },
      { type: 'done', reason: 'stop' },
    ]);
  });
  const directory = await mkdtemp(join(tmpdir(), 'uimori-after-response-app-'));
  const app = await createApp({
    dbPath: join(directory, 'story.sqlite'),
    buildId: 'after-response-app-test',
    approvedOrigins: [provider.origin],
  });
  owned.push({ directory, app, closeProvider: provider.close });
  await app.ready();

  const pkg = definition(programSource);
  const content = app.store.product.content({
    kind: 'bot',
    title: pkg.title,
    description: pkg.description,
    text: pkg.body,
    loading: 'pinned',
    relatedIds: [],
    package: pkg,
  }) as Content;
  let chat = createFixtureChat(app.store, 'After response app path', 'calm', {
    botId: content.id,
  });
  chat = app.store.settings(chat.id, chat.settingsRevision, {
    ...chat.settings,
    translation: false,
    status: false,
    maxCalls: 1,
  });
  const connection = app.store.product.connection({
    title: 'Synthetic response provider',
    protocol: 'fixture-sse-v1',
    endpoint: provider.endpoint,
    enabled: true,
  }) as Connection;
  const model = app.store.product.model({
    title: 'Synthetic response model',
    connectionId: connection.id,
    modelId: 'fixture-response-model',
    inputTokenLimit: 8192,
    maxOutputTokens: 128,
    temperature: null,
  }) as ModelPreset;
  const profile = app.store.product.profile(chat.id);
  const updated = updateTestProfile(app.store.product, chat.id, {
    expectedRevision: profile.revision,
    attachments: profile.attachments,
    routes: { ...profile.routes, main: { id: model.id } },
    image: false,
  });
  const attachment = updated.packageAttachments!.find((item) => item.id === content.id)!;
  const instanceId = packageInstanceId(attachment);
  app.store.product.updateProfile(chat.id, {
    expectedRevision: updated.revision,
    attachments: updated.attachments,
    packageAttachments: updated.packageAttachments,
    image: false,
    extensionGrants: {
      [instanceId]: { packageRevision: attachment.revision, capabilities: ['model.generate'] },
    },
  });
  const prompt = app.store.product.promptPreset({
    title: 'Synthetic response prompt',
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
  return { app, chat, content, provider, instanceId };
}

async function emptyStore() {
  const directory = await mkdtemp(join(tmpdir(), 'uimori-after-response-app-'));
  const store = new Store(join(directory, 'restored.sqlite'));
  owned.push({ directory, store });
  return store;
}

function storedState(store: Store, chatId: string) {
  const row = store.db
    .prepare(
      'SELECT state_revision AS stateRevision,state FROM package_behavior_states WHERE chat_id=?'
    )
    .get(chatId) as { stateRevision: number; state: string };
  return { stateRevision: row.stateRevision, state: JSON.parse(row.state) };
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

test('createApp adopts native parsing before a response-reading code hook and reruns it for a candidate', async () => {
  const f = await fixture();
  const original = await terminal(f.app, (await start(f.app, f.chat.id)).id);
  expect(original.status).toBe('completed');
  expect(f.app.store.source(original.sourceRevision!).text).toBe(ORIGINAL);
  expect(original.usage).toMatchObject({ modelCalls: 1, inputTokens: 12, outputTokens: 8 });
  expect(f.provider.requests).toHaveLength(1);

  const originalProgress = runBehaviorProgress(f.app.store, original.id)!;
  const originalPackage = originalProgress.afterResponse!.packages[0];
  expect(originalPackage).toMatchObject({
    status: 'ready',
    before: { stateRevision: 1, state: { count: 2 } },
    after: { stateRevision: 2, state: { count: 2 + ORIGINAL.length } },
    entries: [
      {
        actionId: 'read-response',
        before: { stateRevision: 1, state: { count: 2 } },
        after: { stateRevision: 2, state: { count: 2 + ORIGINAL.length } },
        result: {
          contentHash: createHash('sha256').update(ORIGINAL).digest('hex'),
          totalChars: ORIGINAL.length,
          candidate: false,
        },
      },
    ],
  });
  expect(behaviorDetail(f.app.store, f.chat.id).instances[0]).toMatchObject({
    stateRevision: 2,
    state: { count: 2 + ORIGINAL.length },
  });
  const summary = readerRuns(f.app.store, f.chat.id).find((run) => run.id === original.id)!;
  expect(summary.packageAfterResponse).toEqual({
    status: 'completed',
    completed: 1,
    total: 1,
    failed: 0,
  });
  expect(JSON.stringify(summary)).not.toContain('contentHash');

  const response = await f.app.inject({
    method: 'POST',
    url: `/api/runs/${original.id}/candidate`,
    payload: { idempotencyKey: randomUUID(), title: 'Response hook candidate' },
  });
  expect(response.statusCode, response.body).toBe(200);
  const candidate = await terminal(f.app, (response.json() as Run).id);
  expect(candidate.status).toBe('completed');
  expect(f.app.store.source(candidate.sourceRevision!).text).toBe(CANDIDATE);
  expect(candidate.usage).toMatchObject({ modelCalls: 1, inputTokens: 12, outputTokens: 8 });
  expect(f.provider.requests).toHaveLength(2);
  const candidatePackage = runBehaviorProgress(f.app.store, candidate.id)!.afterResponse!
    .packages[0];
  expect(candidatePackage).toMatchObject({
    before: { stateRevision: 1, state: { count: 4 } },
    after: { stateRevision: 2, state: { count: 4 + CANDIDATE.length } },
    entries: [
      {
        result: {
          contentHash: createHash('sha256').update(CANDIDATE).digest('hex'),
          totalChars: CANDIDATE.length,
          candidate: true,
        },
      },
    ],
  });
  expect(candidatePackage.entries[0].result).not.toEqual(originalPackage.entries[0].result);
  expect(
    behaviorDetail(f.app.store, f.chat.id, candidate.snapshot.branchId).instances[0]
  ).toMatchObject({ stateRevision: 2, state: { count: 4 + CANDIDATE.length } });
});

test('a response hook failure preserves completed prose and the successful native parser state', async () => {
  const f = await fixture(
    `await api.host.call("response.read", {}); throw new Error("${PRIVATE_FAILURE}");`
  );
  const completed = await terminal(f.app, (await start(f.app, f.chat.id)).id);
  expect(completed.status).toBe('completed');
  expect(f.app.store.source(completed.sourceRevision!).text).toBe(ORIGINAL);
  expect(completed.usage).toMatchObject({ modelCalls: 1, inputTokens: 12, outputTokens: 8 });
  expect(f.provider.requests).toHaveLength(1);
  expect(behaviorDetail(f.app.store, f.chat.id).instances[0]).toMatchObject({
    stateRevision: 1,
    state: { count: 2 },
  });
  const progress = runBehaviorProgress(f.app.store, completed.id)!;
  expect(progress.afterResponse).toMatchObject({
    status: 'completed',
    completed: 1,
    total: 1,
    packages: [
      {
        status: 'failed',
        code: 'BEHAVIOR_PROGRAM_FAILED',
        before: { stateRevision: 1, state: { count: 2 } },
        after: { stateRevision: 1, state: { count: 2 } },
        entries: [],
      },
    ],
  });
  const summary = readerRuns(f.app.store, f.chat.id).find((run) => run.id === completed.id)!;
  expect(summary.packageAfterResponse).toEqual({
    status: 'completed',
    completed: 1,
    total: 1,
    failed: 1,
  });
  expect(JSON.stringify(summary)).not.toContain(PRIVATE_FAILURE);
});

test('full archive and portable chat backup retain response receipts without replaying code or models', async () => {
  const f = await fixture();
  const completed = await terminal(f.app, (await start(f.app, f.chat.id)).id);
  const progress = runBehaviorProgress(f.app.store, completed.id)!;
  const execute = vi.spyOn(extensionRuntime, 'executeExtensionProgram');
  const providerCalls = f.provider.requests.length;

  const restored = await emptyStore();
  expect(restored.product.import(f.app.store.product.export())).toEqual({
    restored: true,
    chats: 1,
  });
  expect(restored.source(completed.sourceRevision!).text).toBe(ORIGINAL);
  expect(runBehaviorProgress(restored, completed.id)).toEqual(progress);
  expect(storedState(restored, f.chat.id)).toEqual({
    stateRevision: 2,
    state: { count: 2 + ORIGINAL.length },
  });

  const copiedStore = await emptyStore();
  const copied = importChatBackup(copiedStore, {
    backup: exportChatBackup(f.app.store, f.chat.id),
    idempotencyKey: randomUUID(),
  });
  const copiedRun = copiedStore
    .detail(copied.chat.id)
    .runs.find(
      (run) => run.sourceRevision && copiedStore.source(run.sourceRevision).text === ORIGINAL
    )!;
  expect(copiedStore.source(copiedRun.sourceRevision!).text).toBe(ORIGINAL);
  expect(runBehaviorProgress(copiedStore, copiedRun.id)?.afterResponse).toEqual(
    progress.afterResponse
  );
  expect(storedState(copiedStore, copied.chat.id)).toEqual({
    stateRevision: 2,
    state: { count: 2 + ORIGINAL.length },
  });
  expect(copiedStore.product.profile(copied.chat.id).extensionGrants).toBeUndefined();
  expect(execute).not.toHaveBeenCalled();
  expect(f.provider.requests).toHaveLength(providerCalls);
});
