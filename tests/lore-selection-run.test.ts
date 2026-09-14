import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { ContentPackage } from '../core/content-package.js';
import { DEFAULT_LORE_CONTEXT, type LoreContextPolicy } from '../core/lore-context.js';
import type { Connection, Content, ModelPreset } from '../core/product.js';
import { buildMainInput, executeTool } from '../core/provider.js';
import type { ModelInput, Run, RunSnapshot } from '../core/types.js';
import { createApp, type App } from '../server/app.js';
import { exportChatBackup, importChatBackup } from '../server/chat-backup.js';
import { prepareLoreSelection } from '../server/lore-selection.js';
import type { MainHooks } from '../server/model-runner.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { validateRunSnapshot } from '../server/snapshot-archive.js';
import { Store } from '../server/store.js';
import { createFixtureChat } from './fixtures/chat.js';
import { loopbackProvider, writeSse } from './fixtures/loopback-provider.js';

// 모델 선별 is a post-reservation input: the Run reserves uncompiled, one context-model call decides
// which discoverable lore this turn pins, the answer freezes on the snapshot, and every later
// compilation - a candidate, a backup restore, an archive replay - projects that same answer.

const MAIN_MODEL_ID = 'fixture-lore-selection-main';
const CONTEXT_MODEL_ID = 'fixture-lore-selection-context';
const PROSE = 'The pilot answers the harbor call.';
const REQUEST = 'Where is the harbor?';
const BODY = 'Synthetic package body.';
const HARBOR = 'The harbor is busy today and the eastern pier is under repair.';
const DRAGON = 'A dragon sleeps below the station.';
const STATION = 'The station never sleeps.';

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
      !basename(target).startsWith('uimori-lore-selection-')
    )
      throw new Error('Unsafe test cleanup');
    await rm(target, { recursive: true, force: true });
  }
});

function definition(mode: 'model' | 'discoverable' = 'model'): ContentPackage {
  return {
    version: 1,
    id: 'lore-selection-fixture',
    revision: 1,
    title: 'Synthetic selection pilot',
    description: 'Actual createApp model-selected lore fixture',
    body: BODY,
    loreActivation: { mode },
    lore: [
      { id: 'harbor', title: 'Harbor', description: '', text: HARBOR, loading: 'discoverable' },
      { id: 'dragon', title: 'Dragon', description: '', text: DRAGON, loading: 'discoverable' },
      { id: 'station', title: 'Station', description: '', text: STATION, loading: 'pinned' },
    ],
    instructions: [],
    controls: [],
    transforms: [],
  };
}

type FixtureOptions = {
  answer?: string;
  failContext?: boolean;
  maxCalls?: number;
  contextModel?: boolean;
  loreContext?: Partial<LoreContextPolicy>;
};

