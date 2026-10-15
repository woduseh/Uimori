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
import { fixtureBotInput } from './fixtures/chat.js';

const owned: { app: App; path: string }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { app, path } of owned.splice(0)) {
    await app.close();
    rmSync(path, { recursive: true, force: true });
  }
});
const success: transport.ProviderResult = {
  status: 'completed',
  text: '원작과 달리 이 이야기에서는 미라가 비밀을 알고 있어요.',
  toolCalls: [],
  refusal: null,
  error: null,
  usage: { inputTokens: 10, outputTokens: 20, costUsd: null, raw: null, priceRevision: null },
  opaqueState: null,
};
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
function mockSend(wait?: () => Promise<void>) {
  return vi
    .spyOn(transport, 'executeProvider')
    .mockImplementation(async (connection, request, options) => {
      transport.validateRequest(request);
      await options.beforeTurn?.();
      await options.onWire?.({
        connectionId: connection.id,
        protocol: connection.protocol,
        role: request.role,
        modelId: request.modelId,
        method: 'POST',
        url: connection.endpoint,
        headers: {},
        body: {},
        bodySha256: 'fixture',
        stablePrefixSha256: 'fixture',
      });
      await wait?.();
      return success;
    });
}
function authoredState(app: App) {
  return [
    'chats',
    'sources',
    'runs',
    'author_notes',
    'author_note_heads',
    'author_note_commands',
  ].map((table) => app.store.db.prepare(`SELECT * FROM ${table}`).all());
}

test('explicit questions and previews work while automatic guidance is off, using current sources without changing story or cached writing advice', async () => {
  const f = await setup();
  const summary = await f.app.inject({
    method: 'PUT',
    url: `/api/chats/${f.chat.id}/context/summary`,
    payload: {
      expectedRevision: 0,
      expectedHeadRevision: f.chat.headRevision,
      idempotencyKey: randomUUID(),
      summary: 'EXISTING_DERIVED_SUMMARY',
    },
  });
  expect(summary.statusCode, summary.body).toBe(200);
  const before = authoredState(f.app);
  const revision = (await f.app.inject(`/api/chats/${f.chat.id}/story-guide`)).json()
    .analysisRevision;
  const send = mockSend();
  const answer = await f.post('ask', {
    question: 'QUESTION_ABOUT_ORIGINAL',
    request: 'NEXT_SCENE_REQUEST',
  });
  expect(answer.statusCode, answer.body).toBe(200);
  expect(answer.json()).toEqual({ text: success.text });
  const input = JSON.stringify(send.mock.calls[0][1]);
  for (const marker of [
    'QUESTION_ABOUT_ORIGINAL',
    'NEXT_SCENE_REQUEST',
    'USER_REVEALS_SECRET',
    'MIRA_NOW_KNOWS_SECRET',
    'AUTHOR_REFERENCE',
    'EXISTING_DERIVED_SUMMARY',
  ])
    expect(input).toContain(marker);
  const preview = await f.post('refresh', {});
  expect(preview.statusCode, preview.body).toBe(200);
  expect(send).toHaveBeenCalledTimes(2);
  expect(f.store.storyGuide.get(f.chat.id).brief).toBeNull();
  expect(authoredState(f.app)).toEqual(before);
  f.store.event(f.chat.id, 'story-guide.generated', 'synthetic-result');
  f.store.event(f.chat.id, 'run.usage', 'synthetic-run');
  expect((await f.app.inject(`/api/chats/${f.chat.id}/story-guide`)).json().analysisRevision).toBe(
    revision
  );
  const receipts = f.store.db
    .prepare('SELECT usage_kind,usage_detached,request,response FROM attempts')
    .all();
  expect(receipts).toHaveLength(2);
  for (const receipt of receipts) {
    expect(receipt).toMatchObject({ usage_kind: 'story-guide', usage_detached: 1, request: '{}' });
    expect(String(receipt.response)).not.toContain(success.text);
  }
});

test.each(['settings', 'source'] as const)(
  'a late answer is rejected after %s changes, without replacing writing advice',
  async (change) => {
    const f = await setup();
    const inputRevision = (await f.app.inject(`/api/chats/${f.chat.id}/story-guide`)).json()
      .analysisRevision;
    expect((await f.put(0)).statusCode).toBe(409);
    let started!: () => void;
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    mockSend(async () => {
      started();
      await pending;
    });
    const response = Promise.resolve(f.post('ask', { question: 'What did Mira know?' }));
    await ready;
    if (change === 'settings')
      expect((await f.put(1, { ...f.config, position: 'Chapter 9' })).statusCode).toBe(200);
    else
      f.store.editSource(f.chat.headRevision!, {
        expectedRevision: 0,
        text: 'MIRA_DOES_NOT_KNOW_SECRET',
      });
    expect(
      (await f.app.inject(`/api/chats/${f.chat.id}/story-guide`)).json().analysisRevision
    ).toBeGreaterThan(inputRevision);
    finish();
    const answer = await response;
    expect(answer.statusCode, answer.body).toBe(409);
    expect(answer.json()).toEqual({ error: 'STORY_GUIDE_STALE' });
    expect(f.store.storyGuide.get(f.chat.id)).toMatchObject({
      revision: change === 'settings' ? 2 : 1,
      config: { position: change === 'settings' ? 'Chapter 9' : '' },
      brief: null,
    });
  }
);

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

test('shutdown cancels an explicit guide call and does not publish its late text', async () => {
  const f = await setup();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let cancelled = false;
  vi.spyOn(transport, 'executeProvider').mockImplementation(async (_, __, options) => {
    started();
    await new Promise<void>((resolve) =>
      options.signal.addEventListener(
        'abort',
        () => {
          cancelled = true;
          resolve();
        },
        { once: true }
      )
    );
    return success;
  });
  const response = Promise.resolve(f.post('refresh', {}));
  await ready;
  await f.app.close();
  expect(cancelled).toBe(true);
  expect((await response).statusCode).toBe(408);
});
