import { writeNote } from './fixtures/notes.js';
import { createFixtureChat, injectWithFixtureBot } from './fixtures/chat.js';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { Controls } from '../server/controls.js';
import { createApp, type App } from '../server/app.js';
import { runStoryJob } from '../server/story-runner.js';
import { buildMainInput } from '../core/provider.js';
import { forkChat } from '../server/chat-fork.js';
import { exportChatBackup, importChatBackup } from '../server/chat-backup.js';
import * as reservation from '../server/reservation-snapshot.js';
import { PromptProgramError } from '../core/prompt-program.js';
import { PromptEvaluationError } from '../core/prompt-values.js';
import type { RunSnapshot, Run } from '../core/types.js';
import type { StateModule } from '../core/state.js';

const owned: { directory: string; store?: Store; app?: App }[] = [];
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('Paid and external calls forbidden in M2 story integration tests')
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
      !basename(target).startsWith('Uimori M2 story ')
    )
      throw new Error('Refusing cleanup outside owned synthetic test directory');
    await rm(target, { recursive: true, force: true });
  }
});
async function database() {
  const directory = await mkdtemp(join(tmpdir(), 'Uimori M2 story '));
  const store = new Store(join(directory, 'story.sqlite'));
  const item = { directory, store };
  owned.push(item);
  return { store, item };
}
async function application() {
  const directory = await mkdtemp(join(tmpdir(), 'Uimori M2 story '));
  const app = await createApp({
    dbPath: join(directory, 'story.sqlite'),
    buildId: 'M2-synthetic-only',
    instanceId: randomUUID(),
    testMode: true,
  });
  owned.push({ directory, app });
  await app.ready();
  return app;
}
const module: StateModule = {
  id: 'ticket-wallet',
  revision: 1,
  name: 'Ticket wallet',
  mode: 'authoritative',
  fields: { coins: { type: 'number', initial: 10, min: 0, max: 100 } },
  rules: { 'buy-ticket': { field: 'coins', delta: -3 } },
};
function chat(store: Store, state = true, _memory = true) {
  const created = createFixtureChat(store, 'Synthetic M2 contract');
  store.settings(created.id, created.settingsRevision, {
    ...created.settings,
    translation: false,
    status: false,
  });
  store.story.saveConfig(created.id, {
    expectedRevision: 0,
    module: state ? module : null,
    stateModel: null,
  });
  return created.id;
}
function queued(store: Store, chatId: string, request = 'Continue.', branchId?: string): Run {
  const current = store.chat(chatId);
  const profile = store.product.snapshot(chatId);
  const branch = store.product.branch(chatId, branchId);
  return store.createRun(
    chatId,
    {
      request,
      expectedRevision: branch.headRevision,
      expectedSettingsRevision: current.settingsRevision,
      idempotencyKey: randomUUID(),
      ...(branchId ? { branchId } : {}),
    },
    (selected) =>
      ({
        chatId,
        parentRevision: selected.headRevision,
        settingsRevision: selected.settingsRevision,
        settings: selected.settings,
        request,
        history: store.history(selected.headRevision),
        resources: store.product.resources(chatId, profile),
        profile,
      }) satisfies RunSnapshot
  ).run;
}
function source(
  store: Store,
  chatId: string,
  text = 'A ticket is bought. [[event:buy-ticket]]',
  branchId?: string
) {
  const run = queued(store, chatId, 'Synthetic source, no provider.', branchId);
  expect(run.status).toBe('queued');
  store.startRun(run.id);
  return store.completeRun(
    run.id,
    text,
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
}
function jobFor(store: Store, chatId: string, revision: string, kind: 'state') {
  const job = store.story
    .detail(chatId)
    .jobs.find((item) => item.sourceRevision === revision && item.kind === kind);
  if (!job) throw new Error('Expected durable story reservation');
  return job;
}
async function extract(store: Store, id: string) {
  const claimed = store.story.claim(id, 'synthetic-owner');
  expect(claimed).not.toBeNull();
  const result = await runStoryJob(store.story.bundle(id), {
    signal: new AbortController().signal,
    approvedOrigins: [],
    authorize: (connection) => connection,
    onAttemptStart: () => {
      throw new Error('No real provider attempt allowed');
    },
    onAttemptFinish: () => {},
    onInput: () => {},
    onToolEvent: () => {},
  });
  expect(result.status, result.error ?? '').toBe('completed');
  const finished = store.story.finish(id, claimed!.generation, 'synthetic-owner', result);
  return { claimed: claimed!, result, finished };
}
async function api(
  app: App,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  body?: unknown,
  expected = 200
): Promise<any> {
  const response = await injectWithFixtureBot(app, {
    method,
    url,
    headers: {
      host: '127.0.0.1',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  expect(response.statusCode, response.body).toBe(expected);
  return response.json();
}
async function eventually<T>(read: () => T, predicate: (value: T) => boolean, timeout = 5000) {
  const until = Date.now() + timeout;
  let value = read();
  while (!predicate(value) && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    value = read();
  }
  expect(predicate(value), JSON.stringify(value)).toBe(true);
  return value;
}

describe('M2 S01–S06 actual file SQLite integration', () => {
  test('S01 state 10→7 is applied once and is present in the next real main input', async () => {
    const { store } = await database();
    const id = chat(store);
    const original = source(store, id);
    const job = jobFor(store, id, original.id, 'state');
    const done = await extract(store, job.id);
    expect(store.story.stateAt(id, original.id)?.values).toEqual({ coins: 7 });
    store.story.finish(job.id, done.claimed.generation, 'synthetic-owner', done.result);
    expect(store.story.stateAt(id, original.id)?.values).toEqual({ coins: 7 });
    expect(
      store.db.prepare('SELECT count(*) AS n FROM story_states WHERE job_id=?').get(job.id)?.n
    ).toBe(1);
    const next = queued(store, id);
    expect(next.snapshot.story?.state?.values).toEqual({ coins: 7 });
    expect(JSON.stringify(buildMainInput(next.snapshot))).toContain('"coins":7');
    expect(store.source(original.id).text).toBe(original.text);
  });

  test('S02 a delayed authoritative state parks generation while original remains readable; cancelled wait never resumes', async () => {
    const { store } = await database();
    const id = chat(store);
    const original = source(store, id);
    const waiting = queued(store, id);
    expect(waiting.status).toBe('waiting_for_state');
    expect(store.source(original.id).text).toContain('[[event:buy-ticket]]');
    expect(store.story.resumeWaiting()).toEqual([]);
    store.finishRun(waiting.id, 'cancelled', 'User cancelled waiting request');
    await extract(store, jobFor(store, id, original.id, 'state').id);
    expect(store.story.resumeWaiting()).toEqual([]);
    expect(store.run(waiting.id).status).toBe('cancelled');
    expect(queued(store, id).status).toBe('queued');
  });

  test('S02 failed state releases the same Run with attributed fallback; a later retry never rewrites it', async () => {
    const { store } = await database();
    const id = chat(store);
    const original = source(store, id);
    const waiting = queued(store, id);
    const job = jobFor(store, id, original.id, 'state');
    const claim = store.story.claim(job.id, 'failing-worker')!;
    store.story.finish(job.id, claim.generation, 'failing-worker', {
      status: 'failed',
      result: null,
      error: 'Synthetic extraction failure',
      mock: true,
    });
    expect(store.story.resumeWaiting()).toEqual([waiting.id]);
    const frozen = structuredClone(store.run(waiting.id).snapshot);
    expect(frozen.story).toMatchObject({
      state: null,
      waiting: false,
      preparation: {
        status: 'failed',
        reason: 'STATE_FAILED',
        fallback: { values: { coins: 10 } },
        missing: [{ revision: original.id, hash: original.hash }],
      },
    });
    expect(buildMainInput(frozen)).toMatchObject({
      state: { values: { coins: 10 } },
      statePreparation: { status: 'failed' },
    });
    store.story.retry(job.id);
    await extract(store, job.id);
    expect(store.story.resumeWaiting()).toEqual([]);
    const resumed = store.run(waiting.id);
    expect(resumed.status).toBe('queued');
    expect(resumed.snapshot).toEqual(frozen);
    expect(resumed.snapshot.story?.waiting).toBe(false);
  });

  test('BPREP01 skipping is scoped, idempotent, and preserves the original reservation and late-result attribution', async () => {
    const { store } = await database();
    const id = chat(store);
    const original = source(store, id);
    const waiting = queued(store, id, 'Keep this exact request.');
    const before = structuredClone(waiting.snapshot);
    const payload = {
      chatId: id,
      branchId: before.branchId,
      expectedRevision: original.id,
      idempotencyKey: 'skip-once',
    };
    expect(() =>
      store.story.skipStateWait(waiting.id, { ...payload, chatId: chat(store) })
    ).toThrow('outside selected chat');
    expect(() =>
      store.story.skipStateWait(waiting.id, { ...payload, branchId: 'another-branch' })
    ).toThrow('outside selected chat');
    expect(() =>
      store.story.skipStateWait(waiting.id, { ...payload, expectedRevision: null })
    ).toThrow('Source revision conflict');
    expect(store.story.skipStateWait(waiting.id, payload).resumed).toBe(true);
    expect(store.story.skipStateWait(waiting.id, payload).resumed).toBe(false);
    const frozen = structuredClone(store.run(waiting.id).snapshot);
    for (const key of [
      'request',
      'history',
      'profile',
      'settings',
      'executionClock',
      'packageStates',
      'behaviorExecution',
    ] as const)
      expect(frozen[key]).toEqual(before[key]);
    expect(frozen.story).toMatchObject({
      state: null,
      waiting: false,
      preparation: { status: 'skipped', skipKey: 'skip-once' },
    });
    const job = jobFor(store, id, original.id, 'state');
    expect(job.status).toBe('queued');
    await extract(store, job.id);
    expect(store.story.resumeWaiting()).toEqual([]);
    expect(store.run(waiting.id).snapshot).toEqual(frozen);
    expect(store.source(original.id).text).toBe(original.text);
    expect(store.story.stateAt(id, original.id)?.values).toEqual({ coins: 7 });
    expect(store.startRun(waiting.id)).toBe(true);
    const next = store.completeRun(
      waiting.id,
      'Continued exact prose.',
      waiting.usage,
      waiting.snapshot.settings
    );
    const archived = exportChatBackup(store, id);
    const restored = importChatBackup(store, {
      backup: archived,
      idempotencyKey: 'restore-skipped',
    });
    const restoredRun = store
      .detail(restored.chat.id)
      .runs.find((run) => run.request === waiting.request)!;
    expect(restoredRun.snapshot.story?.preparation).toMatchObject({
      status: 'skipped',
      fallback: { values: { coins: 10 } },
    });
    expect(restoredRun.snapshot.story?.preparation?.missing[0].revision).not.toBe(original.id);
    const fork = forkChat(store, id, {
      fromRevision: next.id,
      title: 'Skipped-state fork',
      idempotencyKey: 'fork-skipped',
    });
    const forkRun = store.detail(fork.id).runs.find((run) => run.request === waiting.request)!;
    expect(forkRun.snapshot.story?.preparation?.missing[0].revision).not.toBe(original.id);
    expect(forkRun.snapshot.story?.preparation?.fallback?.values).toEqual({ coins: 10 });
    const tampered = store.product.export();
    const archivedRun = tampered.tables.runs.find((row) => row.id === waiting.id)!;
    const altered = JSON.parse(String(archivedRun.snapshot));
    altered.story.preparation.missing[0].hash = '0'.repeat(64);
    archivedRun.snapshot = JSON.stringify(altered);
    const { store: target } = await database();
    expect(() => target.product.import(tampered)).toThrow();
    expect(target.chats()).toEqual([]);
  });

  test.each(['skip-first', 'resume-first'] as const)(
    'BPREP05 state completion racing %s admits one unchanged Run',
    async (order) => {
      const { store } = await database();
      const id = chat(store);
      const first = source(store, id);
      const waiting = queued(store, id);
      await extract(store, jobFor(store, id, first.id, 'state').id);
      const payload = {
        chatId: id,
        branchId: waiting.snapshot.branchId,
        expectedRevision: first.id,
        idempotencyKey: 'completion-race',
      };
      if (order === 'skip-first') {
        expect(store.story.skipStateWait(waiting.id, payload).resumed).toBe(true);
        expect(store.story.resumeWaiting()).toEqual([]);
        expect(store.story.skipStateWait(waiting.id, payload).resumed).toBe(false);
      } else {
        expect(store.story.resumeWaiting()).toEqual([waiting.id]);
        expect(() => store.story.skipStateWait(waiting.id, payload)).toThrow('더 이상');
      }
      expect(store.run(waiting.id).snapshot.story).toMatchObject({
        state: { values: { coins: 7 } },
        preparation: { status: 'ready' },
      });
      expect(store.startRun(waiting.id)).toBe(true);
      expect(store.startRun(waiting.id)).toBe(false);
      expect(store.detail(id).runs).toHaveLength(2);
      expect(store.run(waiting.id).request).toBe(waiting.request);
    }
  );

  test('BPREP02 failed ancestors do not leave descendants waiting or become reducer input', async () => {
    const { store } = await database();
    const id = chat(store);
    const first = source(store, id);
    const parent = jobFor(store, id, first.id, 'state');
    const claim = store.story.claim(parent.id, 'failure')!;
    store.story.finish(parent.id, claim.generation, 'failure', {
      status: 'failed',
      result: null,
      error: 'Synthetic failure',
      mock: true,
    });
    const second = source(store, id, 'Another purchase. [[event:buy-ticket]]');
    const child = jobFor(store, id, second.id, 'state');
    expect(store.story.bundle(child.id).snapshot.story?.state).toBeNull();
    expect(store.story.claim(child.id, 'must-not-skip-parent')).toBeNull();
    const next = queued(store, id);
    expect(next.status).toBe('queued');
    expect(next.snapshot.story?.preparation?.missing).toHaveLength(2);
    expect(next.snapshot.story?.preparation?.status).toBe('failed');
    const frozen = structuredClone(next.snapshot);
    store.story.retry(parent.id);
    await extract(store, parent.id);
    await extract(store, child.id);
    expect(store.story.stateAt(id, second.id)?.values).toEqual({ coins: 4 });
    expect(store.run(next.id).snapshot).toEqual(frozen);
  });

  test('BPREP03 source changes and cancellation reject skipping; restart does not start unsent waiting Runs', async () => {
    const { store } = await database();
    const id = chat(store);
    const first = source(store, id);
    const waiting = queued(store, id);
    const payload = {
      chatId: id,
      branchId: waiting.snapshot.branchId,
      expectedRevision: first.id,
      idempotencyKey: 'skip-edited',
    };
    store.editSource(first.id, { text: 'Edited source.', expectedRevision: 0 });
    expect(() => store.story.skipStateWait(waiting.id, payload)).toThrow('원문 또는 작가 설정');
    expect(store.run(waiting.id).status).toBe('waiting_for_state');
    store.finishRun(waiting.id, 'cancelled', 'User cancelled');
    expect(() => store.story.skipStateWait(waiting.id, payload)).toThrow('더 이상');
    const otherId = chat(store);
    source(store, otherId);
    const parked = queued(store, otherId);
    expect(parked.status).toBe('waiting_for_state');
    store.recover();
    store.story.recover();
    expect(store.run(parked.id).status).toBe('interrupted');
    expect(store.story.resumeWaiting()).toEqual([]);
    expect(store.detail(otherId).sources).toHaveLength(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test.each([
    new PromptProgramError('PROMPT_UNKNOWN_SLOT'),
    new PromptEvaluationError('PROMPT_STEP_LIMIT'),
  ])('BPREP06 waiting prompt $name does not prevent another chat from resuming', async (error) => {
    const { store } = await database();
    const blockedId = chat(store);
    const healthyId = chat(store);
    const first = source(store, blockedId);
    const second = source(store, healthyId);
    const broken = queued(store, blockedId);
    const healthy = queued(store, healthyId);
    await extract(store, jobFor(store, blockedId, first.id, 'state').id);
    await extract(store, jobFor(store, healthyId, second.id, 'state').id);
    const freeze = reservation.freezeReservationSnapshot;
    const spy = vi
      .spyOn(reservation, 'freezeReservationSnapshot')
      .mockImplementation((owner, input, options) => {
        if (input.chatId === blockedId && options.purpose === 'resume-state') throw error;
        return freeze(owner, input, options);
      });
    expect(store.story.resumeWaiting()).toEqual([healthy.id]);
    expect(store.run(broken.id)).toMatchObject({ status: 'failed', error: error.message });
    expect(store.run(healthy.id).status).toBe('queued');
    spy.mockRestore();
  });

  test.each([
    Object.assign(new Error('Synthetic database failure'), { code: 'SQLITE_FULL' }),
    new Error('Unclassified preparation failure'),
  ])('BPREP06 storage or unclassified errors still propagate: $message', async (error) => {
    const { store } = await database();
    const storageId = chat(store);
    const original = source(store, storageId);
    const waiting = queued(store, storageId);
    await extract(store, jobFor(store, storageId, original.id, 'state').id);
    vi.spyOn(reservation, 'freezeReservationSnapshot').mockImplementation(() => {
      throw error;
    });
    expect(() => store.story.resumeWaiting()).toThrow(error);
    expect(store.run(waiting.id).status).toBe('waiting_for_state');
  });

  test('S03 late source-edit result is stale and prior source state remains an immutable historical artifact', async () => {
    const { store } = await database();
    const id = chat(store);
    const first = source(store, id);
    await extract(store, jobFor(store, id, first.id, 'state').id);
    const old = structuredClone(store.story.sourceDetail(first.id).state);
    const second = source(store, id);
    const job = jobFor(store, id, second.id, 'state');
    const claim = store.story.claim(job.id, 'late-worker')!;
    const late = await runStoryJob(store.story.bundle(job.id), {
      signal: new AbortController().signal,
      approvedOrigins: [],
      authorize: (connection) => connection,
      onAttemptStart: () => {
        throw new Error('No paid call');
      },
      onAttemptFinish: () => {},
      onInput: () => {},
      onToolEvent: () => {},
    });
    store.editSource(second.id, { text: 'No ticket was bought.', expectedRevision: 0 });
    expect(store.story.finish(job.id, claim.generation, 'late-worker', late).status).toBe('stale');
    expect(store.story.stateAt(id, second.id)).toBeNull();
    expect(store.story.sourceDetail(first.id).state).toEqual(old);
    store.editSource(first.id, { text: 'An explicit earlier rewrite.', expectedRevision: 0 });
    expect(store.story.sourceDetail(first.id)).toMatchObject({ state: old, status: 'stale' });
    expect(old?.values).toEqual({ coins: 7 });
  });

  test('S03 restart retains queued work, interrupts uncertain running work, and does not replay it automatically', async () => {
    const { store, item } = await database();
    const id = chat(store);
    const original = source(store, id);
    const state = jobFor(store, id, original.id, 'state');
    const queuedChat = chat(store);
    const queuedSource = source(store, queuedChat);
    const queuedState = jobFor(store, queuedChat, queuedSource.id, 'state');
    store.story.claim(state.id, 'process-before-restart');
    const path = store.path;
    store.close();
    item.store = new Store(path);
    const reopened = item.store;
    reopened.recover();
    reopened.story.recover();
    expect(reopened.story.job(state.id).status).toBe('interrupted');
    expect(reopened.story.queued()).toEqual([queuedState.id]);
    await extract(reopened, queuedState.id);
    expect(reopened.story.job(state.id).status).toBe('interrupted');
    expect(reopened.story.stateAt(id, original.id)).toBeNull();
    reopened.story.retry(state.id);
    await extract(reopened, state.id);
    expect(reopened.story.stateAt(id, original.id)?.values).toEqual({ coins: 7 });
  });

  test('S04 stored author canon retcon is branch scoped and does not rewrite earlier Run snapshots', async () => {
    const { store } = await database();
    const id = chat(store, false, false);
    const first = source(store, id, 'The shared beginning.');
    const original = writeNote(store, id, { text: 'The moon is blue.', author: 'user' });
    const right = store.product.createBranch(id, {
      title: 'Right candidate',
      fromRevision: first.id,
    });
    const leftSource = source(store, id, 'Left continuation.');
    const rightSource = source(store, id, 'Right continuation.', right.id);
    const earlierSnapshot = structuredClone(store.run(leftSource.runId).snapshot);
    const replacement = writeNote(
      store,
      id,
      { text: 'The moon is red.', author: 'user' },
      original.id
    );
    expect(store.story.notes.entries(store.story.notes.scope(id, leftSource.id))).toEqual([
      replacement,
    ]);
    expect(store.story.notes.entries(store.story.notes.scope(id, rightSource.id))).toEqual([
      original,
    ]);
    expect(store.run(leftSource.runId).snapshot).toEqual(earlierSnapshot);
    const separate = chat(store, false, false);
    expect(() => store.story.notes.scope(separate, leftSource.id)).toThrow();
  });

  test('S01 source transaction failure rolls back original, Run completion and all durable story reservations', async () => {
    const { store } = await database();
    const id = chat(store);
    const run = queued(store, id);
    store.startRun(run.id);
    const controls = new Controls();
    controls.failures.add('source-transaction');
    expect(() =>
      store.completeRun(
        run.id,
        '[[event:buy-ticket]]',
        { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
        run.snapshot.settings,
        controls
      )
    ).toThrow('source-transaction');
    expect(store.run(run.id).status).toBe('running');
    expect(store.chat(id).headRevision).toBeNull();
    expect(store.db.prepare('SELECT count(*) AS n FROM sources').get()?.n).toBe(0);
    expect(store.db.prepare('SELECT count(*) AS n FROM story_jobs').get()?.n).toBe(0);
    const reserve = store.story.reserveSourceInTransaction.bind(store.story);
    const spy = vi
      .spyOn(store.story, 'reserveSourceInTransaction')
      .mockImplementation((src, current) => {
        reserve(src, current);
        throw new Error('Crash after durable story reservation');
      });
    expect(() =>
      store.completeRun(
        run.id,
        '[[event:buy-ticket]]',
        { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
        run.snapshot.settings
      )
    ).toThrow('Crash after durable story reservation');
    spy.mockRestore();
    expect(store.db.prepare('SELECT count(*) AS n FROM sources').get()?.n).toBe(0);
    expect(store.db.prepare('SELECT count(*) AS n FROM story_jobs').get()?.n).toBe(0);
    expect(store.run(run.id).status).toBe('running');
  });

  test('S06 scene commands are consumed only with successful source commit; cancelled or failed runs never consume', async () => {
    const { store } = await database();
    const id = chat(store, false, false);
    const command = store.story.createCommand(id, {
      label: 'Buy ticket',
      request: 'Buy one ticket.',
      idempotencyKey: randomUUID(),
    });
    const first = queued(store, id, command.request);
    store.transaction(() => store.story.bindCommandInTransaction(command.id, first.id));
    store.finishRun(first.id, 'cancelled', 'User cancelled');
    expect(store.story.command(command.id)).toMatchObject({
      status: 'cancelled',
      sourceRevision: null,
    });
    const retry = queued(store, id, command.request);
    store.transaction(() => store.story.bindCommandInTransaction(command.id, retry.id));
    store.startRun(retry.id);
    const result = store.completeRun(
      retry.id,
      'A ticket.',
      { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
      retry.snapshot.settings
    );
    expect(store.story.command(command.id)).toMatchObject({
      status: 'consumed',
      runId: retry.id,
      sourceRevision: result.id,
    });
    const duplicate = queued(store, id, command.request);
    expect(() =>
      store.transaction(() => store.story.bindCommandInTransaction(command.id, duplicate.id))
    ).toThrow('unavailable');
    store.finishRun(duplicate.id, 'cancelled', 'Duplicate command rejected');
    const failedCommand = store.story.createCommand(id, {
      label: 'Try',
      request: 'Try another scene.',
      idempotencyKey: randomUUID(),
    });
    const failed = queued(store, id, failedCommand.request);
    store.transaction(() => store.story.bindCommandInTransaction(failedCommand.id, failed.id));
    store.finishRun(failed.id, 'failed', 'Synthetic run failure');
    expect(store.story.command(failedCommand.id).status).toBe('failed');
  });
});

describe('M2 HTTP state controls and authored memory', () => {
  test('S02 cancelling state releases the HTTP Run; failed and successful state retries never repeat its prose', async () => {
    const app = await application();
    const created = await api(app, 'POST', '/api/chats', { title: 'Synthetic held state' });
    await api(app, 'PUT', `/api/chats/${created.id}/story/config`, {
      expectedRevision: 0,
      module,
      stateModel: null,
    });
    await api(app, 'POST', '/api/test/control', { action: 'hold', barrier: 'state' });
    const send = (request: string) => {
      const current = app.store.chat(created.id);
      return api(app, 'POST', `/api/chats/${created.id}/runs`, {
        request,
        expectedRevision: current.headRevision,
        expectedSettingsRevision: current.settingsRevision,
        idempotencyKey: randomUUID(),
      });
    };
    const first = await send('A ticket is purchased. [[event:buy-ticket]]');
    const finished = await eventually(
      () => app.store.run(first.id),
      (value) => value.status === 'completed'
    );
    const original = app.store.source(finished.sourceRevision!);
    expect(original.text).toContain('[[event:buy-ticket]]');
    const jobs = await eventually(
      () => app.store.story.detail(created.id).jobs,
      (jobs) => jobs.some((job) => job.kind === 'state' && job.status === 'running')
    );
    const stateJob = jobs.find((job) => job.kind === 'state')!;
    const waiting = await send('Continue with the remaining coins.');
    expect(waiting.status).toBe('waiting_for_state');
    const detail = await api(app, 'GET', `/api/chats/${created.id}`);
    expect(detail.sources.find((entry: { id: string }) => entry.id === original.id).text).toBe(
      original.text
    );
    expect((await api(app, 'POST', `/api/story-jobs/${stateJob.id}/cancel`, {})).status).toBe(
      'cancelled'
    );
    const continued = await eventually(
      () => app.store.run(waiting.id),
      (value) => value.status === 'completed'
    );
    const frozen = structuredClone(continued.snapshot);
    expect(frozen.story).toMatchObject({
      state: null,
      preparation: { status: 'failed', reason: 'STATE_CANCELLED' },
    });
    await api(app, 'POST', '/api/test/control', { action: 'fail-next', point: 'state' });
    await api(app, 'POST', '/api/test/control', { action: 'release', barrier: 'state' });
    await api(app, 'POST', `/api/story-jobs/${stateJob.id}/retry`, {});
    await eventually(
      () => app.store.story.job(stateJob.id),
      (value) => value.status === 'failed'
    );
    expect(app.store.run(waiting.id).snapshot).toEqual(frozen);
    await api(app, 'POST', `/api/story-jobs/${stateJob.id}/retry`, {});
    const resumed = await eventually(
      () => app.store.run(waiting.id),
      (value) => value.status === 'completed'
    );
    expect(resumed.snapshot).toEqual(frozen);
    await eventually(
      () => app.store.story.stateAt(created.id, original.id),
      (state) => state?.values.coins === 7
    );
    expect(
      app.store.detail(created.id).runs.filter((run) => run.request === waiting.request)
    ).toHaveLength(1);
  });

  test('BPREP04 HTTP skip validates scope and sends the waiting main only once while its state task continues', async () => {
    const app = await application();
    const created = await api(app, 'POST', '/api/chats', { title: 'Synthetic skip state' });
    await api(app, 'PUT', `/api/chats/${created.id}/story/config`, {
      expectedRevision: 0,
      module,
      stateModel: null,
    });
    await api(app, 'POST', '/api/test/control', { action: 'hold', barrier: 'state' });
    const send = (request: string) => {
      const current = app.store.chat(created.id);
      return api(app, 'POST', `/api/chats/${created.id}/runs`, {
        request,
        expectedRevision: current.headRevision,
        expectedSettingsRevision: current.settingsRevision,
        idempotencyKey: randomUUID(),
      });
    };
    const first = await send('First purchase. [[event:buy-ticket]]');
    await eventually(
      () => app.store.run(first.id),
      (run) => run.status === 'completed'
    );
    const waiting = await send('Write despite pending state.');
    expect(waiting.status).toBe('waiting_for_state');
    const payload = {
      chatId: created.id,
      branchId: waiting.snapshot.branchId,
      expectedRevision: waiting.parentRevision,
      idempotencyKey: 'http-skip',
    };
    const path = `/api/runs/${waiting.id}/skip-state-wait`;
    await api(app, 'POST', path, { ...payload, chatId: 'wrong-chat' }, 404);
    await api(app, 'POST', path, { ...payload, expectedRevision: null }, 409);
    await api(app, 'POST', path, payload);
    await api(app, 'POST', path, payload);
    const finished = await eventually(
      () => app.store.run(waiting.id),
      (run) => run.status === 'completed'
    );
    expect(finished.snapshot.story?.preparation?.status).toBe('skipped');
    expect(app.store.detail(created.id).sources).toHaveLength(2);
    expect(app.store.story.detail(created.id).jobs.some((job) => job.status === 'running')).toBe(
      true
    );
    const frozen = structuredClone(finished.snapshot);
    await api(app, 'POST', '/api/test/control', { action: 'release', barrier: 'state' });
    await eventually(
      () => app.store.story.detail(created.id).jobs,
      (jobs) => jobs.every((job) => job.status === 'completed')
    );
    expect(app.store.run(waiting.id).snapshot).toEqual(frozen);
  });

  test('explicit notes need no transcripts, use CAS and preserve their replaced records without provider calls', async () => {
    const app = await application();
    const created = await api(app, 'POST', '/api/chats', { title: 'Synthetic notes' });
    const first = await api(app, 'POST', `/api/chats/${created.id}/notes`, {
      text: 'The sea is silver.',
      author: 'user',
      expectedRevision: 0,
      expectedHeadRevision: null,
      idempotencyKey: 'note-one',
    });
    expect(first.note).toMatchObject({ kind: 'author-note', atRevision: null, atHash: null });
    const replacement = await api(app, 'POST', `/api/chats/${created.id}/notes`, {
      text: 'The sea is violet.',
      author: 'user',
      replacesId: first.note.id,
      expectedRevision: 1,
      expectedHeadRevision: null,
      idempotencyKey: 'note-two',
    });
    const detail = await api(app, 'GET', `/api/chats/${created.id}/story`);
    expect(detail.notes).toEqual([replacement.note]);
    expect(detail.notesRevision).toBe(2);
    expect(
      app.store.db.prepare('SELECT count(*) AS n FROM author_notes WHERE chat_id=?').get(created.id)
        ?.n
    ).toBe(2);
    expect(app.store.detail(created.id).sources).toEqual([]);
    expect(app.store.detail(created.id).attempts).toEqual([]);
    await api(
      app,
      'POST',
      `/api/chats/${created.id}/notes`,
      {
        text: 'Stale correction',
        author: 'user',
        expectedRevision: 0,
        expectedHeadRevision: null,
        idempotencyKey: 'stale-note',
      },
      409
    );
  });

  test('imported memories preserve exact text and origin with note CAS, archive and internal chat identity', async () => {
    const { store } = await database();
    const owner = createFixtureChat(store, 'Synthetic note owner');
    const id = randomUUID();
    const created = store.createChat('Imported notes', 'calm', { botId: owner.botId }, id);
    expect(created.id).toBe(id);
    const origin = { fileHash: 'a'.repeat(64), entryId: 'history-1', title: 'External history' };
    const command = {
      kind: 'imported-memory',
      origin,
      text: '  A prior account.\r\nNo source transcript.  ',
      author: 'External author',
      expectedRevision: 0,
      expectedHeadRevision: null,
      idempotencyKey: 'imported-memory-one',
    };
    const saved = store.story.notes.write(id, command);
    expect(saved.note).toMatchObject({
      kind: 'imported-memory',
      origin,
      text: command.text,
      atRevision: null,
      atHash: null,
    });
    expect(store.story.notes.write(id, command)).toEqual(saved);
    expect(() => store.story.notes.write(id, { ...command, text: 'changed' })).toThrow(
      'key reused'
    );
    expect(() => store.story.notes.write(id, { ...command, idempotencyKey: 'stale' })).toThrow(
      '메모가 변경'
    );
    expect(() =>
      store.story.notes.write(id, {
        ...command,
        expectedRevision: 1,
        origin: undefined,
        idempotencyKey: 'invalid-origin',
      })
    ).toThrow('Invalid note');
    expect(store.story.notes.revision(id)).toBe(1);
    expect(store.detail(id).sources).toEqual([]);
    expect(store.detail(id).attempts).toEqual([]);
    expect(() => store.createChat('Duplicate', 'calm', { botId: owner.botId }, id)).toThrow();
    expect(store.chat(id).title).toBe('Imported notes');
    const { store: restored } = await database();
    restored.product.import(store.product.export());
    expect(restored.story.notes.entries({ chatId: id, history: [] })).toEqual([saved.note]);
  });
});
