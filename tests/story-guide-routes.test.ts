import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as transport from '../core/transport.js';
import { defaultStoryGuideConfig, type StoryGuideBrief } from '../core/story-guide.js';
import { createApp, type App } from '../server/app.js';
import { importChatTranscript } from '../server/chat-transcript.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { readHelperChatContext } from '../server/helper-context.js';
import { fixtureBotInput } from './fixtures/chat.js';

const owned: { app: App; path: string }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { app, path } of owned.splice(0)) {
    await app.close();
    rmSync(path, { recursive: true, force: true });
  }
});
async function setup() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-story-guide-routes-'));
  const app = await createApp({
    dbPath: join(path, 'app.sqlite'),
    buildId: 'guide-test',
    testMode: true,
  });
  owned.push({ app, path });
  const { store } = app;
  const bot = store.product.content(fixtureBotInput('Mira', 'CANON_REFERENCE_MIRA'));
  const chat = importChatTranscript(store, {
    idempotencyKey: randomUUID(),
    transcript: {
      format: 'uimori-chat-transcript',
      version: 2,
      exportedAt: new Date().toISOString(),
      title: 'Guide',
      packageAttachments: [{ id: bot.id, revision: bot.revision, role: 'bot' }],
      notes: [],
      entries: [
        { request: 'USER_REVEALS_SECRET', text: 'MIRA_NOW_KNOWS_SECRET', translation: null },
      ],
    },
  }).chat;
  const connection = store.product.connection({
    title: 'Fixture',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = store.product.model({
    title: 'Guide inherits writer',
    connectionId: connection.id,
    modelId: 'fixture',
    maxOutputTokens: 4096,
    temperature: null,
  });
  const workspace = modelWorkspace(store);
  updateModelWorkspace(store, {
    expectedRevision: workspace.revision,
    routes: { ...workspace.routes, main: { id: model.id } },
    translationPolicy: workspace.translationPolicy,
  });
  const config = {
    ...defaultStoryGuideConfig(),
    work: 'Silver Isles',
    reference: 'AUTHOR_REFERENCE',
  };
  const put = (expectedRevision: number, next = config) =>
    app.inject({
      method: 'PUT',
      url: `/api/chats/${chat.id}/story-guide`,
      payload: { expectedRevision, config: next },
    });
  expect((await put(0)).statusCode).toBe(200);
  const post = (action: 'ask' | 'refresh', body: object) =>
    app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/story-guide/${action}`,
      payload: body,
    });
  return { app, store, chat, config, post, put };
}
test.each(['off', 'failed'] as const)(
  'the last writing brief survives a newer %s guide run when only its receipt was published',
  async (nextGuide) => {
    const f = await setup();
    const enabled = { ...f.config, enabled: true };
    expect((await f.put(1, enabled)).statusCode).toBe(200);
    const reserve = () => {
      const chat = f.store.chat(f.chat.id);
      const run = f.store.createRun(
        chat.id,
        {
          request: 'Continue the story',
          expectedRevision: chat.headRevision,
          expectedSettingsRevision: chat.settingsRevision,
          idempotencyKey: randomUUID(),
        },
        (current) => ({
          chatId: current.id,
          parentRevision: current.headRevision,
          settingsRevision: current.settingsRevision,
          settings: current.settings,
          request: 'Continue the story',
          history: f.store.history(current.headRevision),
          resources: [],
        })
      ).run;
      f.store.startRun(run.id);
      return run;
    };
    const complete = (
      run: ReturnType<typeof reserve>,
      result: { brief?: StoryGuideBrief; error?: string }
    ) => {
      // Seed the provider outcome at the existing execution seam, then use the real
      // completion path to keep the receipt while releasing the full input snapshot.
      f.store.db.prepare('UPDATE runs SET snapshot=? WHERE id=?').run(
        JSON.stringify({
          ...run.snapshot,
          storyGuide: { ...run.snapshot.storyGuide, ...result },
        }),
        run.id
      );
      f.store.completeRun(run.id, 'A completed synthetic scene.', {
        modelCalls: 0,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
      });
    };
    const makeBrief = (run: ReturnType<typeof reserve>, value: string): StoryGuideBrief => ({
      fingerprint: 'a'.repeat(64),
      text: value,
      createdAt: new Date().toISOString(),
      parentRevision: run.parentRevision,
      configRevision: run.snapshot.storyGuide!.revision,
      runId: run.id,
      modelTitle: 'Synthetic writer',
    });

    const first = reserve();
    const oldBrief = makeBrief(first, 'Older cached writing advice.');
    expect(f.store.storyGuide.saveBrief(f.chat.id, oldBrief)).toBe(true);
    complete(first, { brief: oldBrief });

    const second = reserve();
    const lastBrief = makeBrief(second, 'Most recent advice actually supplied to the writer.');
    expect(
      (
        await f.put(2, {
          ...enabled,
          enabled: nextGuide !== 'off',
          position: 'Changed while the guide was running',
        })
      ).statusCode
    ).toBe(200);
    expect(f.store.storyGuide.saveBrief(f.chat.id, lastBrief)).toBe(false);
    complete(second, { brief: lastBrief });
    expect(f.store.storyGuide.get(f.chat.id).brief).toEqual(oldBrief);
    expect(f.store.run(second.id).snapshot.storyGuideReceipt?.brief).toEqual(lastBrief);
    expect((await f.app.inject(`/api/chats/${f.chat.id}/story-guide`)).json().brief).toEqual(
      lastBrief
    );

    const third = reserve();
    complete(third, nextGuide === 'failed' ? { error: 'STORY_GUIDE_PROVIDER_FAILED' } : {});
    const detail = (await f.app.inject(`/api/chats/${f.chat.id}/story-guide`)).json();
    expect(detail.brief).toEqual(lastBrief);
    if (nextGuide === 'failed')
      expect(detail.latestRun).toEqual({
        status: 'completed',
        used: false,
        error: 'STORY_GUIDE_PROVIDER_FAILED',
      });
    else expect(detail.latestRun).toBeUndefined();
  }
);

test('settings remain optional and revision guarded; helper reads the same original-work context', async () => {
  const f = await setup();
  const value = (await f.app.inject(`/api/chats/${f.chat.id}/story-guide`)).json();
  expect(value.config).toMatchObject({ enabled: false, work: 'Silver Isles' });
  expect(value).not.toHaveProperty('analysisRevision');
  expect((await f.put(0, { ...f.config, work: 'Stale overwrite' })).statusCode).toBe(409);
  expect((await f.app.inject(`/api/chats/${f.chat.id}/story-guide`)).json().config).toEqual(
    f.config
  );
  expect(readHelperChatContext(f.store, f.chat.id)).toMatchObject({
    storyGuide: { revision: 1, config: f.config },
    headRevision: f.chat.headRevision,
  });
});

test('retired preview and question endpoints cannot call a model or change story data', async () => {
  const f = await setup();
  const provider = vi.spyOn(transport, 'executeProvider');
  const before = f.store.db.prepare('SELECT * FROM runs').all();
  const state = f.store.storyGuide.get(f.chat.id);
  for (const action of ['ask', 'refresh'] as const)
    expect((await f.post(action, { question: 'Why?', request: 'Continue' })).statusCode).toBe(404);
  expect(provider).not.toHaveBeenCalled();
  expect(f.store.storyGuide.get(f.chat.id)).toEqual(state);
  expect(f.store.db.prepare('SELECT * FROM runs').all()).toEqual(before);
});
