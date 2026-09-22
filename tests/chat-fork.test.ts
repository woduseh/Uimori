import { updateTestProfile } from './fixtures/model-workspace.js';
import { injectWithFixtureBot, createFixtureChat } from './fixtures/chat.js';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApp, type App } from '../server/app.js';
import { forkChat } from '../server/chat-fork.js';
import { Store, type Source } from '../server/store.js';
import { Controls } from '../server/controls.js';
import { auxiliaryBridge } from '../server/auxiliary-bridge.js';
import { runAuxiliaryJob } from '../server/product-auxiliary.js';
import { imageTargetSource } from '../server/package-images.js';
import { promptWorkspace, updatePromptWorkspace } from '../server/prompt-workspace.js';
import type { Content, PromptPreset, ChatProfile } from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';
import { readChatVariables } from '../server/chat-variables.js';

const owned: { directory: string; app?: App; store?: Store }[] = [];
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('External calls forbidden in fork tests')
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const item of owned.splice(0).reverse()) {
    if (item.app) await item.app.close();
    else item.store?.close();
    const target = resolve(item.directory);
    const within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('Uimori fork tests ')
    )
      throw new Error('Refusing cleanup outside owned test directory');
    await rm(target, { recursive: true, force: true });
  }
});
async function _application() {
  const directory = await mkdtemp(join(tmpdir(), 'Uimori fork tests '));
  const item: (typeof owned)[number] = { directory };
  owned.push(item);
  item.app = await createApp({
    dbPath: join(directory, 'story.sqlite'),
    buildId: 'fork-synthetic',
    instanceId: randomUUID(),
    testMode: true,
  });
  await item.app.ready();
  return item.app;
}
async function database() {
  const directory = await mkdtemp(join(tmpdir(), 'Uimori fork tests '));
  const store = new Store(join(directory, 'story.sqlite'));
  owned.push({ directory, store });
  return store;
}
const ref = ({ id, revision }: { id: string; revision: number }) => ({ id, revision });
const profileBody = (prior: ChatProfile, changes: Record<string, unknown> = {}) => ({
  expectedRevision: prior.revision,
  packageAttachments: prior.packageAttachments,

  routes: prior.routes,
  image: prior.image,
  ...changes,
});
function source(store: Store, chatId: string, value: string, branchId?: string) {
  const chat = store.chat(chatId);
  const branch = store.product.branch(chatId, branchId);
  const profile = {
    ...store.product.snapshot(chatId),
    variableState: readChatVariables(store, chatId, branch.id),
  };
  const request = 'Synthetic source, no model request';
  const run = store.createRun(
    chatId,
    {
      request,
      expectedRevision: branch.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      expectedProfileRevision: store.product.profile(chatId).revision,
      idempotencyKey: randomUUID(),
      ...(branchId ? { branchId } : {}),
    },
    (current) =>
      ({
        chatId,
        parentRevision: current.headRevision,
        settingsRevision: current.settingsRevision,
        settings: current.settings,
        request,
        history: store.history(current.headRevision),
        resources: store.product.resources(chatId, profile),
        ...(profile ? { profile } : {}),
      }) satisfies RunSnapshot
  ).run;
  store.startRun(run.id);
  return store.source(
    store.completeRun(
      run.id,
      value,
      { modelCalls: 3, inputTokens: 70, outputTokens: 90, costUsd: 0.04 },
      run.snapshot.settings
    ).id
  );
}
async function _fork(app: App, chatId: string, body: unknown, status = 200) {
  const response = await injectWithFixtureBot(app, {
    method: 'POST',
    url: '/api/chats/' + chatId + '/fork',
    payload: JSON.stringify(body),
    headers: { host: '127.0.0.1', 'content-type': 'application/json' },
  });
  expect(response.statusCode, response.body).toBe(status);
  return response.json();
}
async function translate(store: Store, jobId: string) {
  const signal = new AbortController().signal;
  const result = await runAuxiliaryJob(
    auxiliaryBridge(store, new Controls(), signal),
    jobId,
    'synthetic-fork-worker',
    {
      signal,

      authorize: (value) => value,
      onAttemptStart: () => {
        throw new Error('No provider transport allowed');
      },
      onAttemptFinish: () => {},
    }
  );
  expect(result?.status).toBe('completed');
  return store.job(jobId);
}
function finishOther(store: Store, revision: Source, assetId: string) {
  for (const job of store
    .detail(revision.chatId)
    .jobs.filter((job) => job.sourceRevision === revision.id && job.kind !== 'translation')) {
    const claimed = store.claimJob(job.id, 'synthetic-fork-worker', {})!;
    const result =
      job.kind === 'status'
        ? {
            mock: true,
            sourceRevision: revision.id,
            sourceHash: revision.hash,
            display: [
              {
                anchor: revision.blocks![0].anchor,
                summary: 'Synthetic display only',
                mood: 'quiet',
              },
            ],
          }
        : {
            mock: true,
            sourceRevision: revision.id,
            sourceHash: revision.hash,
            imageTarget: job.imageTarget,
            annotations: [
              {
                blockAnchor: imageTargetSource(store, store.job(job.id)).blocks![0].anchor,
                assetRef: assetId,
                assetRevision: 1,
                assetHash: store.product.asset(assetId).asset.hash,
                presentationIntent: 'inline',
                caption: 'Synthetic pixel',
              },
            ],
          };
    expect(store.completeJob(job.id, claimed.generation, 'synthetic-fork-worker', result)).toBe(
      true
    );
  }
}
const pixel =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWPY3RH6HwAGMgKYxcNPSgAAAABJRU5ErkJggg==';
async function _rich(app: App) {
  const store = app.store;
  const chat = createFixtureChat(store, 'Synthetic original');
  const main = store.product.promptPreset({
    role: 'main',
    title: 'Main prompt',
    text: '  MAIN exact\r\n',
  }) as PromptPreset;
  const translation = store.product.promptPreset({
    role: 'translation',
    title: 'Translation prompt',
    text: '  TRANSLATION exact\r\n',
  }) as PromptPreset;
  const lore = store.product.content({
    kind: 'module',
    title: 'Versioned lore',
    description: 'Synthetic',
    text: 'The lantern stands beside the sea.',
    loading: 'discoverable',
    relatedIds: [],
  }) as Content;
  updateTestProfile(
    store.product,
    chat.id,
    profileBody(store.product.profile(chat.id), {
      packageAttachments: [
        ...store.product.profile(chat.id).packageAttachments!,
        { ...ref(lore), role: 'module' },
      ],
      image: true,
    })
  );
  updatePromptWorkspace(store, {
    expectedRevision: promptWorkspace(store).revision,
    main: { title: main.title, program: main.program, values: {} },
    translation: { title: translation.title, program: translation.program, values: {} },
  });
  store.settings(chat.id, chat.settingsRevision, {
    ...chat.settings,
    preset: 'vivid',
    maxCalls: 4,
  });
  const asset = store.product.createAsset(chat.id, {
    title: 'Synthetic pixel',
    mime: 'image/png',
    base64: pixel,
    description: 'Synthetic pixel',
    actor: '',
    outfit: '',
    location: '',
    allowedUse: 'inline',
  });
  const first = source(
    store,
    chat.id,
    'Mira counted 9 lamps beside `north_gate`.\n\nThe old record literally names ' +
      chat.id +
      ' and resource:' +
      chat.id +
      ':harbor.'
  );
  const firstJob = store.requestTranslation(first.id);
  await translate(store, firstJob.id);
  finishOther(store, first, asset.id);
  const laterPrompt = store.product.promptPreset({
    role: 'translation',
    title: 'Later translation',
    text: '',
  }) as PromptPreset;
  updatePromptWorkspace(store, {
    expectedRevision: promptWorkspace(store).revision,
    translation: { title: laterPrompt.title, program: laterPrompt.program, values: {} },
  });
  const revised = store.retranslate(first.id);
  await translate(store, revised.id);
  const second = source(
    store,
    chat.id,
    [
      'The quiet traveler watched the waves softly wash against the pier while the evening lamps shone.',
      'The bellkeeper listened for a distant bell and left the next decision to the waiting traveler.',
    ].join('\n\n')
  );
  const secondJob = store.requestTranslation(second.id);
  await translate(store, secondJob.id);
  finishOther(store, second, asset.id);
  const third = source(store, chat.id, 'The descendant stays solely in the original story.');
  const pending = store.requestTranslation(third.id);
  const failed = store.retranslate(second.id);
  const claimed = store.claimJob(failed.id, 'failed-worker', {})!;
  store.failJob(failed.id, claimed.generation, 'failed-worker', 'Synthetic failure');
  store.product.mockAttempt(chat.id, first.runId, null, 'main', {
    role: 'main',
    task: 'Synthetic earlier attempt',
  });
  return {
    chat,
    first,
    second,
    third,
    asset,
    main,
    translation,
    laterPrompt,
    pending,
    secondJob,
    failed,
    revised,
  };
}

