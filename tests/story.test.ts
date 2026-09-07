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
import { buildMainInput, executeTool } from '../core/provider.js';
import { resolveMemoryCheckpoint } from '../core/memory.js';
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
const memoryConfig = { enabled: true, model: null, recentCount: 2, maxPacketChars: 60000 };
function chat(store: Store, state = true, memory = true) {
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
    memory: { ...memoryConfig, enabled: memory },
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
function jobFor(store: Store, chatId: string, revision: string, kind: 'state' | 'memory') {
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

  test('S02 failed state keeps waiting until explicit retry succeeds, then freezes the resumed dependency', async () => {
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
    expect(store.story.resumeWaiting()).toEqual([]);
    expect(store.run(waiting.id).status).toBe('waiting_for_state');
    store.story.retry(job.id);
    await extract(store, job.id);
    expect(store.story.resumeWaiting()).toEqual([waiting.id]);
    const resumed = store.run(waiting.id);
    expect(resumed.status).toBe('queued');
    expect(resumed.snapshot.story?.state?.values).toEqual({ coins: 7 });
    expect(resumed.snapshot.story?.waiting).toBe(false);
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
    const memory = jobFor(store, id, original.id, 'memory');
    store.story.claim(state.id, 'process-before-restart');
    const path = store.path;
    store.close();
    item.store = new Store(path);
    const reopened = item.store;
    reopened.recover();
    reopened.story.recover();
    expect(reopened.story.job(state.id).status).toBe('interrupted');
    expect(reopened.story.queued()).toEqual([memory.id]);
    await extract(reopened, memory.id);
    expect(reopened.story.job(state.id).status).toBe('interrupted');
    expect(reopened.story.stateAt(id, original.id)).toBeNull();
    reopened.story.retry(state.id);
    await extract(reopened, state.id);
    expect(reopened.story.stateAt(id, original.id)?.values).toEqual({ coins: 7 });
  });

  test('S05 out-of-order memory completion preserves holes and main tools recover actual compacted historical text', async () => {
    const { store } = await database();
    const id = chat(store, false, true);
    const revisions = Array.from({ length: 6 }, (_, index) =>
      source(
        store,
        id,
        `chapter-${index}\n${'Long synthetic scene. '.repeat(400)}\nending-${index}`
      )
    );
    for (const revision of revisions.slice(1))
      await extract(store, jobFor(store, id, revision.id, 'memory').id);
    let scope = store.story.memory.scope(id, revisions.at(-1)!.id);
    expect(
      resolveMemoryCheckpoint(scope, store.story.memory.checkpoint(scope)).watermark
    ).toBeNull();
    await extract(store, jobFor(store, id, revisions[0].id, 'memory').id);
    scope = store.story.memory.scope(id, revisions.at(-1)!.id);
    expect(resolveMemoryCheckpoint(scope, store.story.memory.checkpoint(scope)).watermark).toBe(
      revisions.at(-1)!.id
    );
    const next = queued(store, id);
    const input = buildMainInput(next.snapshot);
    expect(input.history).toHaveLength(2);
    expect(next.snapshot.history).toHaveLength(6);
    const search = executeTool(next.snapshot, {
      callId: 'search-old',
      name: 'story.search',
      args: { query: 'ending-0' },
    });
    expect(search.denied).toBe(false);
    expect(JSON.stringify(search.result)).toContain(revisions[0].id);
    let offset: number | null = 0;
    let recovered = '';
    while (offset !== null) {
      const read = executeTool(next.snapshot, {
        callId: `read-${offset}`,
        name: 'story.read',
        args: { id: revisions[0].id, offset, limit: 997 },
      });
      expect(read.denied).toBe(false);
      const result = read.result as {
        text: string;
        nextOffset?: number | null;
        continuation?: { offset: number } | null;
      };
      recovered += result.text;
      offset = result.nextOffset ?? result.continuation?.offset ?? null;
    }
    expect(recovered).toBe(revisions[0].text);
    expect(store.source(revisions[0].id).text).toBe(revisions[0].text);
  });

  test('S04 stored author canon retcon is branch scoped and does not rewrite earlier Run snapshots', async () => {
    const { store } = await database();
    const id = chat(store, false, false);
    const first = source(store, id, 'The shared beginning.');
    const original = store.story.memory.authored(id, { text: 'The moon is blue.', author: 'user' });
    const right = store.product.createBranch(id, {
      title: 'Right candidate',
      fromRevision: first.id,
    });
    const leftSource = source(store, id, 'Left continuation.');
    const rightSource = source(store, id, 'Right continuation.', right.id);
    const earlierSnapshot = structuredClone(store.run(leftSource.runId).snapshot);
    const replacement = store.story.memory.authored(
      id,
      { text: 'The moon is red.', author: 'user' },
      original.id
    );
    expect(store.story.memory.entries(store.story.memory.scope(id, leftSource.id))).toEqual([
      replacement,
    ]);
    expect(store.story.memory.entries(store.story.memory.scope(id, rightSource.id))).toEqual([
      original,
    ]);
    expect(store.run(leftSource.runId).snapshot).toEqual(earlierSnapshot);
    const separate = chat(store, false, false);
    expect(() => store.story.memory.scope(separate, leftSource.id)).toThrow();
  });

  test('S04 persisted character belief retains actor and evidence without leaking into a sibling candidate', async () => {
    const { store } = await database();
    const id = chat(store, false, true);
    const first = source(store, id, 'A shared beginning.');
    const right = store.product.createBranch(id, {
      title: 'Other candidate',
      fromRevision: first.id,
    });
    const left = source(store, id, 'Alice believes the sealed door is safe.');
    const sibling = source(store, id, 'Bob waits at a different door.', right.id);
    const job = jobFor(store, id, left.id, 'memory');
    const claimed = store.story.claim(job.id, 'belief-fixture')!;
    const result = {
      entries: [
        {
          id: 'untrusted-provider-id',
          chatId: id,
          atRevision: left.id,
          atHash: left.hash,
          kind: 'character-belief',
          actor: 'Alice',
          text: 'Alice believes the sealed door is safe.',
          sources: [
            {
              revision: left.id,
              hash: left.hash,
              start: 0,
              end: left.text.length,
              quote: left.text,
            },
          ],
        },
      ],
    };
    const completed = store.story.finish(job.id, claimed.generation, 'belief-fixture', {
      status: 'completed',
      result,
      error: null,
      mock: true,
    });
    const entries = store.story.memory.entries(store.story.memory.scope(id, left.id));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'character-belief',
      actor: 'Alice',
      text: left.text,
      sources: [{ revision: left.id, hash: left.hash, quote: left.text }],
    });
    expect(entries[0].id).not.toBe('untrusted-provider-id');
    expect(completed.result).toEqual({ entries });
    expect(store.story.memory.entries(store.story.memory.scope(id, sibling.id))).toEqual([]);
    expect(store.story.memory.entries(store.story.memory.scope(id, first.id))).toEqual([]);
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
  test('S02 held state preserves readable source; cancellation and failure require retry before the HTTP waiting Run resumes', async () => {
    const app = await application();
    const created = await api(app, 'POST', '/api/chats', { title: 'Synthetic held state' });
    await api(app, 'PUT', `/api/chats/${created.id}/story/config`, {
      expectedRevision: 0,
      module,
      stateModel: null,
      memory: { ...memoryConfig, enabled: false },
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
    expect(app.store.run(waiting.id).status).toBe('waiting_for_state');
    await api(app, 'POST', '/api/test/control', { action: 'fail-next', point: 'state' });
    await api(app, 'POST', '/api/test/control', { action: 'release', barrier: 'state' });
    await api(app, 'POST', `/api/story-jobs/${stateJob.id}/retry`, {});
    await eventually(
      () => app.store.story.job(stateJob.id),
      (value) => value.status === 'failed'
    );
    expect(app.store.run(waiting.id).status).toBe('waiting_for_state');
    await api(app, 'POST', `/api/story-jobs/${stateJob.id}/retry`, {});
    const resumed = await eventually(
      () => app.store.run(waiting.id),
      (value) => value.status === 'completed'
    );
    expect(resumed.snapshot.story?.state?.values).toEqual({ coins: 7 });
    expect((await api(app, 'GET', `/api/sources/${original.id}/story`)).state.values).toEqual({
      coins: 7,
    });
  });

  test('S04 HTTP author declarations do not need transcripts and retcon preserves the old stored record', async () => {
    const app = await application();
    const created = await api(app, 'POST', '/api/chats', { title: 'Synthetic authored canon' });
    const first = await api(app, 'POST', `/api/chats/${created.id}/story/memory`, {
      text: 'The sea is silver.',
      author: 'user',
    });
    expect(first).toMatchObject({ kind: 'author-canon', atRevision: null, atHash: null });
    const replacement = await api(
      app,
      'POST',
      `/api/chats/${created.id}/story/memory/${first.id}/retcon`,
      { text: 'The sea is violet.', author: 'user' }
    );
    const detail = await api(app, 'GET', `/api/chats/${created.id}/story`);
    expect(detail.memory).toEqual([replacement]);
    expect(
      app.store.db
        .prepare('SELECT count(*) AS n FROM story_memories WHERE chat_id=?')
        .get(created.id)?.n
    ).toBe(2);
    expect(app.store.detail(created.id).sources).toEqual([]);
    expect(app.store.detail(created.id).attempts).toEqual([]);
    await api(app, 'PUT', `/api/chats/${created.id}/story/config`, {
      expectedRevision: 0,
      module: null,
      stateModel: null,
      memory: { ...memoryConfig, enabled: false, maxPacketChars: 1000 },
    });
    await api(app, 'POST', `/api/chats/${created.id}/story/memory`, {
      text: 'Mandatory authored constraint. '.repeat(100),
      author: 'user',
    });
    const current = app.store.chat(created.id);
    await api(
      app,
      'POST',
      `/api/chats/${created.id}/runs`,
      {
        request: 'Continue under authored constraints.',
        expectedRevision: null,
        expectedSettingsRevision: current.settingsRevision,
        idempotencyKey: randomUUID(),
      },
      409
    );
    expect(app.store.detail(created.id).runs).toEqual([]);
    expect(app.store.detail(created.id).attempts).toEqual([]);
  });
});
