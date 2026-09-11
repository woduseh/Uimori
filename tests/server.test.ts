import { injectWithFixtureBot, fixtureBotInput } from './fixtures/chat.js';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { backup, DatabaseSync } from 'node:sqlite';
import { createApp, type App } from '../server/app.js';
import type { Chat, ChatDetail, Run } from '../core/types.js';
import type { HelperConversation } from '../core/helper.js';

const owned: { app?: App; directory: string; child?: ChildProcess }[] = [];
afterEach(async () => {
  for (const item of owned.reverse()) {
    if (item.child && item.child.exitCode === null && item.child.signalCode === null) {
      item.child.kill();
      await new Promise<void>((resolve) => item.child!.once('exit', () => resolve()));
    }
    await item.app?.close();
    const target = resolve(item.directory);
    const within = relative(resolve(tmpdir()), target);
    if (isAbsolute(within) || within.startsWith('..') || !basename(target).startsWith('서사 M0 '))
      throw new Error('Refusing cleanup outside owned test directory');
    await rm(target, { recursive: true, force: true });
  }
  owned.length = 0;
});
async function api<T = any>(
  url: string,
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
  expected = 200
): Promise<T> {
  if (
    path === '/api/chats' &&
    method === 'POST' &&
    expected === 200 &&
    body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    !Object.hasOwn(body, 'botId')
  ) {
    const owner = await api<{ id: string }>(url, '/api/content', fixtureBotInput());
    body = { ...body, botId: owner.id };
  }
  const response = await fetch(`${url}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  expect(response.status, JSON.stringify(value)).toBe(expected);
  return value as T;
}
async function until<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeout = 5000
): Promise<T> {
  const deadline = Date.now() + timeout;
  let value: T;
  do {
    value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new Error(`Condition timed out: ${JSON.stringify(value)}`);
}
async function setup(testMode = true) {
  const directory = await mkdtemp(join(tmpdir(), '서사 M0 server '));
  const app = await createApp({
    dbPath: join(directory, 'story.sqlite'),
    instanceId: randomUUID(),
    buildId: 'unit-integration',
    testMode,
  });
  owned.push({ app, directory });
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  const bot = fixtureBotInput('Synthetic M0 owner');
  bot.package.lore = [
    {
      id: 'harbor',
      title: 'Synthetic harbor',
      description: 'Local scoped lore fixture',
      text: 'A blue bell hangs beside the synthetic harbor.',
      loading: 'discoverable',
    },
  ];
  bot.package.instructions = [
    { id: 'scene-craft', target: 'main', text: 'Leave the reader choice open.' },
  ];
  const owner = await api<{ id: string }>(url, '/api/content', bot);
  const chat = await api<Chat>(url, '/api/chats', { title: '합성 항구', botId: owner.id });
  return { app, url, chat, directory };
}
const command = (chat: Chat, key = randomUUID()) => ({
  request: '작은 항구에서 장면을 이어줘.',
  expectedRevision: chat.headRevision,
  expectedSettingsRevision: chat.settingsRevision,
  idempotencyKey: key,
});
const detail = (url: string, chat: Chat) => api<ChatDetail>(url, `/api/chats/${chat.id}`);
const control = (url: string, body: unknown) => api(url, '/api/test/control', body);
const completed = (url: string, id: string) =>
  until(
    () => api<Run>(url, `/api/runs/${id}`),
    (run) => run.status === 'completed'
  );

describe('file SQLite HTTP runtime', () => {
  it('allows 32 task calls through settings and archive while rejecting 33 without changing saved work', async () => {
    const { app, url, chat } = await setup();
    expect(chat.settings.maxCalls).toBe(8);
    const configured = await api<Chat>(
      url,
      `/api/chats/${chat.id}/settings`,
      { ...chat.settings, maxCalls: 32, expectedSettingsRevision: chat.settingsRevision },
      'PATCH'
    );
    expect(configured.settings.maxCalls).toBe(32);
    await api(
      url,
      `/api/chats/${chat.id}/settings`,
      {
        ...configured.settings,
        maxCalls: 33,
        expectedSettingsRevision: configured.settingsRevision,
      },
      'PATCH',
      400
    );
    expect(app.store.chat(chat.id)).toEqual(configured);
    const run = await api<Run>(url, `/api/chats/${chat.id}/runs`, command(configured));
    expect((await completed(url, run.id)).snapshot.settings.maxCalls).toBe(32);

    const opened = await api<HelperConversation>(url, '/api/helper/conversations', {
      scope: { kind: 'chat', chatId: chat.id },
    });
    const helper = await api<HelperConversation>(
      url,
      `/api/helper/conversations/${opened.id}`,
      {
        expectedRevision: opened.revision,
        persona: opened.persona,
        limits: { totalCalls: 32, helperCalls: 32, artifacts: 1 },
      },
      'PATCH'
    );
    expect(helper.limits).toEqual({ totalCalls: 32, helperCalls: 32, artifacts: 1 });
    await api(
      url,
      `/api/helper/conversations/${opened.id}`,
      {
        expectedRevision: helper.revision,
        persona: helper.persona,
        limits: { totalCalls: 32, helperCalls: 33, artifacts: 1 },
      },
      'PATCH',
      400
    );
    expect(await api(url, `/api/helper/conversations/${opened.id}`)).toEqual(helper);

    const archive = app.store.product.export();
    const invalid = structuredClone(archive);
    const archivedChat = invalid.tables.chats.find((row) => row.id === chat.id)!;
    archivedChat.settings = JSON.stringify({ ...JSON.parse(archivedChat.settings), maxCalls: 33 });
    const directory = await mkdtemp(join(tmpdir(), '서사 M0 call-limit restore '));
    const restored = await createApp({
      dbPath: join(directory, 'story.sqlite'),
      buildId: 'call-limit-archive-boundary',
      testMode: true,
    });
    owned.push({ app: restored, directory });
    const rejected = await restored.inject({
      method: 'POST',
      url: '/api/import',
      payload: { archive: invalid },
    });
    expect(rejected.statusCode).toBe(400);
    expect(restored.store.chats()).toEqual([]);
    const imported = await restored.inject({
      method: 'POST',
      url: '/api/import',
      payload: { archive },
    });
    expect(imported.statusCode, imported.body).toBe(200);
    expect(restored.store.chat(chat.id).settings.maxCalls).toBe(32);
    expect(restored.store.run(run.id).snapshot.settings.maxCalls).toBe(32);
    expect(
      (
        await restored.inject({ method: 'GET', url: `/api/helper/conversations/${opened.id}` })
      ).json<HelperConversation>().limits
    ).toEqual(helper.limits);
  });

  it('F02 fixes snapshots, rejects stale revisions, and deduplicates a logical command', async () => {
    const { app, url, chat } = await setup();
    const other = await api<Chat>(url, '/api/chats', { title: '별도의 도시', preset: 'vivid' });
    await control(url, { action: 'hold', barrier: 'run' });
    const cmd = command(chat);
    const run = await api<Run>(url, `/api/chats/${chat.id}/runs`, cmd);
    const duplicate = await api<Run>(url, `/api/chats/${chat.id}/runs`, cmd);
    expect(duplicate.id).toBe(run.id);
    await api(url, `/api/chats/${chat.id}/runs`, { ...cmd, request: '달라진 요청' }, 'POST', 409);
    await api(url, `/api/chats/${chat.id}/runs`, command(chat), 'POST', 409);
    const changed = await api<Chat>(
      url,
      `/api/chats/${chat.id}/settings`,
      { expectedSettingsRevision: 1, ...chat.settings, preset: 'vivid' },
      'PATCH'
    );
    await api(
      url,
      `/api/chats/${chat.id}/settings`,
      { expectedSettingsRevision: 1, ...chat.settings },
      'PATCH',
      409
    );
    expect((await api<Run>(url, `/api/runs/${run.id}`)).snapshot.settings.preset).toBe('calm');
    const independent = await api<Run>(url, `/api/chats/${other.id}/runs`, command(other));
    await control(url, { action: 'release', barrier: 'run' });
    const finished = await completed(url, run.id);
    await completed(url, independent.id);
    expect(finished.inputs[0].preset).toBe('calm');
    expect(finished.snapshot.resources.every((resource) => resource.chatId === chat.id)).toBe(true);
    expect((await detail(url, other)).runs[0].inputs[0].preset).toBe('vivid');
    await api(url, `/api/chats/${chat.id}/runs`, command(changed), 'POST', 409);
    expect(app.store.db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 2 });
    expect(app.store.db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
  });

  it('F03 replays durable event IDs and keeps errors out of source; F04 enforces call budget and cancellation', async () => {
    const { app, url, chat } = await setup();
    const configured = await api<Chat>(
      url,
      `/api/chats/${chat.id}/settings`,
      { expectedSettingsRevision: 1, ...chat.settings, mode: 'research', maxCalls: 2 },
      'PATCH'
    );
    const run = await api<Run>(url, `/api/chats/${chat.id}/runs`, command(configured));
    const failed = await until(
      () => api<Run>(url, `/api/runs/${run.id}`),
      (value) => value.status === 'failed'
    );
    expect(failed.error).toBe('Model call budget exhausted');
    expect(failed.usage.modelCalls).toBe(2);
    expect(failed.inputs).toHaveLength(2);
    expect((await detail(url, chat)).sources).toHaveLength(0);
    const events = app.store.events(chat.id, 0) as { seq: number; kind: string }[];
    const cursor = events.find((event) => event.kind === 'run.queued')!.seq;
    const stream = await fetch(`${url}/api/chats/${chat.id}/events`, {
      headers: { 'Last-Event-ID': String(cursor) },
    });
    const reader = stream.body!.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    expect(chunk).toContain('run.failed');
    expect(chunk).not.toContain('run.queued');
    expect(chunk).toContain(`id: ${events.at(-1)!.seq}`);
    await control(url, { action: 'hold', barrier: 'run' });
    const cancelled = await api<Run>(url, `/api/chats/${chat.id}/runs`, command(configured));
    await until(
      () => control(url, { action: 'hold', barrier: 'run' }),
      (value) => value.waiting.run === 1
    );
    expect((await api<Run>(url, `/api/runs/${cancelled.id}/cancel`, {})).status).toBe('cancelled');
    await control(url, { action: 'release', barrier: 'run' });
    expect((await api<Run>(url, `/api/runs/${cancelled.id}`)).inputs).toHaveLength(0);
    expect((await detail(url, chat)).sources).toHaveLength(0);
  });

  it('F05 rolls back source/run/job reservations together and honors snapshotted disabled jobs', async () => {
    const { app, url, chat } = await setup();
    await control(url, { action: 'fail-next', point: 'source-transaction' });
    const run = await api<Run>(url, `/api/chats/${chat.id}/runs`, command(chat));
    const failed = await until(
      () => api<Run>(url, `/api/runs/${run.id}`),
      (value) => value.status === 'failed'
    );
    expect(failed.error).toContain('source-transaction');
    expect(failed.sourceRevision).toBeNull();
    const empty = await detail(url, chat);
    expect(empty.sources).toEqual([]);
    expect(empty.jobs).toEqual([]);
    expect(empty.chat.headRevision).toBeNull();
    const configured = await api<Chat>(
      url,
      `/api/chats/${chat.id}/settings`,
      { expectedSettingsRevision: 1, ...chat.settings, translation: false, status: false },
      'PATCH'
    );
    const next = await api<Run>(url, `/api/chats/${chat.id}/runs`, command(configured));
    await completed(url, next.id);
    expect((await detail(url, chat)).sources).toHaveLength(1);
    expect((await detail(url, chat)).jobs).toEqual([]);
    expect(app.store.db.prepare('SELECT count(*) AS n FROM sources').get()).toEqual({ n: 1 });
  });

  it('F05 keeps delayed jobs on original revisions and retries result transactions without duplicate effects', async () => {
    const { app, url, chat: initial } = await setup();
    const chat = await api<Chat>(
      url,
      `/api/chats/${initial.id}/settings`,
      { expectedSettingsRevision: initial.settingsRevision, ...initial.settings, status: true },
      'PATCH'
    );
    await control(url, { action: 'hold', barrier: 'translation' });
    await control(url, { action: 'hold', barrier: 'status' });
    const first = await api<Run>(url, `/api/chats/${chat.id}/runs`, command(chat));
    await completed(url, first.id);
    const original = await detail(url, chat);
    const source = original.sources[0];
    expect(original.jobs.some((job) => job.kind === 'translation')).toBe(false);
    await api(url, `/api/sources/${source.id}/translation`, {});
    await until(
      () => api(url, '/api/test/control'),
      (value) => value.waiting.translation === 1 && value.waiting.status === 1
    );
    const second = await api<Run>(url, `/api/chats/${chat.id}/runs`, command(original.chat));
    await completed(url, second.id);
    const secondSource = (await detail(url, chat)).sources.find(
      (value) => value.runId === second.id
    )!;
    await api(url, `/api/sources/${secondSource.id}/translation`, {});
    await until(
      () => api(url, '/api/test/control'),
      (value) => value.waiting.translation === 2 && value.waiting.status === 2
    );
    await control(url, { action: 'fail-next', point: 'job-transaction' });
    await control(url, { action: 'release', barrier: 'status' });
    const failedDetail = await until(
      () => detail(url, chat),
      (value) =>
        value.jobs
          .filter((job) => job.kind === 'status')
          .every((job) => ['failed', 'completed'].includes(job.status))
    );
    const failed = failedDetail.jobs.find((job) => job.status === 'failed')!;
    expect(failed.error).toBe('AUXILIARY_EXECUTION_FAILED');
    expect(failedDetail.jobs.filter((job) => job.status === 'failed')).toHaveLength(1);
    expect((await api(url, '/api/test/control')).failures).not.toContain('job-transaction');
    expect(failed.result).toBeNull();
    expect(
      failedDetail.jobs
        .filter((job) => job.kind === 'translation')
        .every((job) => job.status === 'running')
    ).toBe(true);
    await api(url, `/api/jobs/${failed.id}/retry`, {});
    await control(url, { action: 'release', barrier: 'translation' });
    const all = await until(
      () => detail(url, chat),
      (value) => value.jobs.every((job) => job.status === 'completed')
    );
    const currentSource = all.sources.find((value) => value.id === source.id)!;
    const { translationRevision: beforeTranslationRevision, ...beforeSource } = source;
    const { translationRevision, ...afterSource } = currentSource;
    expect(afterSource).toEqual(beforeSource);
    expect(beforeTranslationRevision).toBe(0);
    expect(translationRevision).toBe(
      all.jobs.find((job) => job.kind === 'translation' && job.sourceRevision === source.id)!
        .revision
    );
    expect(all.sources[1].parentRevision).toBe(source.id);
    for (const job of all.jobs) {
      expect(job.result!.sourceRevision).toBe(job.sourceRevision);
      expect(job.result!.sourceHash).toBe(job.sourceHash);
    }
    const retried = all.jobs.find((job) => job.id === failed.id)!;
    expect(retried.attempt).toBe(2);
    const retryAgain = await api(url, `/api/jobs/${failed.id}/retry`, {});
    expect(retryAgain.attempt).toBe(2);
    expect(app.store.completeJob(failed.id, 1, 'wrong-owner', { mock: true })).toBe(false);
    expect(app.store.completeJob(failed.id, 2, 'wrong-owner', { mock: true })).toBe(false);
    const ownership = app.store.db.prepare('SELECT owner FROM jobs WHERE id=?').get(failed.id) as {
      owner: string;
    };
    expect(app.store.completeJob(failed.id, 2, ownership.owner, retried.result)).toBe(false);
    expect(app.store.db.prepare('SELECT count(*) AS n FROM job_results').get()).toEqual({ n: 4 });
    expect(all.runs.map((value) => value.inputs.length)).toEqual([1, 1]);
  });

  it('F01 refuses another owner before recovery; F06 disables controls and prevents cross-origin writes', async () => {
    const { app, url, chat, directory } = await setup(false);
    // Seed an in-flight record directly: this case tests owner recovery, not model execution.
    // Keep the public runtime in normal mode without invoking a provider or a scripted model.
    const { run: active } = app.store.createRun(chat.id, command(chat), (current) => ({
      chatId: current.id,
      parentRevision: current.headRevision,
      settingsRevision: current.settingsRevision,
      settings: current.settings,
      request: command(chat).request,
      history: [],
      resources: [],
      profile: app.store.product.snapshot(current.id),
    }));
    expect(app.store.startRun(active.id)).toBe(true);
    await expect(
      createApp({ dbPath: join(directory, 'story.sqlite'), buildId: 'other' })
    ).rejects.toThrow('running server owner');
    expect((await api<Run>(url, `/api/runs/${active.id}`)).status).toBe('running');
    expect(app.store.chat(chat.id).headRevision).toBeNull();
    await api(url, '/api/test/control', undefined, 'GET', 404);
    const canary = process.env.NR_SECRET_CANARY ?? 'synthetic-canary-not-secret';
    const denied = await fetch(`${url}/api/chats`, {
      method: 'POST',
      headers: {
        Origin: 'https://untrusted.invalid',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${canary}`,
      },
      body: JSON.stringify({ title: 'must not write' }),
    });
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain(canary);
    expect(app.store.chats()).toHaveLength(1);
    const unknownBody = await fetch(`${url}/api/chats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'must not write', credential: canary }),
    });
    expect(unknownBody.status).toBe(400);
    expect(await unknownBody.text()).not.toContain(canary);
    const rebound = await injectWithFixtureBot(app, {
      method: 'GET',
      url: '/api/chats',
      headers: { Host: 'evil.test', Origin: 'http://evil.test' },
    });
    expect(rebound.statusCode).toBe(403);
  });

  it('F04 reads scoped SQLite references through research calls and applies package main instructions', async () => {
    const { app, url, chat } = await setup();
    const other = await api<Chat>(url, '/api/chats', { title: '다른 자료 범위' });
    const configured = await api<Chat>(
      url,
      `/api/chats/${chat.id}/settings`,
      { expectedSettingsRevision: 1, ...chat.settings, mode: 'research' },
      'PATCH'
    );
    const resourceRows = app.store.product.resources(chat.id, app.store.product.snapshot(chat.id));
    expect(resourceRows).toHaveLength(2);
    const run = await api<Run>(url, `/api/chats/${chat.id}/runs`, command(configured));
    const result = await completed(url, run.id);
    expect(result.inputs).toHaveLength(3);
    expect(result.usage.modelCalls).toBe(3);
    expect(result.inputs[0].prefetch).toEqual([]);
    expect(result.inputs[0].results).toEqual([]);
    expect(result.inputs[0].catalog.every((resource) => !('text' in resource))).toBe(true);
    expect(result.inputs[0].facts).toContain('Leave the reader choice open.');
    expect(result.toolEvents.map((event) => event.name)).toEqual([
      'knowledge.search',
      'knowledge.read',
    ]);
    expect(result.inputs[2].results).toEqual(result.toolEvents);
    expect(JSON.stringify(result.inputs)).not.toContain(other.id);
    expect(JSON.stringify(result.inputs)).not.toContain('previousState');
    expect(JSON.stringify(result.inputs)).not.toContain('schema');
    const detailResult = await detail(url, chat);
    expect(detailResult.sources[0].text).not.toContain('<');
    expect(detailResult.sources[0].text).not.toContain('모의 표시 상태');
  });
});

async function startChild(directory: string) {
  const child = spawn(process.execPath, [resolve('dist/server/index.js')], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NR_DB: join(directory, 'story.sqlite'),
      NR_PORT: '0',
      NR_INSTANCE: randomUUID(),
      NR_TEST_MODE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const entry = { child, directory };
  owned.push(entry);
  let stderr = '';
  child.stderr!.on('data', (data) => {
    stderr += String(data);
  });
  const ready = await new Promise<{ url: string }>((resolveReady, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Child ready timeout: ${stderr}`)), 10000);
    child.stdout!.on('data', (data) => {
      output += String(data);
      for (const line of output.split('\n')) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.event === 'ready') {
            clearTimeout(timer);
            resolveReady(parsed);
          }
        } catch {
          /* Incomplete stdout line. */
        }
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Child exited ${code}: ${stderr}`));
    });
  });
  return { child, url: ready.url, entry };
}

describe('built server process boundary', () => {
  it('F03 F05 restarts after source commit before worker wake, without regenerating source', async () => {
    const directory = await mkdtemp(join(tmpdir(), '서사 M0 crash '));
    const first = await startChild(directory);
    const initial = await api<Chat>(first.url, '/api/chats', { title: '합성 커밋 경계' });
    const chat = await api<Chat>(
      first.url,
      `/api/chats/${initial.id}/settings`,
      { expectedSettingsRevision: initial.settingsRevision, ...initial.settings, status: true },
      'PATCH'
    );
    await control(first.url, { action: 'hold', barrier: 'run' });
    const run = await api<Run>(first.url, `/api/chats/${chat.id}/runs`, command(chat));
    await control(first.url, { action: 'crash-after-source-commit' });
    const exited = new Promise<number | null>((resolveExit) =>
      first.child.once('exit', resolveExit)
    );
    await control(first.url, { action: 'release', barrier: 'run' }).catch(() => undefined);
    expect(await exited).toBe(86);
    const db = new DatabaseSync(join(directory, 'story.sqlite'), { readOnly: true });
    const { originalText, beforeRestart } = (() => {
      try {
        expect(db.prepare('SELECT status FROM runs').get()).toEqual({ status: 'completed' });
        expect(db.prepare('SELECT count(*) AS n FROM sources').get()).toEqual({ n: 1 });
        expect(db.prepare("SELECT count(*) AS n FROM jobs WHERE status='queued'").get()).toEqual({
          n: 1,
        });
        expect(db.prepare('SELECT count(*) AS n FROM job_results').get()).toEqual({ n: 0 });
        const originalText = db.prepare('SELECT text,hash FROM sources').get();
        const beforeRestart = {
          runs: db.prepare('SELECT id,status,source_revision FROM runs').all(),
          sources: db.prepare('SELECT id,hash FROM sources').all(),
          jobs: db.prepare('SELECT id,source_revision,status,generation FROM jobs').all(),
          resultCount: db.prepare('SELECT count(*) AS n FROM job_results').get(),
          inputCount: db.prepare('SELECT count(*) AS n FROM model_inputs').get(),
        };
        return { originalText, beforeRestart };
      } finally {
        db.close();
      }
    })();
    // Transfer directory cleanup to the newest process entry.
    owned.splice(owned.indexOf(first.entry), 1);
    const second = await startChild(directory);
    const recovered = await until(
      () => detail(second.url, chat),
      (value) => value.jobs.every((job) => job.status === 'completed')
    );
    expect(recovered.runs).toHaveLength(1);
    expect(recovered.runs[0].id).toBe(run.id);
    expect(recovered.runs[0].inputs).toHaveLength(1);
    expect(recovered.sources).toHaveLength(1);
    expect({ text: recovered.sources[0].text, hash: recovered.sources[0].hash }).toEqual(
      originalText
    );
    expect(recovered.jobs.map((job) => job.attempt)).toEqual([1]);
    expect(recovered.jobs.map((job) => job.kind)).toEqual(['status']);
    const held = await control(second.url, { action: 'hold', barrier: 'run' });
    expect(held.held).toContain('run');
    const interrupted = await api<Run>(
      second.url,
      `/api/chats/${chat.id}/runs`,
      command(recovered.chat)
    );
    const stop = new Promise<void>((resolveExit) => second.child.once('exit', () => resolveExit()));
    second.child.kill();
    await stop;
    owned.splice(owned.indexOf(second.entry), 1);
    const third = await startChild(directory);
    const result = await api<Run>(third.url, `/api/runs/${interrupted.id}`);
    expect(result.status).toBe('interrupted');
    expect(result.inputs).toHaveLength(0);
    expect(result.sourceRevision).toBeNull();
    expect((await detail(third.url, chat)).sources).toHaveLength(1);
    const stopped = new Promise<void>((resolveExit) =>
      third.child.once('exit', () => resolveExit())
    );
    third.child.kill();
    await stopped;
    if (process.env.NR_ARTIFACT_DIR) {
      const evidenceDirectory = resolve(process.env.NR_ARTIFACT_DIR, 'evidence');
      await mkdir(evidenceDirectory, { recursive: true });
      const persisted = new DatabaseSync(join(directory, 'story.sqlite'), { readOnly: true });
      try {
        const afterRestart = {
          runs: persisted.prepare('SELECT id,status,source_revision FROM runs').all(),
          sources: persisted.prepare('SELECT id,hash FROM sources').all(),
          jobs: persisted.prepare('SELECT id,source_revision,status,generation FROM jobs').all(),
          results: persisted.prepare('SELECT job_id,generation,result FROM job_results').all(),
          inputCount: persisted.prepare('SELECT count(*) AS n FROM model_inputs').get(),
        };
        await backup(persisted, join(evidenceDirectory, 'commit-boundary.sqlite'));
        await writeFile(
          join(evidenceDirectory, 'commit-boundary-restart.json'),
          JSON.stringify(
            {
              exitAfterCommit: 86,
              beforeRestart,
              afterRestart,
              completedRunId: run.id,
              interruptedRunId: interrupted.id,
              limitations:
                'Scripted mock lifecycle; no paid provider or power-loss durability claim.',
            },
            null,
            2
          )
        );
      } finally {
        persisted.close();
      }
    }
  }, 20000);
});