describe('independent stored-story fork without generation', () => {
  test('makes repeated keys durable, uses independent IDs even with identical automatic titles and rejects conflicting selections', async () => {
    const store = await database();
    const chat = createFixtureChat(store, 'Names');
    const first = source(store, chat.id, 'First scene.');
    const second = source(store, chat.id, 'Second scene.');
    const body = { fromRevision: first.id, idempotencyKey: 'stable-command' };
    const a = forkChat(store, chat.id, body);
    const b = forkChat(store, chat.id, { ...body, idempotencyKey: 'second-command' });
    expect([a.title, b.title]).toEqual(['Names (사본)', 'Names (사본)']);
    expect(forkChat(store, chat.id, body)).toEqual(a);
    expect(() => forkChat(store, chat.id, { ...body, fromRevision: second.id })).toThrow(
      '다른 채팅에 같은 가져오기 ID'
    );
    expect(() => forkChat(store, chat.id, { ...body, title: 'Different title' })).toThrow(
      '다른 채팅에 같은 가져오기 ID'
    );
    const item = owned.find((item) => item.store === store)!;
    store.close();
    item.store = undefined;
    const reopened = new Store(join(item.directory, 'story.sqlite'));
    item.store = reopened;
    expect(forkChat(reopened, chat.id, body)).toEqual(a);
    expect(reopened.chats()).toHaveLength(3);
    expect(
      forkChat(reopened, chat.id, {
        fromRevision: first.id,
        idempotencyKey: 'manual',
        title: 'Chosen title',
      }).title
    ).toBe('Chosen title');
    expect(fetch).not.toHaveBeenCalled();
  });
});
