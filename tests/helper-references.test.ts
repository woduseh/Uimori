import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp, type App } from '../server/app.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { resolveHelperReferences, searchHelperReferences } from '../server/helper-references.js';
import { setSceneTitle } from '../server/scene-titles.js';
import { createFixtureChat, fixtureBotInput } from './fixtures/chat.js';
import { seedOutline } from './fixtures/outline.js';
import { completedSource } from './fixtures/illustration.js';
import { applyMentionReplacement, findMentionTrigger } from '../web/helper-mentions.js';
import type { HelperMessage } from '../core/helper.js';
import type { Content } from '../core/product.js';
import * as transport from '../core/transport.js';

const owned: { app: App; path: string }[] = [];
afterEach(async () => {
  for (const { app, path } of owned.splice(0)) {
    await app.close();
    const inside = relative(tmpdir(), path);
    if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('uimori-helper-refs-'))
      throw new Error('Unsafe cleanup');
    rmSync(path, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

async function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-helper-refs-'));
  const app = await createApp({
    dbPath: join(path, 'test.sqlite'),
    buildId: 'helper-refs-test',
    testMode: true,
  });
  owned.push({ app, path });
  const store = app.store;
  const connection = store.product.connection({
    title: 'Synthetic helper',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = store.product.model({
    title: 'Synthetic helper',
    connectionId: connection.id,
    modelId: 'fixture-helper',
    temperature: null,
    maxOutputTokens: 1024,
  });
  const selected = modelWorkspace(store);
  updateModelWorkspace(store, {
    expectedRevision: selected.revision,
    routes: selected.routes,
    translationPolicy: selected.translationPolicy,
    helperModel: { id: model.id },
  });
  const bot = store.product.content(fixtureBotInput('등대지기 미라', '항구 봇 본문')) as Content;
  const chat = createFixtureChat(store, '항구 이야기', { botId: bot.id });
  const scene = completedSource(store, chat.id, '첫 번째 장면의 본문이에요.');
  setSceneTitle(store, scene.id, { title: '등대의 밤', expectedTitle: '' });
  seedOutline(store, chat.id, [
    { op: 'create', level: 'arc', title: '폭풍 전야', intent: '항구에 안개가 깔린다.' },
  ]);
  const outlineNode = store.outline.detail(chat.id).nodes[0]!;
  const chatConversation = await (
    await app.inject({
      method: 'POST',
      url: '/api/helper/conversations',
      payload: { scope: { kind: 'chat', chatId: chat.id } },
    })
  ).json();
  const libraryConversation = await (
    await app.inject({
      method: 'POST',
      url: '/api/helper/conversations',
      payload: { scope: { kind: 'library', workId: 'refs-library' } },
    })
  ).json();
  return { app, store, bot, chat, scene, outlineNode, chatConversation, libraryConversation };
}

test('findMentionTrigger and applyMentionReplacement detect @ triggers cleanly without firing inside emails', () => {
  expect(findMentionTrigger('@', 1)).toEqual({ start: 0, end: 1, query: '' });
  expect(findMentionTrigger('앞 문장 @등대', 8)).toEqual({ start: 5, end: 8, query: '등대' });
  expect(findMentionTrigger('user@example.com', 10)).toBeNull();
  expect(findMentionTrigger('@줄바꿈\n다음', 6)).toBeNull();

  const trigger = findMentionTrigger('앞 문장 @등대의 대사', 8)!;
  expect(applyMentionReplacement('앞 문장 @등대의 대사', trigger, '장면 1: 등대의 밤')).toEqual({
    text: '앞 문장 @장면 1: 등대의 밤 의 대사',
    cursor: 18,
  });
});

test('helper @ reference search, model delivery, scope validation and deletion safety work end to end', async () => {
  const { app, store, bot, chat, scene, outlineNode, chatConversation, libraryConversation } =
    await fixture();
  const captured: transport.ProviderRequest[] = [];
  vi.spyOn(transport, 'executeProvider').mockImplementation(async (_connection, request) => {
    captured.push(structuredClone(request));
    return {
      status: 'completed',
      text: '지정한 대상을 확인했어요.',
      toolCalls: [],
      refusal: null,
      error: null,
      usage: { inputTokens: 10, outputTokens: 5, costUsd: null, raw: null, priceRevision: null },
      opaqueState: null,
    };
  });

  const searchAll = await app.inject({
    method: 'GET',
    url: `/api/helper/conversations/${chatConversation.id}/references?q=`,
  });
  expect(searchAll.statusCode).toBe(200);
  expect(searchAll.json()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'scene', id: scene.id, sceneNumber: 1, title: '등대의 밤' }),
      expect.objectContaining({ kind: 'outline', id: outlineNode.id, title: '폭풍 전야' }),
      expect.objectContaining({ kind: 'content', id: bot.id, role: 'bot', title: '등대지기 미라' }),
    ])
  );

  expect(searchHelperReferences(store, { kind: 'chat', chatId: chat.id }, '장면 1')).toEqual([
    expect.objectContaining({ kind: 'scene', id: scene.id, sceneNumber: 1 }),
  ]);
  expect(searchHelperReferences(store, { kind: 'library', workId: 'x' }, '등대의 밤')).toEqual([]);

  const crossScope = await app.inject({
    method: 'POST',
    url: `/api/helper/conversations/${libraryConversation.id}/messages`,
    payload: {
      requestKey: randomUUID(),
      text: '장면을 봐줘',
      references: [{ kind: 'scene', id: scene.id }],
    },
  });
  expect(crossScope.statusCode).toBe(403);

  const posted = await app.inject({
    method: 'POST',
    url: `/api/helper/conversations/${chatConversation.id}/messages`,
    payload: {
      requestKey: randomUUID(),
      text: '@장면 1: 등대의 밤 과 @등대지기 미라 를 비교해 줘',
      references: [
        { kind: 'scene', id: scene.id },
        { kind: 'outline', id: outlineNode.id },
        { kind: 'content', id: bot.id },
      ],
    },
  });
  expect(posted.statusCode).toBe(200);
  const taskId = posted.json().id as string;
  await vi.waitFor(async () => {
    const taskRes = await app.inject({ method: 'GET', url: `/api/helper/tasks/${taskId}` });
    expect(taskRes.json().status).toBe('completed');
  });

  expect(captured).toHaveLength(1);
  const source = captured[0]!.input.source as Record<string, unknown>;
  expect(source.referencedTargets).toEqual([
    {
      kind: 'scene',
      sourceId: scene.id,
      chatId: chat.id,
      sceneNumber: 1,
      title: '등대의 밤',
      readTool: 'scene.read',
    },
    {
      kind: 'outline',
      nodeId: outlineNode.id,
      chatId: chat.id,
      title: '폭풍 전야',
      readTool: 'outline.read',
    },
    {
      kind: 'content',
      id: bot.id,
      role: 'bot',
      title: '등대지기 미라',
      readTool: 'resource.read',
    },
  ]);

  const messagesBeforeDelete = (
    await app.inject({
      method: 'GET',
      url: `/api/helper/conversations/${chatConversation.id}/messages`,
    })
  ).json() as HelperMessage[];
  const userMessageBefore = messagesBeforeDelete.find((item) => item.role === 'user');
  expect(userMessageBefore?.references).toHaveLength(3);

  const rawSnapshot = store.db
    .prepare('SELECT snapshot FROM helper_tasks WHERE id=?')
    .get(taskId) as { snapshot: string };
  expect(rawSnapshot.snapshot).not.toContain('등대의 밤');
  expect(rawSnapshot.snapshot).not.toContain('등대지기 미라');

  const impact = (
    await app.inject({
      method: 'GET',
      url: `/api/chats/${chat.id}/sources/${scene.id}/deletion-impact`,
    })
  ).json();
  const deleted = await app.inject({
    method: 'DELETE',
    url: `/api/chats/${chat.id}/sources/${scene.id}`,
    payload: { scope: 'only', ...impact.request, idempotencyKey: randomUUID() },
  });
  expect(deleted.statusCode).toBe(200);
  expect(
    resolveHelperReferences(store, { kind: 'chat', chatId: chat.id }, [
      { kind: 'scene', id: scene.id },
      { kind: 'content', id: bot.id },
    ])
  ).toEqual([expect.objectContaining({ kind: 'content', id: bot.id, title: '등대지기 미라' })]);
  const messagesAfter = (
    await app.inject({
      method: 'GET',
      url: `/api/helper/conversations/${chatConversation.id}/messages`,
    })
  ).json() as HelperMessage[];
  const userMessageAfter = messagesAfter.find((item) => item.role === 'user');
  expect(userMessageAfter?.references ?? []).toEqual([]);
  const stale = await app.inject({
    method: 'POST',
    url: `/api/helper/conversations/${chatConversation.id}/messages`,
    payload: {
      requestKey: randomUUID(),
      text: '@장면 1: 등대의 밤 을 다시 봐줘',
      references: [{ kind: 'scene', id: scene.id }],
    },
  });
  expect([stale.statusCode, stale.json()]).toEqual([404, { code: 'HELPER_REFERENCE_NOT_FOUND' }]);
});
