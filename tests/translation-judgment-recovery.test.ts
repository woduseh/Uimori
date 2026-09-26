import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { backup } from 'node:sqlite';
import { afterEach, expect, test, vi } from 'vitest';
import type { Job } from '../core/types.js';
import { canRejudgeTranslation } from '../core/translation-recovery.js';
import { createApp, type App } from '../server/app.js';
import { JEV_ENDPOINT } from '../server/jev-judgment.js';
import { createFixtureChat } from './fixtures/chat.js';
import { loopbackProvider } from './fixtures/loopback-provider.js';
import { updateTestProfile } from './fixtures/model-workspace.js';

const owned: { directory: string; apps: App[]; close?: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const item of owned.splice(0)) {
    for (const app of item.apps) await app.close();
    await item.close?.();
    const path = resolve(item.directory),
      within = relative(resolve(tmpdir()), path);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(path).startsWith('uimori-translation-judgment-')
    )
      throw new Error('Unsafe fixture cleanup');
    await rm(path, { recursive: true, force: true });
  }
  vi.unstubAllGlobals();
});
async function api(app: App, url: string, payload?: unknown) {
  const response = await app.inject({
    method: payload === undefined ? 'GET' : 'POST',
    url,
    headers: { host: '127.0.0.1', 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

// Real HTTP admission/worker/SQLite; native translation uses loopback SSE and JEV is intercepted.
// A SQLite backup captures a hard-stop boundary before any graceful shutdown cleanup executes.
test.each(['SQLite crash snapshot', 'graceful server shutdown'])(
  'a completed translation survives %s during judgment and explicit recovery calls only JEV',
  async (stop) => {
    const item = {
      directory: await mkdtemp(join(tmpdir(), 'uimori-translation-judgment-')),
      apps: [],
    } as (typeof owned)[number];
    owned.push(item);
    const candidate = '보존할 완성 번역 😀\r\n마지막 문장.';
    const provider = await loopbackProvider((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: candidate }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
      );
    });
    item.close = provider.close;
    const originalFetch = globalThis.fetch;
    const judged: string[] = [];
    let holdJudgment = true;
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).startsWith(provider.origin)) return originalFetch(url, init);
      expect(url).toBe(JEV_ENDPOINT);
      judged.push(JSON.parse(String(init?.body)).state.response);
      if (holdJudgment)
        return new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new Error('Fixture aborted')), {
            once: true,
          });
        });
      return new Response(
        JSON.stringify({
          model: 'jev-latest',
          answers: { explicitRefusal: { type: 'noul', noul: 0.01 } },
        })
      );
    });
    const launch = async (file: string) => {
      const app = await createApp({
        dbPath: join(item.directory, file),
        buildId: 'translation-judgment-fixture',
        testMode: true,
      });
      item.apps.push(app);
      return app;
    };
    const app = await launch('original.sqlite');
    app.store.credentials.set('jev', 'synthetic-jev-key');
    const chat = createFixtureChat(app.store, 'Interrupted translation');
    const connection = app.store.product.connection({
      title: 'Local translator',
      protocol: 'openai-chat-v1',
      endpoint: provider.endpoint,
      enabled: true,
    });
    const model = app.store.product.model({
      title: 'Local translator',
      connectionId: connection.id,
      modelId: 'synthetic-translator',
      maxOutputTokens: 1024,
      temperature: null,
    });
    const profile = app.store.product.profile(chat.id);
    updateTestProfile(app.store.product, chat.id, {
      expectedRevision: profile.revision,
      routes: { ...profile.routes, translation: { id: model.id } },
      image: false,
      imageTranslation: false,
    });
    const run = app.store.createRun(
      chat.id,
      {
        request: 'Synthetic source',
        expectedRevision: null,
        expectedSettingsRevision: chat.settingsRevision,
        idempotencyKey: randomUUID(),
      },
      (current) => ({
        chatId: chat.id,
        request: 'Synthetic source',
        parentRevision: null,
        settingsRevision: current.settingsRevision,
        settings: current.settings,
        history: [],
        resources: [],
        profile: app.store.product.snapshot(chat.id),
      })
    ).run;
    app.store.startRun(run.id);
    const source = app.store.completeRun(
      run.id,
      'The original manuscript.',
      { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
      run.snapshot.settings
    );
    const job = await api(app, `/api/sources/${source.id}/translation`, {});
    await expect.poll(() => judged.length, { timeout: 6000 }).toBe(1);
    if (stop === 'SQLite crash snapshot')
      await backup(app.store.db, join(item.directory, 'interrupted.sqlite'));
    await app.close();
    item.apps.splice(item.apps.indexOf(app), 1);
    holdJudgment = false;
    const reopened = await launch(
      stop === 'SQLite crash snapshot' ? 'interrupted.sqlite' : 'original.sqlite'
    );
    const interrupted = (await api(reopened, `/api/jobs/${job.id}`)) as Job;
    expect(interrupted).toMatchObject({
      status: 'interrupted',
      result: { text: candidate, sourceRevision: source.id, sourceHash: source.hash },
    });
    expect(canRejudgeTranslation(interrupted)).toBe(true);
    const reader = await api(reopened, `/api/chats/${chat.id}/reader`);
    expect(canRejudgeTranslation(reader.jobs.find((entry: Job) => entry.id === job.id))).toBe(true);
    expect(reopened.store.queuedJobs()).toEqual([]);
    expect(provider.requests).toHaveLength(1);
    expect(judged).toEqual([candidate]);
    const recovered = await api(reopened, `/api/jobs/${job.id}/rejudge`, {});
    await expect
      .poll(() => reopened.store.job(recovered.id).status, { timeout: 6000 })
      .toBe('completed');
    expect(reopened.store.job(recovered.id).result).toEqual({
      mock: false,
      sourceRevision: source.id,
      sourceHash: source.hash,
      text: candidate,
    });
    expect((await api(reopened, `/api/jobs/${job.id}/rejudge`, {})).id).toBe(recovered.id);
    expect(provider.requests).toHaveLength(1);
    expect(judged).toEqual([candidate, candidate]);
    expect(reopened.store.source(source.id).text).toBe('The original manuscript.');
  }
);
