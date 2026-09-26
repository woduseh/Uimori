import packageJson from '../package.json' with { type: 'json' };
import { observeExecutions, observedExecution } from './fixtures/execution-observer.js';
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
import { loopbackProvider } from './fixtures/loopback-provider.js';

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
  observeExecutions(app.store);
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  const bot = fixtureBotInput('Synthetic M0 owner');
  bot.package.nativeRisu.card.character_book = {
    entries: [
      {
        keys: ['harbor'],
        comment: 'Synthetic harbor',
        content: 'A blue bell hangs beside the synthetic harbor.',
        enabled: true,
      },
    ],
  };
  bot.package.loreActivation = { mode: 'discoverable' };
  bot.package.nativeRisu.card.post_history_instructions = 'Leave the reader choice open.';
  bot.package.nativeRisu.card.system_prompt = 'RETIRED_CARD_SYSTEM_MUST_NOT_EXECUTE';
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
  it('keeps server shutdown distinct from user cancellation in the durable response stream', async () => {
    const { app, url, chat, directory } = await setup();
    await control(url, { action: 'hold', barrier: 'run' });
    const run = await api<Run>(url, `/api/chats/${chat.id}/runs`, command(chat));
    expect(await api(url, `/api/response-streams/main/${run.id}`)).toMatchObject({
      status: 'running',
    });
    await app.close();
    const db = new DatabaseSync(join(directory, 'story.sqlite'), { readOnly: true });
    try {
      expect(
        db.prepare('SELECT status FROM response_stream_tasks WHERE task_id=?').get(run.id)
      ).toEqual({ status: 'interrupted' });
      expect(db.prepare('SELECT count(*) AS n FROM sources').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it('reports the package version independently of the build fingerprint', async () => {
    const { url } = await setup();
    expect(await api(url, '/api/health')).toMatchObject({
      ready: true,
      version: packageJson.version,
      buildId: 'unit-integration',
    });
  });
  it('F02 fixes snapshots, rejects stale revisions, and deduplicates a logical command', async () => {
    const { app, url, chat } = await setup();
    const other = await api<Chat>(url, '/api/chats', { title: '별도의 도시' });
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
      { expectedSettingsRevision: 1, ...chat.settings, maxCalls: 6 },
      'PATCH'
    );
    await api(
      url,
      `/api/chats/${chat.id}/settings`,
      { expectedSettingsRevision: 1, ...chat.settings },
      'PATCH',
      409
    );
    expect((await api<Run>(url, `/api/runs/${run.id}`)).snapshot.settings.maxCalls).toBe(8);
    const independent = await api<Run>(url, `/api/chats/${other.id}/runs`, command(other));
    await control(url, { action: 'release', barrier: 'run' });
    await completed(url, run.id);
    const finished = observedExecution(app.store, run.id);
    await completed(url, independent.id);
    expect(finished.snapshot.settings.maxCalls).toBe(8);
    expect(finished.snapshot.resources.every((resource) => resource.chatId === chat.id)).toBe(true);
    expect(observedExecution(app.store, independent.id).snapshot.settings.maxCalls).toBe(8);
    expect((await detail(url, other)).runs[0].inputs).toEqual([]);
    await api(url, `/api/chats/${chat.id}/runs`, command(changed), 'POST', 409);
    expect(app.store.db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 2 });
    expect(app.store.db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
  });

  it('F03 replays durable event IDs and keeps errors out of source; F04 enforces call budget and cancellation', async () => {
    const { app, url, chat } = await setup();
    app.controls.fixture = { mode: 'research' };
    const configured = await api<Chat>(
      url,
      `/api/chats/${chat.id}/settings`,
      { expectedSettingsRevision: 1, ...chat.settings, maxCalls: 2 },
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
      { expectedSettingsRevision: 1, ...chat.settings, status: false },
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
    expect(
      app.store.finishAuxiliary(failed.id, 1, 'wrong-owner', {
        status: 'completed',
        result: { mock: true },
        error: null,
      })
    ).toBe(false);
    expect(
      app.store.finishAuxiliary(failed.id, 2, 'wrong-owner', {
        status: 'completed',
        result: { mock: true },
        error: null,
      })
    ).toBe(false);
    const ownership = app.store.db.prepare('SELECT owner FROM jobs WHERE id=?').get(failed.id) as {
      owner: string;
    };
    expect(
      app.store.finishAuxiliary(failed.id, 2, ownership.owner, {
        status: 'completed',
        result: retried.result,
        error: null,
      })
    ).toBe(false);
    expect(app.store.db.prepare('SELECT count(*) AS n FROM job_results').get()).toEqual({ n: 4 });
    expect(all.runs.map((value) => value.inputs.length)).toEqual([0, 0]);
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
    const canary = process.env.UIMORI_SECRET_CANARY ?? 'synthetic-canary-not-secret';
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

  it('F04 reads scoped SQLite references through research calls and applies the native global note', async () => {
    const { app, url, chat } = await setup();
    app.controls.fixture = { mode: 'research' };
    const other = await api<Chat>(url, '/api/chats', { title: '다른 자료 범위' });
    const configured = await api<Chat>(
      url,
      `/api/chats/${chat.id}/settings`,
      { expectedSettingsRevision: 1, ...chat.settings },
      'PATCH'
    );
    const resourceRows = app.store.product.resources(chat.id, app.store.product.snapshot(chat.id));
    expect(resourceRows).toHaveLength(3);
    const run = await api<Run>(url, `/api/chats/${chat.id}/runs`, command(configured));
    await completed(url, run.id);
    const result = observedExecution(app.store, run.id);
    expect(result.inputs).toHaveLength(3);
    expect(result.usage.modelCalls).toBe(3);
    expect(result.inputs[0].prefetch).toEqual([]);
    expect(result.inputs[0].results).toEqual([]);
    expect(result.inputs[0].catalog.every((resource) => !('text' in resource))).toBe(true);
    expect(JSON.stringify(result.snapshot.promptCompilation?.messages)).toContain(
      'Leave the reader choice open.'
    );
    expect(
      JSON.stringify({ inputs: result.inputs, prompt: result.snapshot.promptCompilation })
    ).not.toContain('RETIRED_CARD_SYSTEM_MUST_NOT_EXECUTE');
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
      UIMORI_DB: join(directory, 'story.sqlite'),
      UIMORI_PORT: '0',
      UIMORI_INSTANCE: randomUUID(),
      UIMORI_TEST_MODE: '1',
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
  expect(await api(ready.url, '/api/health')).toMatchObject({
    ready: true,
    version: packageJson.version,
  });
  return { child, url: ready.url, entry };
}

describe('built server process boundary', () => {
  it('resumes Batch HTTP runs across process stops without recreating batches or replaying saved tools', async () => {
    let phase = 0;
    const batches: { customId: string; tool: string }[] = [];
    const provider = await loopbackProvider((request, response) => {
      const json = (value: unknown) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (request.url === '/v1/messages/batches') {
        const body = JSON.parse(request.body).requests[0];
        batches.push({
          customId: body.custom_id,
          tool: body.params.tools.find((tool: { name: string }) =>
            tool.name.endsWith('_knowledge_search')
          ).name,
        });
        json({ id: `batch-${batches.length}`, processing_status: 'in_progress' });
        return;
      }
      const match = /^\/v1\/messages\/batches\/batch-(\d+)(\/results)?$/u.exec(request.url);
      if (!match) throw new Error(`Unexpected Batch request: ${request.url}`);
      const ordinal = Number(match[1]);
      if (!match[2]) {
        json({
          id: `batch-${ordinal}`,
          processing_status: phase >= ordinal ? 'ended' : 'in_progress',
        });
        return;
      }
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.end(
        JSON.stringify({
          custom_id: batches[ordinal - 1].customId,
          result: {
            type: 'succeeded',
            message: {
              id: `message-${ordinal}`,
              type: 'message',
              role: 'assistant',
              model: 'claude-opus-5',
              content:
                ordinal === 1
                  ? [
                      {
                        type: 'tool_use',
                        id: 'batch-search',
                        name: batches[0].tool,
                        input: { query: 'harbor' },
                      },
                    ]
                  : [{ type: 'text', text: 'Recovered Batch manuscript.' }],
              stop_reason: ordinal === 1 ? 'tool_use' : 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 11, output_tokens: 6 },
            },
          },
        }) + '\n'
      );
    });
    try {
      const directory = await mkdtemp(join(tmpdir(), '서사 M0 batch-restart '));
      let instance = await startChild(directory);
      const bot = fixtureBotInput('Batch callback fixture');
      bot.package.nativeRisu.card.extensions = {
        risuai: {
          triggerscript: [
            {
              type: 'start',
              effect: [
                {
                  type: 'triggerlua',
                  code: `listenEdit('editRequest', function(id, messages)
          local count = (tonumber(getChatVar(id, 'requestCount')) or 0) + 1
          setChatVar(id, 'requestCount', tostring(count))
          messages[#messages].content = messages[#messages].content .. ' Stable request callback'
          return messages
        end)`,
                },
              ],
            },
          ],
        },
      };
      const owner = await api(instance.url, '/api/content', bot);
      const initial = await api<Chat>(instance.url, '/api/chats', {
        title: 'Batch restart',
        botId: owner.id,
      });
      const chat = await api<Chat>(
        instance.url,
        `/api/chats/${initial.id}/settings`,
        {
          expectedSettingsRevision: initial.settingsRevision,
          ...initial.settings,
          status: false,
        },
        'PATCH'
      );
      const connection = await api(instance.url, '/api/connections', {
        title: 'Local Batch fixture',
        protocol: 'anthropic-messages-v1',
        endpoint: `${provider.origin}/v1`,
        apiKey: 'synthetic-batch-key',
        enabled: true,
      });
      const model = await api(instance.url, '/api/model-presets', {
        title: 'Batch writer',
        connectionId: connection.id,
        modelId: 'claude-opus-5',
        maxOutputTokens: 2048,
        temperature: null,
        executionMode: 'batch',
      });
      const workspace = await api(instance.url, '/api/model-workspace');
      await api(
        instance.url,
        '/api/model-workspace',
        {
          expectedRevision: workspace.revision,
          routes: { main: { id: model.id }, translation: null, status: null },
          translationPolicy: workspace.translationPolicy,
          mainJudgmentEnabled: false,
        },
        'PUT'
      );
      const run = await api<Run>(instance.url, `/api/chats/${chat.id}/runs`, command(chat));
      for (const checkpoint of [1, 2]) {
        // A poll proves the create acknowledgement and batch id were durably accepted.
        await until(
          async () =>
            provider.requests.some(
              (request) => request.url === `/v1/messages/batches/batch-${checkpoint}`
            ),
          Boolean
        );
        const before = await api<Run>(instance.url, `/api/runs/${run.id}`);
        expect(before.status).toBe('running');
        expect(before.toolEvents).toHaveLength(checkpoint - 1);
        expect(before.snapshot.nativeRisuExecution?.variables.requestCount).toBe(
          String(checkpoint)
        );
        expect(before.snapshot.nativeRisuExecution?.requestEdits).toHaveLength(checkpoint);
        if (checkpoint === 2)
          expect(before.toolEvents[0]).toMatchObject({ name: 'knowledge.search', denied: false });
        const stopped = new Promise<void>((done) => instance.child.once('exit', () => done()));
        instance.child.kill('SIGKILL');
        await stopped;
        owned.splice(owned.indexOf(instance.entry), 1);
        phase = checkpoint;
        instance = await startChild(directory);
        if (checkpoint === 1) {
          // Stop promptly on a product failure instead of hiding it behind a poll timeout.
          await until(
            async () => ({
              run: await api<Run>(instance.url, `/api/runs/${run.id}`),
              batches: batches.length,
            }),
            (value) => value.batches === 2 || !['queued', 'running'].includes(value.run.status)
          );
          const restarted = await api<Run>(instance.url, `/api/runs/${run.id}`);
          expect(restarted.status, restarted.error ?? undefined).toBe('running');
        }
      }
      const done = await until(
        () => api<Run>(instance.url, `/api/runs/${run.id}`),
        (value) => !['queued', 'running'].includes(value.status)
      );
      expect(done).toMatchObject({ status: 'completed', usage: { modelCalls: 2 } });
      const final = await detail(instance.url, chat);
      expect(final.sources).toHaveLength(1);
      expect(final.sources[0].text).toBe('Recovered Batch manuscript.');
      expect(final.runs).toHaveLength(1);
      expect(batches).toHaveLength(2);
      expect(provider.requests.filter((request) => request.url.endsWith('/results'))).toHaveLength(
        2
      );
      expect(await api(instance.url, `/api/response-streams/main/${run.id}`)).toMatchObject({
        status: 'completed',
        chunks: [],
      });
      expect(
        await (await fetch(`${instance.url}/api/response-streams/main/${run.id}/events`)).text()
      ).toContain('"status":"completed"');
      const db = new DatabaseSync(join(directory, 'story.sqlite'), { readOnly: true });
      try {
        expect(db.prepare('SELECT count(*) AS n FROM attempts WHERE run_id=?').get(run.id)).toEqual(
          { n: 2 }
        );
        expect(
          db
            .prepare(
              'SELECT count(*) AS n FROM anthropic_batches WHERE run_id=? AND result IS NOT NULL'
            )
            .get(run.id)
        ).toEqual({ n: 0 });
        if (process.env.UIMORI_ARTIFACT_DIR) {
          const evidence = resolve(process.env.UIMORI_ARTIFACT_DIR, 'evidence');
          await mkdir(evidence, { recursive: true });
          await backup(db, join(evidence, 'batch-process-restart.sqlite'));
          await writeFile(
            join(evidence, 'batch-process-restart.json'),
            JSON.stringify(
              {
                runId: run.id,
                status: done.status,
                sources: final.sources.length,
                batches: batches.length,
                resultFetches: provider.requests.filter((request) =>
                  request.url.endsWith('/results')
                ).length,
                limitations:
                  'Real child processes, HTTP, SQLite and SSE; local Anthropic fixture, no browser or live provider.',
              },
              null,
              2
            )
          );
        }
      } finally {
        db.close();
      }
    } finally {
      await provider.close();
    }
  });

  it('isolates two processes and databases from one build and preserves each across restart', async () => {
    const directories = await Promise.all(
      ['a', 'b'].map((name) => mkdtemp(join(tmpdir(), `서사 M0 isolate-${name}-`)))
    );
    const instances = await Promise.all(directories.map(startChild));
    expect(instances[0].url).not.toBe(instances[1].url);
    expect(instances[0].child.pid).not.toBe(instances[1].child.pid);
    const records = await Promise.all(
      instances.map(async ({ url }, index) => {
        const chat = await api<Chat>(url, '/api/chats', { title: `Isolated ${index}` });
        const admitted = await api<Run>(
          url,
          `/api/chats/${chat.id}/runs`,
          command(chat, 'same-key-in-independent-databases')
        );
        const run = await completed(url, admitted.id);
        return { chat, run };
      })
    );
    for (const [index, instance] of instances.entries()) {
      await api(instance.url, `/api/chats/${records[1 - index].chat.id}`, undefined, 'GET', 404);
      const exit = new Promise<void>((done) => instance.child.once('exit', () => done()));
      instance.child.kill();
      await exit;
      const restarted = await startChild(directories[index]);
      const kept = await api<Run>(restarted.url, `/api/runs/${records[index].run.id}`);
      expect(kept.sourceRevision).toBe(records[index].run.sourceRevision);
      expect(kept.usage).toEqual(records[index].run.usage);
      const chat = await detail(restarted.url, records[index].chat);
      expect(chat.sources).toHaveLength(1);
      expect(chat.runs).toHaveLength(1);
      await api(restarted.url, `/api/chats/${records[1 - index].chat.id}`, undefined, 'GET', 404);
    }
  });

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
    expect(recovered.runs[0].inputs).toHaveLength(0);
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
    if (process.env.UIMORI_ARTIFACT_DIR) {
      const evidenceDirectory = resolve(process.env.UIMORI_ARTIFACT_DIR, 'evidence');
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
