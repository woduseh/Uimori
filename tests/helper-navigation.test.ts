import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import Fastify from 'fastify';
import { afterEach, expect, test } from 'vitest';
import type { HelperScope, HelperTaskSnapshot } from '../core/helper.js';
import type { Content } from '../core/product.js';
import { chatDeletionImpact, deleteChat } from '../server/chat-deletion.js';
import { markHelperConversationRead } from '../server/helper-read-state.js';
import { helperRoutes } from '../server/helper-routes.js';
import type { HelperRuntime } from '../server/helper-runtime.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { apiErrorDisplay } from '../web/api-errors.js';
import { loadLocale, setLocale } from '../web/i18n.js';
import { fixtureBotInput } from './fixtures/chat.js';

const owned: { store?: Store; path: string }[] = [];
afterEach(() => {
  for (const { store, path } of owned.splice(0)) {
    store?.close();
    const inside = relative(tmpdir(), path);
    if (isAbsolute(inside) || !inside.startsWith('uimori-helper-navigation-'))
      throw new Error('Unsafe cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-helper-navigation-'));
  const store = new Store(join(path, 'story.sqlite'));
  owned.push({ store, path });
  const workspace = new HelperWorkspace(store);
  const scope = { kind: 'library', workId: 'workspace' } as const;
  return { store, workspace, scope };
}
function finishTask(f: ReturnType<typeof fixture>, conversationId: string, scope: HelperScope) {
  const connection = f.store.product.connection({
    title: 'Synthetic',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = f.store.product.model({
    title: 'Synthetic',
    connectionId: connection.id,
    modelId: 'fixture',
    temperature: null,
    maxOutputTokens: 128,
  });
  const task = f.workspace.enqueue(conversationId, randomUUID(), '요청', {
    scope,
    model: f.store.product.modelSnapshot(model.id),
    history: [],
    persona: '',
    limits: { totalCalls: 24, helperCalls: 12 },
  });
  f.workspace.start(task.id, 'owner');
  f.workspace.finish(task.id, 'owner', 1, 'completed', '답변', null);
  return f.workspace.list({ kind: 'all' }).find((item) => item.id === conversationId)!
    .latestActivityEventSeq;
}

test('the conversation made by opening the helper is listed as unused until it gets a request or a name', () => {
  const f = fixture();
  const unused = (id: string) =>
    f.workspace.list({ kind: 'all' }).find((item) => item.id === id)?.unused;
  const opened = f.workspace.open(f.scope);
  const named = f.workspace.open({ kind: 'library', workId: 'other' });
  const requested = f.workspace.create(f.scope, 'request:new');
  expect([unused(opened.id), unused(named.id), unused(requested.id)]).toEqual([
    true,
    true,
    undefined,
  ]);
  f.workspace.update(named.id, named.revision, { title: '내 대화' });
  expect(unused(named.id)).toBeUndefined();
  finishTask(f, opened.id, f.scope);
  expect(unused(opened.id)).toBeUndefined();
});

test('new conversation creation atomically assigns its project and retries its exact receipt', async () => {
  const f = fixture();
  const project = f.workspace.createGroup('작품', 'project');
  const app = Fastify();
  helperRoutes(app, { workspace: f.workspace, store: f.store } as HelperRuntime);
  const payload = { scope: f.scope, requestKey: 'new-request', projectId: project.id };
  try {
    f.store.db.exec(`CREATE TRIGGER reject_helper_membership BEFORE INSERT ON helper_conversation_memberships
      BEGIN SELECT RAISE(ABORT, 'membership rejected'); END;`);
    expect(
      (await app.inject({ method: 'POST', url: '/api/helper/conversations/new', payload }))
        .statusCode
    ).toBe(500);
    expect(f.workspace.list({ kind: 'all' })).toEqual([]);
    f.store.db.exec('DROP TRIGGER reject_helper_membership');
    const created = await app.inject({
      method: 'POST',
      url: '/api/helper/conversations/new',
      payload,
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ projectId: project.id, scope: f.scope, revision: 1 });
    const retried = await app.inject({
      method: 'POST',
      url: '/api/helper/conversations/new',
      payload,
    });
    expect(retried.json()).toEqual(created.json());
    expect(f.workspace.list({ kind: 'all' })).toHaveLength(1);
    const changed = await app.inject({
      method: 'POST',
      url: '/api/helper/conversations/new',
      payload: { ...payload, projectId: null },
    });
    expect(changed.statusCode).toBe(409);
    f.workspace.moveGroup(created.json().id, 1, null);
    expect(
      (await app.inject({ method: 'POST', url: '/api/helper/conversations/new', payload })).json()
        .projectId
    ).toBeNull();
  } finally {
    await app.close();
  }
});

test('legacy creation hashes remain compatible and invalid projects cannot leave conversations behind', () => {
  const f = fixture();
  const original = f.workspace.create(f.scope, 'legacy');
  const legacyHash = createHash('sha256').update('{"title":null}').digest('hex');
  expect(
    f.store.db.prepare('SELECT creation_hash FROM helper_conversations WHERE id=?').get(original.id)
      ?.creation_hash
  ).toBe(legacyHash);
  expect(f.workspace.create(f.scope, 'legacy', undefined, null).id).toBe(original.id);
  const project = f.workspace.createGroup('프로젝트', 'project');
  expect(() => f.workspace.create(f.scope, 'legacy', undefined, project.id)).toThrow(
    /request key/u
  );
  expect(() => f.workspace.create(f.scope, 'missing-project', undefined, 'missing')).toThrow(
    'HELPER_PROJECT_NOT_FOUND'
  );
  expect(f.workspace.list({ kind: 'all' })).toHaveLength(1);
});

test('terminal activity survives metadata changes and remains discoverable beyond recent feeds', () => {
  const f = fixture();
  const connection = f.store.product.connection({
    title: 'Synthetic',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = f.store.product.model({
    title: 'Synthetic',
    connectionId: connection.id,
    modelId: 'fixture',
    temperature: null,
    maxOutputTokens: 128,
  });
  const conversation = f.workspace.create(f.scope, 'old-result');
  const snapshot: HelperTaskSnapshot = {
    scope: f.scope,
    model: f.store.product.modelSnapshot(model.id),
    history: [],
    persona: '',
    limits: { totalCalls: 24, helperCalls: 12 },
  };
  const task = f.workspace.enqueue(conversation.id, 'task', '이전 요청', snapshot);
  expect(f.workspace.list({ kind: 'all' })[0].latestActivityEventSeq).toBe(0);
  expect(f.workspace.start(task.id, 'owner')).toBe(true);
  expect(f.workspace.finish(task.id, 'owner', 1, 'completed', '완료한 답변', null)).toBe(true);
  const completed = f.workspace.list({ kind: 'all' })[0];
  expect(completed.latestActivityEventSeq).toBeGreaterThan(0);
  expect(completed.lastTaskStatus).toBe('completed');
  const project = f.workspace.createGroup('분류', 'project');
  const current = f.workspace.conversation(conversation.id);
  f.workspace.moveGroup(conversation.id, current.revision, project.id);
  f.workspace.update(conversation.id, f.workspace.conversation(conversation.id).revision, {
    title: '제목 수정',
  });
  f.workspace.editMessage(
    conversation.id,
    f.workspace.messages(conversation.id)[0].id,
    f.workspace.conversation(conversation.id).revision,
    '질문 수정'
  );
  const changed = f.workspace.list({ kind: 'all' })[0];
  expect(changed.latestEventSeq).toBeGreaterThan(completed.latestEventSeq);
  expect(changed.latestActivityEventSeq).toBe(completed.latestActivityEventSeq);
  expect(changed.lastActivityAt).toBe(completed.lastActivityAt);
  expect(changed.lastTaskStatus).toBe('completed');
  f.workspace.enqueue(conversation.id, 'next-task', '다음 요청', snapshot);
  expect(f.workspace.list({ kind: 'all' })[0].lastTaskStatus).toBe('completed');
  for (let i = 0; i < 100; i++) f.workspace.create(f.scope, `later-${i}`);
  const old = f.workspace.list({ kind: 'all' }).find((item) => item.id === conversation.id);
  expect(old?.latestActivityEventSeq).toBe(completed.latestActivityEventSeq);
});

test('read state only moves forward, survives reopening and is removed with its conversation or chat', async () => {
  const f = fixture();
  const app = Fastify();
  helperRoutes(app, { workspace: f.workspace, store: f.store } as HelperRuntime);
  const read = async (id: string, activityEventSeq: number) => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/helper/conversations/${id}/read`,
      payload: { activityEventSeq },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().readActivityEventSeq as number;
  };
  const summary = (id: string) => f.workspace.list({ kind: 'all' }).find((item) => item.id === id);
  try {
    const conversation = f.workspace.create(f.scope, 'read');
    expect(summary(conversation.id)?.readActivityEventSeq).toBe(0);
    const first = finishTask(f, conversation.id, f.scope);
    expect(await read(conversation.id, first + 1000)).toBe(first);
    const second = finishTask(f, conversation.id, f.scope);
    expect(await read(conversation.id, second)).toBe(second);
    expect(await read(conversation.id, first)).toBe(second);
    expect(await read(conversation.id, 0)).toBe(second);
    f.workspace.update(conversation.id, f.workspace.conversation(conversation.id).revision, {
      title: '제목 수정',
    });
    expect(summary(conversation.id)).toMatchObject({
      latestActivityEventSeq: second,
      readActivityEventSeq: second,
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/helper/conversations/missing/read',
          payload: { activityEventSeq: 1 },
        })
      ).statusCode
    ).toBe(404);

    const { path } = owned.at(-1)!;
    f.store.close();
    owned.pop();
    const reopened = new Store(join(path, 'story.sqlite'));
    owned.push({ store: reopened, path });
    const workspace = new HelperWorkspace(reopened);
    expect(
      workspace.list({ kind: 'all' }).find((item) => item.id === conversation.id)
        ?.readActivityEventSeq
    ).toBe(second);
    const key = `helper-read:v1:${conversation.id}`;
    const stored = () => reopened.db.prepare('SELECT 1 FROM app_metadata WHERE key=?').get(key);
    expect(stored()).toBeTruthy();
    workspace.delete(conversation.id, workspace.deletionImpact(conversation.id).request);
    expect(stored()).toBeUndefined();

    const bot = reopened.product.content(fixtureBotInput('Read owner')) as Content;
    const chat = reopened.createChat('Read chat', { botId: bot.id });
    const chatScope = { kind: 'chat', chatId: chat.id } as const;
    const chatConversation = workspace.open(chatScope);
    const chatFixture = { store: reopened, workspace, scope: f.scope };
    const chatSequence = finishTask(chatFixture, chatConversation.id, chatScope);
    expect(markHelperConversationRead(reopened, chatConversation.id, chatSequence)).toEqual({
      readActivityEventSeq: chatSequence,
    });
    const chatKey = `helper-read:v1:${chatConversation.id}`;
    expect(reopened.db.prepare('SELECT 1 FROM app_metadata WHERE key=?').get(chatKey)).toBeTruthy();
    deleteChat(reopened, chat.id, chatDeletionImpact(reopened, chat.id).request);
    expect(
      reopened.db.prepare('SELECT 1 FROM app_metadata WHERE key=?').get(chatKey)
    ).toBeUndefined();
  } finally {
    await app.close();
  }
});

test('a stale screen acting on a project or conversation deleted elsewhere gets a coded error', async () => {
  const path = mkdtempSync(join(tmpdir(), 'uimori-helper-navigation-'));
  owned.push({ path });
  const app = await createApp({
    dbPath: join(path, 'test.sqlite'),
    buildId: 'helper-navigation-test',
    testMode: true,
  });
  try {
    const conversation = (
      await app.inject({
        method: 'POST',
        url: '/api/helper/conversations/new',
        payload: { scope: { kind: 'library', workId: 'workspace' }, requestKey: 'stale' },
      })
    ).json();
    const impact = (
      await app.inject({ url: `/api/helper/conversations/${conversation.id}/deletion` })
    ).json();
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/helper/conversations/${conversation.id}`,
          payload: impact.request,
        })
      ).statusCode
    ).toBe(200);
    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/helper/conversations/${conversation.id}`,
      payload: { expectedRevision: conversation.revision, title: 'Renamed in a stale tab' },
    });
    expect([stale.statusCode, stale.json()]).toEqual([
      404,
      { code: 'HELPER_CONVERSATION_NOT_FOUND' },
    ]);
    await loadLocale('en');
    setLocale('en');
    expect(apiErrorDisplay(stale.json(), stale.statusCode, 'PATCH')).toBe(
      'The assistant conversation was not found. It may have been deleted elsewhere.'
    );
    const project = (
      await app.inject({
        method: 'POST',
        url: '/api/helper/projects',
        payload: { title: 'Project', requestKey: 'project' },
      })
    ).json();
    await app.inject({
      method: 'DELETE',
      url: `/api/helper/projects/${project.id}`,
      payload: { expectedRevision: project.revision },
    });
    const kept = (
      await app.inject({
        method: 'POST',
        url: '/api/helper/conversations/new',
        payload: { scope: { kind: 'library', workId: 'workspace' }, requestKey: 'kept' },
      })
    ).json();
    const move = await app.inject({
      method: 'PATCH',
      url: `/api/helper/conversations/${kept.id}/project`,
      payload: { expectedRevision: kept.revision, projectId: project.id },
    });
    expect([move.statusCode, move.json()]).toEqual([404, { code: 'HELPER_PROJECT_NOT_FOUND' }]);
  } finally {
    setLocale('ko');
    await app.close();
  }
});