async function fixture(options: FixtureOptions = {}) {
  const provider = await loopbackProvider(async (request, response) => {
    const body = JSON.parse(request.body) as { modelId: string };
    if (body.modelId === CONTEXT_MODEL_ID) {
      if (options.failContext) {
        response.writeHead(500, { 'content-type': 'text/plain' }).end('selection unavailable');
        return;
      }
      await writeSse(response, [
        { type: 'text_delta', delta: options.answer ?? '{"selected":["harbor"]}' },
        { type: 'usage', inputTokens: 5, outputTokens: 3, costUsd: null },
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
  const directory = await mkdtemp(join(tmpdir(), 'uimori-lore-selection-app-'));
  const app = await createApp({
    dbPath: join(directory, 'story.sqlite'),
    buildId: 'lore-selection-app-test',
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
  let chat = createFixtureChat(app.store, 'Model lore selection', 'calm', { botId: content.id });
  chat = app.store.settings(chat.id, chat.settingsRevision, {
    ...chat.settings,
    translation: false,
    status: false,
    maxCalls: options.maxCalls ?? 4,
  });
  const connection = app.store.product.connection({
    title: 'Synthetic selection provider',
    protocol: 'fixture-sse-v1',
    endpoint: provider.endpoint,
    enabled: true,
  }) as Connection;
  const model = (name: string, modelId: string, maxOutputTokens = 128) =>
    app.store.product.model({
      title: name,
      connectionId: connection.id,
      modelId,
      maxOutputTokens,
      temperature: null,
    }) as ModelPreset;
  const mainModel = model('Synthetic selection main model', MAIN_MODEL_ID);
  // The context preset allows more than the selection ceiling, so the request shows the ceiling.
  const contextModel = model('Synthetic selection context model', CONTEXT_MODEL_ID, 2048);
  const workspace = modelWorkspace(app.store);
  updateModelWorkspace(app.store, {
    expectedRevision: workspace.revision,
    routes: { ...workspace.routes, main: { id: mainModel.id } },
    translationPolicy: workspace.translationPolicy,
    ...(options.contextModel === false ? {} : { contextModel: { id: contextModel.id } }),
  });
  if (options.loreContext) {
    const profile = app.store.product.profile(chat.id);
    app.store.product.updateProfile(chat.id, {
      expectedRevision: profile.revision,
      attachments: profile.attachments,
      packageAttachments: profile.packageAttachments,
      image: false,
      loreContext: { ...DEFAULT_LORE_CONTEXT, ...options.loreContext },
    });
  }
  return { app, chat, provider };
}

async function start(app: App, chatId: string) {
  const chat = app.store.chat(chatId);
  const response = await app.inject({
    method: 'POST',
    url: `/api/chats/${chatId}/runs`,
    payload: {
      request: REQUEST,
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

const contextModelIds = (provider: Awaited<ReturnType<typeof fixture>>['provider']) =>
  provider.requests.map((request) => JSON.parse(request.body).modelId as string);
const pinnedTexts = (snapshot: RunSnapshot) =>
  (buildMainInput(snapshot).pinnedSources ?? []).map((item) => item.text);
const catalogIds = (snapshot: RunSnapshot) => buildMainInput(snapshot).catalog.map((i) => i.id);
const loreResourceId = (snapshot: RunSnapshot, loreId: string) =>
  `package:${snapshot.profile!.packageAttachments![0].id}:bot:lore:${loreId}`;

/** Store-only reservations, for the phases that happen before any worker or provider exists. */
const stores: { directory: string; store: Store }[] = [];
afterEach(() => {
  for (const { directory, store } of stores.splice(0)) {
    store.close();
    const path = resolve(directory),
      within = relative(resolve(tmpdir()), path);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(path).startsWith('uimori-lore-selection-')
    )
      throw new Error('Unsafe fixture cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
function restored(archive: unknown) {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-lore-selection-archive-'));
  const store = new Store(join(directory, 'restored.sqlite'));
  stores.push({ directory, store });
  store.product.import(archive);
  return store;
}
function reserved(
  pkg = definition(),
  edit?: (snapshot: RunSnapshot) => void,
  withContextModel = false
) {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-lore-selection-store-'));
  const store = new Store(join(directory, 'fixture.sqlite'));
  stores.push({ directory, store });
  const content = store.product.content({
    kind: 'bot',
    title: pkg.title,
    description: pkg.description,
    text: pkg.body,
    loading: 'pinned',
    relatedIds: [],
    package: pkg,
  }) as Content;
  const chat = createFixtureChat(store, 'Model lore selection reservation', 'calm', {
    botId: content.id,
  });
  if (withContextModel) {
    const connection = store.product.connection({
      title: 'Synthetic reservation provider',
      protocol: 'fixture-sse-v1',
      endpoint: 'http://127.0.0.1:1/turn',
      enabled: true,
    }) as Connection;
    const contextModel = store.product.model({
      title: 'Synthetic reservation context model',
      connectionId: connection.id,
      modelId: CONTEXT_MODEL_ID,
      maxOutputTokens: 128,
      temperature: null,
    }) as ModelPreset;
    const workspace = modelWorkspace(store);
    updateModelWorkspace(store, {
      expectedRevision: workspace.revision,
      routes: workspace.routes,
      translationPolicy: workspace.translationPolicy,
      contextModel: { id: contextModel.id },
    });
  }
  const profile = store.product.snapshot(chat.id);
  const current = store.chat(chat.id);
  const { run } = store.createRun(
    chat.id,
    {
      request: REQUEST,
      expectedRevision: current.headRevision,
      expectedSettingsRevision: current.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (captured) => {
      const snapshot: RunSnapshot = {
        chatId: chat.id,
        parentRevision: captured.headRevision,
        settingsRevision: captured.settingsRevision,
        settings: captured.settings,
        request: REQUEST,
        history: store.history(captured.headRevision),
        resources: store.product.resources(chat.id, profile),
        profile,
      };
      edit?.(snapshot);
      return snapshot;
    }
  );
  return { store, chat, run: store.run(run.id) };
}

test('a model mode Run reserves uncompiled and the worker freezes the answer it pins', async () => {
  const pending = reserved();
  expect(pending.run.snapshot.loreSelection).toBeUndefined();
  expect(pending.run.snapshot.promptCompilation).toBeUndefined();
  expect(pending.run.snapshot.contextBase).toBeDefined();

  const f = await fixture();
  const completed = await terminal(f.app, (await start(f.app, f.chat.id)).id);

  expect(completed.status).toBe('completed');
  expect(contextModelIds(f.provider)).toEqual([CONTEXT_MODEL_ID, MAIN_MODEL_ID]);
  const entry = completed.snapshot.loreSelection!.entries[0];
  expect(completed.snapshot.loreSelection!.version).toBe(1);
  expect(entry.key).toMatch(/:bot$/u);
  expect(entry.inputHash).toMatch(/^[a-f0-9]{64}$/u);
  // The answer is an id list, so it needs more room than the 256 tokens the connection-test shell
  // allows and never more than the selection ceiling.
  expect(
    (JSON.parse(f.provider.requests[0].body) as { generation: { maxOutputTokens: number } })
      .generation.maxOutputTokens
  ).toBe(1024);
  expect(entry).toMatchObject({
    budget: DEFAULT_LORE_CONTEXT.maxRetainedChars,
    selected: ['harbor'],
    omitted: [],
    model: CONTEXT_MODEL_ID,
  });
  // The chosen entry is pinned; the one it passed over stays catalogued and readable.
  expect(pinnedTexts(completed.snapshot)).toEqual(expect.arrayContaining([HARBOR, STATION]));
  expect(pinnedTexts(completed.snapshot)).not.toContain(DRAGON);
  expect(catalogIds(completed.snapshot)).toContain(loreResourceId(completed.snapshot, 'dragon'));
  expect(
    executeTool(completed.snapshot, {
      callId: 'read-dragon',
      name: 'knowledge.read',
      args: { id: loreResourceId(completed.snapshot, 'dragon'), offset: 0, limit: 100 },
    })
  ).toMatchObject({ denied: false });
  expect(f.app.store.product.attempts(f.chat.id).map((attempt) => attempt.role)).toEqual([
    'context',
    'main',
  ]);
  expect(completed.usage).toMatchObject({ modelCalls: 2, inputTokens: 17, outputTokens: 11 });
});

test('the model order is trimmed to the lore budget and an unknown id decides nothing', async () => {
  const f = await fixture({
    answer: '{"selected":["harbor","dragon","harbor","nowhere"]}',
    loreContext: { maxRetainedChars: HARBOR.length },
  });
  const completed = await terminal(f.app, (await start(f.app, f.chat.id)).id);

  expect(completed.status).toBe('completed');
  expect(completed.snapshot.loreSelection!.entries[0]).toMatchObject({
    budget: HARBOR.length,
    selected: ['harbor'],
    omitted: [
      { id: 'dragon', reason: 'budget' },
      { id: 'nowhere', reason: 'unknown' },
    ],
  });
  expect(pinnedTexts(completed.snapshot)).toContain(HARBOR);
  expect(pinnedTexts(completed.snapshot)).not.toContain(DRAGON);
});

test('a zero budget selects nothing and still records a decision rather than an error', async () => {
  const f = await fixture({ loreContext: { maxRetainedChars: 0 } });
  const completed = await terminal(f.app, (await start(f.app, f.chat.id)).id);

  const entry = completed.snapshot.loreSelection!.entries[0];
  expect(entry).toMatchObject({
    budget: 0,
    selected: [],
    omitted: [{ id: 'harbor', reason: 'budget' }],
  });
  expect(entry.error).toBeUndefined();
  expect(pinnedTexts(completed.snapshot)).not.toContain(HARBOR);
  expect(catalogIds(completed.snapshot)).toContain(loreResourceId(completed.snapshot, 'harbor'));
});

test('an invalid answer and a provider failure both leave every entry discoverable', async () => {
  const invalid = await fixture({ answer: 'I picked the harbor entry for you.' });
  const first = await terminal(invalid.app, (await start(invalid.app, invalid.chat.id)).id);
  expect(first.status).toBe('completed');
  expect(first.snapshot.loreSelection!.entries[0]).toMatchObject({
    error: 'LORE_SELECTION_OUTPUT_INVALID',
    selected: [],
  });
  expect(pinnedTexts(first.snapshot)).not.toContain(HARBOR);
  expect(catalogIds(first.snapshot)).toContain(loreResourceId(first.snapshot, 'harbor'));

  const failed = await fixture({ failContext: true });
  const second = await terminal(failed.app, (await start(failed.app, failed.chat.id)).id);
  expect(second.status).toBe('completed');
  expect(second.snapshot.loreSelection!.entries[0].error).toBeTruthy();
  expect(pinnedTexts(second.snapshot)).not.toContain(HARBOR);
});

test('an unset context model skips the step without a provider request', async () => {
  const f = await fixture({ contextModel: false });
  const completed = await terminal(f.app, (await start(f.app, f.chat.id)).id);

  expect(completed.status).toBe('completed');
  expect(contextModelIds(f.provider)).toEqual([MAIN_MODEL_ID]);
  expect(completed.snapshot.loreSelection!.entries[0]).toMatchObject({
    error: 'MODEL_REQUIRED:context',
    selected: [],
  });
  expect(completed.usage.modelCalls).toBe(1);
});

test('the call budget leaves the main turn and records the refusal before any request', async () => {
  const f = await fixture({ maxCalls: 1 });
  const completed = await terminal(f.app, (await start(f.app, f.chat.id)).id);

  expect(completed.status).toBe('completed');
  expect(contextModelIds(f.provider)).toEqual([MAIN_MODEL_ID]);
  expect(completed.snapshot.loreSelection!.entries[0]).toMatchObject({
    error: 'LORE_SELECTION_CALL_LIMIT',
  });
  expect(completed.snapshot.loreSelection!.entries[0].model).toBeUndefined();
  expect(f.app.store.product.attempts(f.chat.id).map((attempt) => attempt.role)).toEqual(['main']);
});

test('the call budget counts the calls the Run spent before the step, not only this step', async () => {
  const pending = reserved(
    definition(),
    (snapshot) => {
      snapshot.settings = { ...snapshot.settings, maxCalls: 3 };
    },
    true
  );
  const hooks = {
    signal: new AbortController().signal,
    authorize: () => {
      throw new Error('The reservation fixture has no live connection');
    },
  } as unknown as MainHooks;

  // Two calls already spent plus the main turn fill the budget, although this step made none yet.
  const refused = await prepareLoreSelection(pending.run.snapshot, hooks, { reserveCalls: 3 });
  expect(refused.usage.modelCalls).toBe(0);
  expect(refused.snapshot.loreSelection!.entries[0]).toMatchObject({
    error: 'LORE_SELECTION_CALL_LIMIT',
  });
  expect(refused.snapshot.loreSelection!.entries[0].model).toBeUndefined();
  // The same Run with only the main turn reserved passes the budget and goes on to the connection.
  const admitted = await prepareLoreSelection(pending.run.snapshot, hooks, { reserveCalls: 1 });
  expect(admitted.snapshot.loreSelection!.entries[0].error).toBe('CONNECTION_NOT_AUTHORIZED');
});

test('a candidate reuses the frozen answer without a second selection request or attempt', async () => {
  const f = await fixture();
  const original = await terminal(f.app, (await start(f.app, f.chat.id)).id);
  const response = await f.app.inject({
    method: 'POST',
    url: `/api/runs/${original.id}/candidate`,
    payload: { idempotencyKey: randomUUID(), title: 'Selected lore candidate' },
  });
  expect(response.statusCode, response.body).toBe(200);
  const candidate = await terminal(f.app, (response.json() as Run).id);

  expect(candidate).toMatchObject({ status: 'completed', snapshot: { candidateOf: original.id } });
  expect(candidate.snapshot.loreSelection).toEqual(original.snapshot.loreSelection);
  expect(contextModelIds(f.provider)).toEqual([CONTEXT_MODEL_ID, MAIN_MODEL_ID, MAIN_MODEL_ID]);
  expect(f.app.store.product.attempts(f.chat.id).map((attempt) => attempt.role)).toEqual([
    'context',
    'main',
    'main',
  ]);
  expect(candidate.usage).toMatchObject({ modelCalls: 1 });
});

test('an archive round trip and a chat backup keep the answer, and a forged one is refused', async () => {
  const f = await fixture();
  const run = await terminal(f.app, (await start(f.app, f.chat.id)).id);
  expect(() => validateRunSnapshot(f.app.store, run.snapshot, run.id)).not.toThrow();

  const copy = importChatBackup(f.app.store, {
    backup: exportChatBackup(f.app.store, f.chat.id),
    idempotencyKey: 'lore-selection-copy',
  });
  const restored = (
    f.app.store.db.prepare('SELECT id FROM runs WHERE chat_id=?').all(copy.chat.id) as {
      id: string;
    }[]
  ).map((row) => f.app.store.run(row.id));
  const carried = restored.find((item) => item.snapshot.loreSelection !== undefined)!;
  expect(carried.id).not.toBe(run.id);
  expect(carried.snapshot.loreSelection).toEqual(run.snapshot.loreSelection);
  expect(() => validateRunSnapshot(f.app.store, carried.snapshot, carried.id)).not.toThrow();

  const swapped = structuredClone(run.snapshot);
  swapped.loreSelection!.entries[0].selected = ['dragon'];
  // A well formed swap passes the receipt's own checks; the prompt it compiled binds the decision.
  expect(() => validateRunSnapshot(f.app.store, swapped, run.id)).toThrow('compiled prompt');
  const foreign = structuredClone(run.snapshot);
  foreign.loreSelection!.entries[0].selected = ['station'];
  expect(() => validateRunSnapshot(f.app.store, foreign, run.id)).toThrow(
    'lore selection decided an unknown lore'
  );
  const rehashed = structuredClone(run.snapshot);
  rehashed.loreSelection!.entries[0].inputHash = 'b'.repeat(64);
  expect(() => validateRunSnapshot(f.app.store, rehashed, run.id)).toThrow(
    'lore selection receipt mismatch'
  );
  const dropped = structuredClone(run.snapshot);
  delete dropped.loreSelection;
  expect(() => validateRunSnapshot(f.app.store, dropped, run.id)).toThrow(
    'lore selection receipt missing'
  );
});

test('an archive allows only as many extra context attempts as the receipt records', async () => {
  const f = await fixture();
  const run = await terminal(f.app, (await start(f.app, f.chat.id)).id);
  expect(run.snapshot.contextPlan).toMatchObject({ status: 'ready', summaryCalls: 0 });
  expect(run.snapshot.loreSelection!.entries.filter((entry) => entry.model).length).toBe(1);
  const archive = JSON.parse(JSON.stringify(f.app.store.product.export())) as {
    tables: { attempts: Record<string, unknown>[] };
  };
  expect(() => restored(structuredClone(archive))).not.toThrow();

  const forged = structuredClone(archive);
  const selection = forged.tables.attempts.find((row) => row.role === 'context')!;
  forged.tables.attempts.push({ ...selection, id: 'forged-context-attempt' });
  expect(() => restored(forged)).toThrow('Context attempt count mismatch');
});

test('an authored opening and a discoverable package make no decision at all', () => {
  const authored = reserved(definition(), (snapshot) => {
    snapshot.packageStart = {
      mode: 'authored',
      packageId: 'lore-selection-fixture',
      packageRevision: 1,
      startId: 'authored-start',
      role: 'bot',
    } as never;
  });
  expect(authored.run.snapshot.loreSelection).toBeUndefined();
  expect(authored.run.snapshot.promptCompilation).toBeDefined();

  const plain = reserved(definition('discoverable'));
  expect(plain.run.snapshot.loreSelection).toBeUndefined();
  expect(plain.run.snapshot.promptCompilation).toBeDefined();
  expect(pinnedTexts(plain.run.snapshot)).not.toContain(HARBOR);
  expect(catalogIds(plain.run.snapshot)).toContain(loreResourceId(plain.run.snapshot, 'harbor'));
});

test('a Run with a recorded input keeps the receipt its compiled prompt was bound to', async () => {
  const f = await fixture();
  const run = await terminal(f.app, (await start(f.app, f.chat.id)).id);
  const input = f.app.store.run(run.id).inputs[0] as ModelInput | undefined;
  expect(input).toBeDefined();
  expect(JSON.stringify(input)).toContain(HARBOR);
});
