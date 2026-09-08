import { createFixtureChat } from './fixtures/chat.js';
import { compileSnapshotPrompt } from '../server/prompt-snapshot.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Store } from '../server/store.js';
import { runStoryJob } from '../server/story-runner.js';
import { forkChat } from '../server/chat-fork.js';
import { validateStoryArchive } from '../server/story-archive.js';
import { deleteLibraryItem } from '../server/library-deletion.js';
import type { RunSnapshot } from '../core/types.js';
import type { StateMode } from '../core/state.js';

const owned: { directory: string; store: Store }[] = [];
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('External and paid calls forbidden in synthetic state dependency tests')
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const item of owned.splice(0).reverse()) {
    item.store.close();
    const path = resolve(item.directory);
    const within = relative(resolve(tmpdir()), path);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(path).startsWith('Uimori state dependencies ')
    )
      throw new Error('Unsafe test cleanup');
    await rm(path, { recursive: true, force: true });
  }
});
async function database() {
  const directory = await mkdtemp(join(tmpdir(), 'Uimori state dependencies '));
  const store = new Store(join(directory, 'synthetic.sqlite'));
  owned.push({ directory, store });
  return store;
}
function chat(store: Store) {
  const created = createFixtureChat(store, 'Synthetic state dependency regression');
  store.settings(created.id, created.settingsRevision, {
    ...created.settings,
    translation: false,
    status: false,
  });
  return created.id;
}
function activate(store: Store, chatId: string, mode: StateMode) {
  return store.story.saveConfig(chatId, {
    expectedRevision: store.story.config(chatId).revision,
    module: {
      id: 'wallet',
      revision: 1,
      name: 'Synthetic wallet',
      mode,
      fields: { coins: { type: 'number', initial: 10, min: 0, max: 100 } },
      rules: { purchase: { field: 'coins', delta: -3 } },
    },
    stateModel: null,
    memory: { enabled: false, model: null, recentCount: 2, maxPacketChars: 60000 },
  });
}
function request(store: Store, chatId: string, branchId?: string) {
  const chat = store.chat(chatId);
  const profile = store.product.snapshot(chatId);
  const task = 'Synthetic next scene';
  const branch = store.product.branch(chatId, branchId);
  return store.createRun(
    chatId,
    {
      request: task,
      expectedRevision: branch.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
      ...(branchId ? { branchId } : {}),
    },
    (selected) =>
      ({
        chatId,
        parentRevision: selected.headRevision,
        settingsRevision: selected.settingsRevision,
        settings: selected.settings,
        request: task,
        history: store.history(selected.headRevision),
        resources: store.product.resources(chatId, profile),
        profile,
      }) satisfies RunSnapshot
  ).run;
}
function source(store: Store, chatId: string, text: string) {
  const run = request(store, chatId);
  expect(run.status).toBe('queued');
  store.startRun(run.id);
  return store.completeRun(
    run.id,
    text,
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
}
function job(store: Store, chatId: string, revision: string) {
  const found = store.story
    .detail(chatId)
    .jobs.find((job) => job.sourceRevision === revision && job.kind === 'state');
  if (!found) throw new Error('State reservation missing');
  return found;
}
async function output(store: Store, id: string) {
  const outcome = await runStoryJob(store.story.bundle(id), {
    signal: new AbortController().signal,
    approvedOrigins: [],
    authorize: (value) => value,
    onAttemptStart: () => {
      throw new Error('Provider attempts forbidden');
    },
    onAttemptFinish: () => {},
    onInput: () => {},
    onToolEvent: () => {},
  });
  expect(outcome.status, outcome.error ?? '').toBe('completed');
  return outcome;
}
async function finish(store: Store, id: string, owner = 'state-fixture') {
  const claimed = store.story.claim(id, owner);
  expect(claimed).not.toBeNull();
  const outcome = await output(store, id);
  const completed = store.story.finish(id, claimed!.generation, owner, outcome);
  expect(completed.status).toBe('completed');
  return { claimed: claimed!, outcome };
}
function stateCount(store: Store, jobId: string) {
  return store.db.prepare('SELECT count(*) AS n FROM story_states WHERE job_id=?').get(jobId)!.n;
}

describe('S02 S03 actual Store continuity and activation dependencies', () => {
  test('historical story model snapshots restore after current settings release the deleted model', async () => {
    const store = await database(),
      id = chat(store);
    const initial = activate(store, id, 'authoritative');
    const connection = store.product.connection({
      title: 'Historical state connection',
      protocol: 'fixture-sse-v1',
      endpoint: 'http://127.0.0.1:44903/turn',
      enabled: true,
    });
    const model = store.product.model({
      title: 'Historical state model',
      connectionId: connection.id,
      modelId: 'fixture-historical-state',
      maxOutputTokens: 1024,
      temperature: null,
    });
    const selected = store.story.saveConfig(id, {
      expectedRevision: initial.revision,
      module: initial.module,
      stateModel: { id: model.id },
      memory: initial.memory,
    });
    const first = source(store, id, 'Historical model selection stays with this source.');
    const reserved = job(store, id, first.id);
    store.story.cancel(reserved.id);
    const historical = structuredClone(store.story.bundle(reserved.id).snapshot);
    store.story.saveConfig(id, {
      expectedRevision: selected.revision,
      module: selected.module,
      stateModel: null,
      memory: selected.memory,
    });
    deleteLibraryItem(store, 'model', model.id, { expectedRevision: model.revision });
    deleteLibraryItem(store, 'connection', connection.id, {
      expectedRevision: connection.revision,
    });
    const restored = await database();
    expect(() => restored.product.import(store.product.export())).not.toThrow();
    expect(restored.story.config(id).stateModel).toBeNull();
    expect(restored.story.bundle(reserved.id).snapshot.story?.models.state).toEqual({
      ...historical.story!.models.state,
      connection: { ...historical.story!.models.state!.connection, enabled: false },
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('current story settings replace one row while completed jobs and Run snapshots survive archive and fork', async () => {
    const store = await database(),
      id = chat(store);
    const originalConfig = activate(store, id, 'authoritative');
    const first = source(store, id, 'Original configuration. [[event:purchase]]');
    const firstJob = job(store, id, first.id);
    await finish(store, firstJob.id);
    const originalSnapshot = structuredClone(store.story.bundle(firstJob.id).snapshot);
    const currentConfig = store.story.saveConfig(id, {
      expectedRevision: originalConfig.revision,
      module: originalConfig.module,
      stateModel: originalConfig.stateModel,
      memory: { ...originalConfig.memory, recentCount: 3 },
    });
    expect(currentConfig.module).toEqual(originalConfig.module);
    expect(
      store.db.prepare('SELECT COUNT(*) AS n FROM story_configs WHERE chat_id=?').get(id)
    ).toMatchObject({ n: 1 });
    expect(() =>
      store.story.saveConfig(id, {
        expectedRevision: originalConfig.revision,
        module: originalConfig.module,
        stateModel: originalConfig.stateModel,
        memory: originalConfig.memory,
      })
    ).toThrow('Story settings revision conflict');
    expect(store.story.bundle(firstJob.id).snapshot).toEqual(originalSnapshot);
    const second = source(store, id, 'Current configuration.');
    const secondJob = job(store, id, second.id);
    await finish(store, secondJob.id);
    expect(store.story.bundle(secondJob.id).snapshot.story?.config).toEqual(currentConfig);
    const copy = forkChat(store, id, {
      fromRevision: second.id,
      title: 'Configuration snapshot fork',
      idempotencyKey: randomUUID(),
    });
    expect(store.story.config(copy.id)).toEqual(currentConfig);
    expect(
      store.story
        .detail(copy.id)
        .jobs.map((item) => item.configRevision)
        .sort()
    ).toEqual([originalConfig.revision, currentConfig.revision]);
    const restored = await database();
    restored.product.import(store.product.export());
    expect(restored.story.config(id)).toEqual(currentConfig);
    expect(restored.story.bundle(firstJob.id).snapshot).toEqual(originalSnapshot);
    expect(restored.story.config(copy.id)).toEqual(currentConfig);

    // The obsolete configuration no longer has a settings row, but copies sharing
    // its revision must still agree across the owning Run and auxiliary job.
    const forged = structuredClone(originalSnapshot);
    forged.story!.config.memory.recentCount = 99;
    store.db
      .prepare('UPDATE story_jobs SET snapshot=? WHERE id=?')
      .run(JSON.stringify(forged), firstJob.id);
    expect(() => validateStoryArchive(store)).toThrow('snapshot configuration mismatch');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('fork omits a current activation outside its ancestry without reviving old settings or reusing snapshot revisions', async () => {
    const store = await database(),
      id = chat(store);
    const originalConfig = activate(store, id, 'authoritative');
    const first = source(store, id, 'Retained old state. [[event:purchase]]');
    await finish(store, job(store, id, first.id).id);
    const second = source(store, id, 'Activation outside the selected ancestry.');
    await finish(store, job(store, id, second.id).id);
    store.story.saveConfig(id, {
      expectedRevision: originalConfig.revision,
      module: originalConfig.module,
      stateModel: originalConfig.stateModel,
      memory: originalConfig.memory,
      resetState: true,
    });
    const copy = forkChat(store, id, {
      fromRevision: first.id,
      title: 'Earlier configuration boundary',
      idempotencyKey: randomUUID(),
    });
    expect(store.story.config(copy.id)).toMatchObject({
      revision: 0,
      module: null,
      activatedAt: null,
    });
    const copiedJobs = store.story.detail(copy.id).jobs;
    expect(copiedJobs).toHaveLength(1);
    expect(store.story.bundle(copiedJobs[0].id).snapshot.story?.config).toEqual(originalConfig);
    expect(store.events(copy.id, 0).some((event) => event.kind === 'story.fork.excluded')).toBe(
      true
    );
    expect(() => validateStoryArchive(store)).not.toThrow();
    const configured = activate(store, copy.id, 'authoritative');
    expect(configured.revision).toBeGreaterThan(originalConfig.revision);
    expect(configured.module!.revision).toBeGreaterThan(originalConfig.module!.revision);
    expect(() => validateStoryArchive(store)).not.toThrow();
    const restored = await database();
    expect(() => restored.product.import(store.product.export())).not.toThrow();
    expect(restored.story.config(copy.id)).toEqual(configured);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('model IDs use latest settings for new reservations and rebuilds while existing snapshots stay fixed', async () => {
    const store = await database(),
      id = chat(store);
    const config = activate(store, id, 'authoritative');
    const connection = store.product.connection({
      title: 'Synthetic connection',
      protocol: 'fixture-sse-v1',
      endpoint: 'http://127.0.0.1:44901/turn',
      enabled: true,
    });
    const model = store.product.model({
      title: 'Synthetic model',
      connectionId: connection.id,
      modelId: 'fixture-state-first',
      maxOutputTokens: 1024,
      temperature: null,
    });
    const selected = store.story.saveConfig(id, {
      expectedRevision: config.revision,
      module: config.module,
      stateModel: { id: model.id },
      memory: config.memory,
    });
    expect(selected.stateModel).toEqual({ id: model.id });
    expect(() =>
      store.story.saveConfig(id, {
        expectedRevision: selected.revision,
        module: selected.module,
        stateModel: { id: model.id, revision: model.revision },
        memory: selected.memory,
      })
    ).toThrow('Unknown request field');
    const first = source(store, id, 'Snapshot ownership is preserved.'),
      before = job(store, id, first.id),
      frozen = store.story.bundle(before.id).snapshot;
    const changedModel = store.product.model(
      {
        title: 'Updated model',
        connectionId: connection.id,
        modelId: 'fixture-state-latest',
        maxOutputTokens: 2048,
        temperature: null,
        expectedRevision: model.revision,
      },
      model.id
    );
    const changedConnection = store.product.connection(
      {
        title: 'Updated connection',
        protocol: 'fixture-sse-v1',
        endpoint: 'http://127.0.0.1:44902/turn',
        enabled: true,
        expectedRevision: connection.revision,
      },
      connection.id
    );
    const rebuilt = store.story.rebuildSource(first.id, 'state');
    expect(rebuilt.id).not.toBe(before.id);
    expect(store.story.bundle(rebuilt.id).snapshot.story!.models.state).toEqual({
      ...changedModel,
      connection: changedConnection,
    });
    expect(store.story.bundle(before.id).snapshot).toEqual(frozen);
    expect(store.story.rebuildSource(first.id, 'state').id).toBe(rebuilt.id);
    const next = request(store, id);
    expect(next.snapshot.story!.models.state).toEqual({
      ...changedModel,
      connection: changedConnection,
    });
    expect(store.story.config(id)).toEqual(selected);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('continuity permits the next source but defers its state claim until the preceding state is ready; duplicate claims and completions cannot double-apply', async () => {
    const store = await database();
    const id = chat(store);
    activate(store, id, 'continuity');
    const first = source(store, id, 'First purchase. [[event:purchase]]');
    const firstJob = job(store, id, first.id);
    const firstClaim = store.story.claim(firstJob.id, 'delayed-first');
    expect(firstClaim).not.toBeNull();
    expect(store.story.claim(firstJob.id, 'duplicate-first')).toBeNull();
    const second = source(store, id, 'Then Mira waits; no additional purchase.');
    const secondJob = job(store, id, second.id);
    const originals = new Map(
      [first, second].map((source) => [
        source.runId,
        structuredClone(store.run(source.runId).snapshot),
      ])
    );
    expect(originals.get(second.runId)!.story!.state).toBeNull();
    expect(store.story.claim(secondJob.id, 'too-early')).toBeNull();
    expect(store.story.job(secondJob.id)).toMatchObject({
      status: 'queued',
      generation: 0,
      owner: null,
    });
    expect(stateCount(store, secondJob.id)).toBe(0);
    const firstResult = await output(store, firstJob.id);
    expect(
      store.story.finish(firstJob.id, firstClaim!.generation, 'wrong-owner', firstResult).status
    ).toBe('running');
    expect(
      store.story.finish(firstJob.id, firstClaim!.generation, 'delayed-first', firstResult).status
    ).toBe('completed');
    store.story.finish(firstJob.id, firstClaim!.generation, 'delayed-first', firstResult);
    expect(stateCount(store, firstJob.id)).toBe(1);
    expect(store.story.stateAt(id, first.id)?.values).toEqual({ coins: 7 });
    const secondClaim = store.story.claim(secondJob.id, 'second-owner');
    expect(secondClaim).not.toBeNull();
    expect(store.story.bundle(secondJob.id).snapshot.story?.state).toMatchObject({
      sourceRevision: first.id,
      values: { coins: 7 },
    });
    expect(store.story.claim(secondJob.id, 'duplicate-second')).toBeNull();
    const secondResult = await output(store, secondJob.id);
    expect(secondResult.result).toMatchObject({ operations: [] });
    expect(
      store.story.finish(secondJob.id, secondClaim!.generation + 1, 'second-owner', secondResult)
        .status
    ).toBe('running');
    store.story.finish(secondJob.id, secondClaim!.generation, 'second-owner', secondResult);
    store.story.finish(secondJob.id, secondClaim!.generation, 'second-owner', secondResult);
    expect(stateCount(store, secondJob.id)).toBe(1);
    expect(store.story.stateAt(id, second.id)?.values).toEqual({ coins: 7 });
    for (const [runId, snapshot] of originals) expect(store.run(runId).snapshot).toEqual(snapshot);
    expect(store.source(first.id).text).toBe(first.text);
    expect(store.source(second.id).text).toBe(second.text);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('continuity dependency hydration survives export/import and selected-ancestry fork while original Run snapshots remain unchanged', async () => {
    const store = await database();
    const id = chat(store);
    activate(store, id, 'continuity');
    const first = source(store, id, 'First purchase. [[event:purchase]]');
    const second = source(store, id, 'No second purchase.');
    const firstJob = job(store, id, first.id);
    const secondJob = job(store, id, second.id);
    const originalRun = structuredClone(store.run(second.runId).snapshot);
    expect(store.story.claim(secondJob.id, 'too-early')).toBeNull();
    await finish(store, firstJob.id);
    await finish(store, secondJob.id);
    expect(store.story.stateAt(id, second.id)?.values).toEqual({ coins: 7 });
    const restored = await database();
    const archive = store.product.export();
    expect(archive.version).toBe(14);
    expect(restored.product.import(archive).restored).toBe(true);
    expect(restored.run(second.runId).snapshot).toEqual(originalRun);
    expect(restored.story.bundle(secondJob.id).snapshot.story?.state?.values).toEqual({ coins: 7 });
    expect(restored.story.stateAt(id, second.id)?.values).toEqual({ coins: 7 });
    expect(restored.story.queued()).toEqual([]);
    const copied = forkChat(restored, id, {
      fromRevision: second.id,
      title: 'Continuity copy',
      idempotencyKey: randomUUID(),
    });
    expect(restored.story.stateAt(copied.id, copied.headRevision)?.values).toEqual({ coins: 7 });
    expect(restored.history(copied.headRevision).map((item) => item.text)).toEqual([
      first.text,
      second.text,
    ]);
    expect(restored.run(second.runId).snapshot).toEqual(originalRun);
    const copySource = restored.source(copied.headRevision!);
    expect(restored.run(copySource.runId).snapshot.story?.state).toBeNull();
    const copiedJob = job(restored, copied.id, copySource.id);
    expect(restored.story.bundle(copiedJob.id).snapshot.story?.state).toMatchObject({
      values: { coins: 7 },
    });
    expect(restored.story.bundle(copiedJob.id).snapshot.story?.state?.sourceRevision).not.toBe(
      first.id
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('explicit rebuild of an edited first activation source rebases initial state before that source and releases a waiting Run', async () => {
    const store = await database();
    const id = chat(store);
    const first = source(store, id, 'Pre-module activation source.');
    const originalRun = structuredClone(store.run(first.runId).snapshot);
    const config = activate(store, id, 'authoritative');
    expect(config.activatedAt).toEqual({ revision: first.id, hash: first.hash });
    store.editSource(first.id, {
      text: 'Edited activation purchase. [[event:purchase]]',
      expectedRevision: 0,
    });
    const waiting = request(store, id);
    expect(waiting.status).toBe('waiting_for_state');
    const rebuilt = store.story.rebuildSource(first.id, 'state');
    expect(store.story.bundle(rebuilt.id).snapshot.story?.state).toMatchObject({
      id: `initial:${id}:${config.module!.revision}:rebuild:${store.source(first.id).hash}`,
      sourceRevision: null,
      sourceHash: null,
      values: { coins: 10 },
    });
    await finish(store, rebuilt.id);
    expect(store.story.stateAt(id, first.id)?.values).toEqual({ coins: 7 });
    expect(store.story.resumeWaiting()).toEqual([waiting.id]);
    expect(store.run(waiting.id)).toMatchObject({
      status: 'queued',
      snapshot: { story: { waiting: false, state: { values: { coins: 7 } } } },
    });
    expect(store.run(first.runId).snapshot).toEqual(originalRun);
    expect(store.story.config(id).activatedAt).toEqual(config.activatedAt);
    const restored = await database();
    expect(restored.product.import(store.product.export()).restored).toBe(true);
    expect(restored.story.stateAt(id, first.id)?.values).toEqual({ coins: 7 });
    expect(restored.run(waiting.id).status).toBe('interrupted');
    const copied = forkChat(restored, id, {
      fromRevision: first.id,
      title: 'Recovered activation copy',
      idempotencyKey: randomUUID(),
    });
    expect(restored.story.stateAt(copied.id, copied.headRevision)?.values).toEqual({ coins: 7 });
    const poisoned = store.product.export();
    const originalRow = poisoned.tables.runs.find((row) => row.id === first.runId)!;
    const forgedSnapshot = JSON.parse(String(originalRow.snapshot));
    forgedSnapshot.story = store.story.bundle(rebuilt.id).snapshot.story;
    originalRow.snapshot = JSON.stringify(forgedSnapshot);
    const rejected = await database();
    expect(() => rejected.product.import(poisoned)).toThrow('compiled prompt mismatch');
    // Recompile the forged state to exercise the deeper state provenance check too.
    originalRow.snapshot = JSON.stringify(
      compileSnapshotPrompt({ ...forgedSnapshot, promptCompilation: undefined })
    );
    expect(() => rejected.product.import(poisoned)).toThrow('initial state mismatch');
    expect(rejected.chats()).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('activation at the second source rebuilds from its parent baseline and rejects rebuilding pre-activation history', async () => {
    const store = await database();
    const id = chat(store);
    const first = source(store, id, 'Earlier source has no module.');
    const second = source(store, id, 'Second source becomes activation.');
    const originals = [first, second].map((source) => ({
      id: source.runId,
      snapshot: structuredClone(store.run(source.runId).snapshot),
    }));
    const config = activate(store, id, 'authoritative');
    expect(config.activatedAt?.revision).toBe(second.id);
    store.editSource(second.id, {
      text: 'Rewritten activation. [[event:purchase]]',
      expectedRevision: 0,
    });
    expect(() => store.story.rebuildSource(first.id, 'state')).toThrow();
    const waiting = request(store, id);
    expect(waiting.status).toBe('waiting_for_state');
    const rebuilt = store.story.rebuildSource(second.id, 'state');
    expect(store.story.bundle(rebuilt.id).snapshot.story?.state).toMatchObject({
      id: `initial:${id}:${config.module!.revision}:rebuild:${store.source(second.id).hash}`,
      sourceRevision: first.id,
      sourceHash: first.hash,
      values: { coins: 10 },
    });
    await finish(store, rebuilt.id);
    expect(store.story.stateAt(id, second.id)?.values).toEqual({ coins: 7 });
    expect(store.story.resumeWaiting()).toEqual([waiting.id]);
    for (const original of originals)
      expect(store.run(original.id).snapshot).toEqual(original.snapshot);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('explicit state reset pins a new module revision to the selected branch and cancels old-rule waiting without rewriting history', async () => {
    const store = await database();
    const id = chat(store);
    const config = activate(store, id, 'authoritative');
    const first = source(store, id, 'First purchase. [[event:purchase]]');
    await finish(store, job(store, id, first.id).id);
    const firstState = structuredClone(store.story.stateAt(id, first.id));
    const selected = store.product.createBranch(id, {
      title: 'Selected reset branch',
      fromRevision: first.id,
    });
    const second = source(store, id, 'Second purchase pending. [[event:purchase]]');
    const waiting = request(store, id);
    expect(waiting.status).toBe('waiting_for_state');
    const snapshots = [first, second].map((source) => ({
      id: source.runId,
      snapshot: structuredClone(store.run(source.runId).snapshot),
    }));
    const reset = store.story.saveConfig(id, {
      expectedRevision: config.revision,
      module: config.module,
      stateModel: config.stateModel,
      memory: config.memory,
      branchId: selected.id,
      resetState: true,
    });
    expect(reset.revision).toBe(config.revision + 1);
    expect(reset.module!.revision).not.toBe(config.module!.revision);
    expect(reset.activatedAt).toEqual({ revision: first.id, hash: first.hash });
    expect(store.run(waiting.id).status).toBe('cancelled');
    expect(store.story.stateAt(id, first.id)?.values).toEqual({ coins: 10 });
    expect(store.story.stateAt(id, first.id, config)).toEqual(firstState);
    expect(store.story.config(id)).toEqual(reset);
    expect(store.story.bundle(job(store, id, first.id).id).snapshot.story?.config).toEqual(config);
    expect(
      store.db.prepare('SELECT COUNT(*) AS n FROM story_configs WHERE chat_id=?').get(id)
    ).toMatchObject({ n: 1 });
    const next = request(store, id, selected.id);
    expect(next.status).toBe('queued');
    expect(next.snapshot.story?.state).toMatchObject({
      sourceRevision: first.id,
      moduleRevision: reset.module!.revision,
      values: { coins: 10 },
    });
    for (const original of snapshots)
      expect(store.run(original.id).snapshot).toEqual(original.snapshot);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
