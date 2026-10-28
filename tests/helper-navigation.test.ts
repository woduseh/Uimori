import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import Fastify from 'fastify';
import { afterEach, expect, test } from 'vitest';
import type { HelperTaskSnapshot } from '../core/helper.js';
import { helperRoutes } from '../server/helper-routes.js';
import type { HelperRuntime } from '../server/helper-runtime.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { Store } from '../server/store.js';

const owned: { store: Store; path: string }[] = [];
afterEach(() => {
  for (const { store, path } of owned.splice(0)) {
    store.close();
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
    // Retrying after an unobserved response returns the committed conversation and membership.
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
    // A later explicit move is preserved when the original creation request is replayed.
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
  expect(() => f.workspace.create(f.scope, 'legacy', undefined, project.id)).toThrow(/요청 키/);
  expect(() => f.workspace.create(f.scope, 'missing-project', undefined, 'missing')).toThrow(
    /프로젝트/
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

test.each(['failed', 'cancelled', 'interrupted'] as const)(
  '%s task results advance activity without counting queued work',
  (status) => {
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
    const conversation = f.workspace.create(f.scope, 'result');
    const task = f.workspace.enqueue(conversation.id, 'task', '요청', {
      scope: f.scope,
      model: f.store.product.modelSnapshot(model.id),
      history: [],
      persona: '',
      limits: { totalCalls: 24, helperCalls: 12 },
    });
    expect(f.workspace.list({ kind: 'all' })[0].latestActivityEventSeq).toBe(0);
    if (status === 'cancelled') f.workspace.cancel(task.id);
    else if (status === 'interrupted') f.workspace.interrupt();
    else {
      f.workspace.start(task.id, 'owner');
      f.workspace.finish(task.id, 'owner', 1, 'failed', '', 'synthetic failure');
    }
    expect(f.workspace.list({ kind: 'all' })[0].latestActivityEventSeq).toBeGreaterThan(0);
    expect(f.workspace.list({ kind: 'all' })[0].lastTaskStatus).toBe(status);
  }
);
