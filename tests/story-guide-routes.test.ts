import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultStoryGuideConfig } from '../core/story-guide.js';
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
