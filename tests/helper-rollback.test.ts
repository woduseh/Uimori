import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { HelperRollbackUnit, HelperTask } from '../core/helper.js';
import { OUTLINE_LEVELS, outlineParentAllowed, type OutlineLevel } from '../core/outline.js';
import type { Content } from '../core/product.js';
import { editableResource, type ResourceModel } from '../core/resource-editing.js';
import * as transport from '../core/transport.js';
import { createApp } from '../server/app.js';
import {
  HELPER_CHANGE_RETENTION,
  authoredView,
  captureHelperTarget,
  helperResourceHash,
  helperStateHash,
  pruneHelperChanges,
  recordHelperChatLoreChange,
  withHelperChange,
} from '../server/helper-changes.js';
import { chatOverrideHash } from '../core/chat-overrides.js';
import { ChatOverridesStore } from '../server/chat-overrides.js';
import { nativeContent } from './fixtures/native-content.js';
import { applyHelperResourceMutation } from '../server/helper-resource-mutation.js';
import { helperResourceOperation } from '../server/helper-resource-tools.js';
import { helperRollbackView, rollBackHelperTask } from '../server/helper-rollback.js';
import { HelperRuntime } from '../server/helper-runtime.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { ResponseStreamStore } from '../server/response-stream.js';
import { invokeHelperSceneTool } from '../server/helper-scene-tools.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { deleteLibraryItem } from '../server/library-deletion.js';
import { readResource, saveResource } from '../server/resource-service.js';
import { deleteScenes, sceneDeletionImpact } from '../server/scene-deletion.js';
import { latestTranslation } from '../server/source-editing.js';
import { Store } from '../server/store.js';
import { pruneUnusedData } from '../server/unused-data.js';
import { createFixtureChat, fixtureBotInput } from './fixtures/chat.js';
import { completedSource } from './fixtures/illustration.js';
import { helperCall, helperDone, selectFixtureModels } from './fixtures/scripted-helper.js';

const owned: { dir: string; store: Store }[] = [];
afterEach(() => {
  for (const { dir, store } of owned.splice(0)) {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-helper-rollback-'));
  const store = new Store(join(dir, 'test.sqlite'));
  owned.push({ dir, store });
  const workspace = new HelperWorkspace(store);
  const connection = store.product.connection({
    title: 'Local test',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = store.product.model({
    title: 'Local test',
    connectionId: connection.id,
    modelId: 'fixture-rollback',
    temperature: null,
    maxOutputTokens: 1024,
  });
  const chat = createFixtureChat(store, '되돌리기 채팅');
  const scenes = [
    completedSource(store, chat.id, '첫 장면이에요.\n그는 다리를 건넜다.\n'),
    completedSource(store, chat.id, '둘째 장면이에요.\n그녀가 말했다.\n'),
  ];
  const conversation = workspace.open({ kind: 'chat', chatId: chat.id });
  const begin = () => {
    const task = workspace.enqueue(conversation.id, randomUUID(), 'Edit', {
      scope: conversation.scope,
      model: store.product.modelSnapshot(model.id),
      history: [],
      persona: '',
      limits: { helperCalls: 64, totalCalls: 128 },
    });
    workspace.start(task.id, 'rollback-fixture');
    return workspace.task(task.id);
  };
  const finish = (task: HelperTask) =>
    workspace.finish(task.id, 'rollback-fixture', 1, 'completed', '', null);
  const resource = (task: HelperTask, name: string, args: Record<string, unknown>) => {
    const operation = helperResourceOperation(name, args);
    if (!operation || operation.readOnly) throw new Error(`not a resource mutation: ${name}`);
    const receiptId = `${task.id}:${randomUUID()}`;
    return workspace.operation(task.id, receiptId, { name, args }, () =>
      applyHelperResourceMutation(
        store,
        workspace,
        task,
        receiptId,
        name,
        args,
        operation.targets ?? operation.target
      )
    ) as Record<string, any>;
  };
  const scene = (task: HelperTask, args: Record<string, unknown>) =>
    workspace.operation(
      task.id,
      `${task.id}:${randomUUID()}`,
      { name: 'scene.patch', args, chatId: chat.id },
      () => invokeHelperSceneTool(store, chat.id, 'scene.patch', args, task)
    ) as Record<string, any>;
  const read = (sourceId: string, target = 'original') =>
    (({ chatId: _chatId, ...guards }) => guards)(
      (invokeHelperSceneTool(store, chat.id, 'scene.read', { sourceId, target }) as any).editTarget
    );
  const tracked = (
    task: HelperTask,
    target: Parameters<typeof withHelperChange>[2],
    mutate: () => unknown
  ) =>
    workspace.operation(task.id, `${task.id}:${randomUUID()}`, { target }, () =>
      withHelperChange(store, task, target, mutate)
    );
  const translate = (sourceId: string, text: string) => {
    const source = store.source(sourceId);
    return store.editTranslation(sourceId, {
      text,
      expectedRevision: latestTranslation(store, sourceId)?.revision ?? 0,
      expectedSourceHash: source.hash,
    });
  };
  const translation = (sourceId: string) =>
    captureHelperTarget(store, { domain: 'scene', chatId: chat.id, sourceId, field: 'translation' })
      .value as string | null;
  const rollBack = (task: HelperTask, unit?: string) =>
    rollBackHelperTask(store, workspace, task.id, unit);
  for (const [index, item] of scenes.entries()) translate(item.id, `Scene ${index + 1}.`);
  return {
    store,
    workspace,
    chat,
    scenes,
    conversation,
    begin,
    finish,
    resource,
    scene,
    read,
    tracked,
    translate,
    translation,
    rollBack,
  };
}
type Fixture = ReturnType<typeof fixture>;

function setDescription(store: Store, id: string, value: string) {
  const saved = readResource(store, 'content', id);
  const model = structuredClone(editableResource('content', saved)) as any;
  model.package.nativeRisu.card.description = value;
  saveResource(store, {
    kind: 'content',
    id,
    expectedRevision: saved.revision,
    model: model as ResourceModel,
  });
}
const description = (store: Store, id: string) =>
  (readResource(store, 'content', id) as Content).package!.nativeRisu!.card.description;

function outlineShape(store: Store, chatId: string) {
  const nodes = store.outline.nodes(chatId);
  const titles = new Map(nodes.map((node) => [node.id, node.title]));
  const tree = (parentId: string | null): unknown[] =>
    nodes
      .filter((node) => node.parentId === parentId)
      .sort((a, b) => a.position - b.position || a.title.localeCompare(b.title))
      .map((node) => ({
        level: node.level,
        title: node.title,
        intent: node.intent,
        fixed: node.fixed,
        position: node.position,
        related: (node.relatedIds ?? []).map((id) => titles.get(id)),
        children: tree(node.id),
      }));
  return tree(null);
}
function noteShape(store: Store, chatId: string) {
  return (
    captureHelperTarget(store, { domain: 'notes', chatId }).value as {
      kind: string;
      text: string;
    }[]
  )
    .map((note) => `${note.kind}\n${note.text}`)
    .sort();
}

test('rolling back a task that changed source and translation restores the source first and the translation against it', () => {
  const f = fixture();
  const [first] = f.scenes;
  const task = f.begin();
  f.scene(task, {
    ...f.read(first!.id),
    text: '첫 장면이에요.\n그는 강을 건넜다.\n',
    translation: { ...f.read(first!.id, 'translation'), text: 'He crossed the river.' },
  });
  f.finish(task);
  expect(f.translation(first!.id)).toBe('He crossed the river.');

  const view = helperRollbackView(f.store, f.workspace, task.id);
  expect(view).toMatchObject({
    blocked: null,
    units: [
      {
        unit: `scene:${first!.id}`,
        status: 'restorable',
        changeTargetIds: [`${first!.id}:original`, `${first!.id}:translation`],
        touches: {
          domain: 'scene',
          chatId: f.chat.id,
          sourceId: first!.id,
          fields: ['original', 'translation'],
        },
      },
    ],
  });
  const result = f.rollBack(task);
  expect(result.units).toMatchObject([
    { status: 'restored', notices: ['translation-images-not-restored'] },
  ]);
  const source = f.store.source(first!.id);
  expect(source.text).toBe('첫 장면이에요.\n그는 다리를 건넜다.\n');
  expect(latestTranslation(f.store, first!.id)).toMatchObject({
    sourceHash: source.hash,
    result: { text: 'Scene 1.' },
  });
  expect(f.translation(first!.id)).toBe('Scene 1.');
});

test('a task that changed only the source gets the translation back that the edit made stale', () => {
  const f = fixture();
  const [first] = f.scenes;
  const task = f.begin();
  f.scene(task, { ...f.read(first!.id), text: '바뀐 첫 장면.\n' });
  f.finish(task);
  expect(f.translation(first!.id)).toBeNull();
  expect(f.rollBack(task).units).toMatchObject([{ status: 'restored' }]);
  expect(f.store.source(first!.id).text).toBe('첫 장면이에요.\n그는 다리를 건넜다.\n');
  expect(f.translation(first!.id)).toBe('Scene 1.');
});

test('a later user edit is left alone and reported, and rolling back twice is the same as once', () => {
  const f = fixture();
  const [first, second] = f.scenes;
  const bot = f.store.product.content(fixtureBotInput('되돌릴 봇', '처음 설명'));
  const task = f.begin();
  f.scene(task, { ...f.read(first!.id), text: '도우미가 고친 첫 장면.\n' });
  f.scene(task, { ...f.read(second!.id), text: '도우미가 고친 둘째 장면.\n' });
  f.resource(task, 'resource.patch', {
    kind: 'content',
    id: bot.id,
    expectedRevision: bot.revision,
    changes: [{ op: 'set', path: '/package/nativeRisu/card/description', value: '도우미 설명' }],
  });
  f.finish(task);
  f.store.editSource(second!.id, {
    text: '사용자가 다시 고친 둘째 장면.\n',
    expectedRevision: f.store.source(second!.id).editRevision ?? 0,
  });

  const once = f.rollBack(task);
  expect(once.units.map(({ unit, status, reason }) => [unit, status, reason])).toEqual([
    [`scene:${first!.id}`, 'restored', undefined],
    [`scene:${second!.id}`, 'changed-since', 'changed-after-task'],
    [`resource:content:${bot.id}`, 'restored', undefined],
  ]);
  expect(f.store.source(second!.id).text).toBe('사용자가 다시 고친 둘째 장면.\n');
  expect(description(f.store, bot.id)).toBe('처음 설명');
  const revisions = [
    f.store.source(first!.id).editRevision,
    readResource(f.store, 'content', bot.id).revision,
  ];
  const twice = f.rollBack(task);
  expect(twice.units.map(({ unit, status }) => [unit, status])).toEqual(
    once.units.map(({ unit, status }) => [unit, status])
  );
  expect([
    f.store.source(first!.id).editRevision,
    readResource(f.store, 'content', bot.id).revision,
  ]).toEqual(revisions);
});

test('an edit by someone else during the task blocks the rollback of that target', () => {
  const f = fixture();
  const bot = f.store.product.content(fixtureBotInput('중간 수정 봇', '처음'));
  const task = f.begin();
  const patch = (value: string) =>
    f.resource(task, 'resource.patch', {
      kind: 'content',
      id: bot.id,
      expectedRevision: readResource(f.store, 'content', bot.id).revision,
      changes: [{ op: 'set', path: '/package/nativeRisu/card/description', value }],
    });
  patch('도우미 첫 수정');
  setDescription(f.store, bot.id, '사용자 수정');
  patch('도우미 둘째 수정');
  f.finish(task);
  expect(f.rollBack(task).units).toMatchObject([
    { status: 'changed-since', reason: 'changed-during-task' },
  ]);
  expect(description(f.store, bot.id)).toBe('도우미 둘째 수정');
});

test('rollback is refused while a task of the conversation is queued or running', () => {
  const f = fixture();
  const task = f.begin();
  f.scene(task, { ...f.read(f.scenes[0]!.id), text: '바뀐 장면.\n' });
  expect(helperRollbackView(f.store, f.workspace, task.id).blocked).toBe('task-active');
  expect(() => f.rollBack(task)).toThrow('HELPER_TASK_ACTIVE');
  f.finish(task);
  expect(f.rollBack(task).units).toMatchObject([{ status: 'restored' }]);
});

test('created and deleted resources and other domains are listed as not covered', () => {
  const f = fixture();
  const doomed = f.store.product.content(fixtureBotInput('지울 봇', '설명'));
  const task = f.begin();
  const created = f.resource(task, 'resource.save', {
    kind: 'content',
    model: fixtureBotInput('새 봇', '새 설명'),
  });
  f.resource(task, 'resource.delete', {
    kind: 'content',
    id: doomed.id,
    expectedRevision: doomed.revision,
  });
  f.finish(task);
  expect(
    f
      .rollBack(task)
      .units.map(({ unit, status, reason, touches }) => [unit, status, reason, touches])
  ).toEqual([
    [
      `resource:content:${created.id}`,
      'not-covered',
      'created',
      { domain: 'resource', kind: 'content', id: created.id },
    ],
    [
      `resource:content:${doomed.id}`,
      'not-covered',
      'deleted',
      { domain: 'resource', kind: 'content', id: doomed.id },
    ],
  ]);
  expect(readResource(f.store, 'content', created.id)).toMatchObject({ title: '새 봇' });
});

test('a baseline removed by deletion or retention cannot be restored', () => {
  const f = fixture();
  const [first, second] = f.scenes;
  const bot = f.store.product.content(fixtureBotInput('삭제될 봇', '설명'));
  const task = f.begin();
  f.scene(task, { ...f.read(second!.id), text: '지워질 장면.\n' });
  f.scene(task, { ...f.read(first!.id), text: '오래될 장면.\n' });
  f.resource(task, 'resource.patch', {
    kind: 'content',
    id: bot.id,
    expectedRevision: bot.revision,
    changes: [{ op: 'set', path: '/package/nativeRisu/card/description', value: '새 설명' }],
  });
  f.finish(task);
  deleteScenes(f.store, f.chat.id, second!.id, {
    ...sceneDeletionImpact(f.store, f.chat.id, second!.id).request,
    scope: 'only',
    idempotencyKey: randomUUID(),
  });
  deleteLibraryItem(f.store, 'content', bot.id, {
    expectedRevision: readResource(f.store, 'content', bot.id).revision,
  });
  const units = (result: { units: HelperRollbackUnit[] }) =>
    result.units.map(({ unit, status, reason }) => [unit, status, reason]);
  expect(units(f.rollBack(task))).toEqual([
    [`scene:${second!.id}`, 'text-removed', 'deleted'],
    [`scene:${first!.id}`, 'restored', undefined],
    [`resource:content:${bot.id}`, 'text-removed', 'deleted'],
  ]);

  const later = f.begin();
  f.scene(later, { ...f.read(first!.id), text: '나중 장면.\n' });
  f.finish(later);
  pruneHelperChanges(
    f.store.db,
    undefined,
    Date.now() + (HELPER_CHANGE_RETENTION.days + 1) * 86_400_000
  );
  expect(units(f.rollBack(later))).toEqual([[`scene:${first!.id}`, 'text-removed', 'expired']]);
  expect(f.store.source(first!.id).text).toBe('나중 장면.\n');
});

test('an image a baseline references survives cleanup, comes back with rollback and is released after expiry', () => {
  const f = fixture();
  const hash = 'c'.repeat(64);
  f.store.db
    .prepare('INSERT INTO image_blobs(hash,mime,bytes) VALUES(?,?,?)')
    .run(hash, 'image/png', Buffer.from([1]));
  const markdown = `![그림](/api/package-image-blobs/${hash})`;
  const bot = f.store.product.content(fixtureBotInput('그림 봇', markdown));
  const task = f.begin();
  let revision = bot.revision;
  for (const value of ['그림 없음', '여전히 그림 없음'])
    revision = f.resource(task, 'resource.patch', {
      kind: 'content',
      id: bot.id,
      expectedRevision: revision,
      changes: [{ op: 'set', path: '/package/nativeRisu/card/description', value }],
    }).revision;
  f.finish(task);
  pruneUnusedData(f.store.db, [hash]);
  expect(f.store.db.prepare('SELECT 1 AS kept FROM image_blobs WHERE hash=?').get(hash)).toEqual({
    kept: 1,
  });
  expect(f.rollBack(task).units).toMatchObject([{ status: 'restored' }]);
  expect(description(f.store, bot.id)).toBe(markdown);

  setDescription(f.store, bot.id, '그림을 다시 지움');
  setDescription(f.store, bot.id, '한 번 더 지움');
  pruneUnusedData(f.store.db, [hash]);
  expect(f.store.db.prepare('SELECT 1 AS kept FROM image_blobs WHERE hash=?').get(hash)).toEqual({
    kept: 1,
  });
  pruneHelperChanges(
    f.store.db,
    undefined,
    Date.now() + (HELPER_CHANGE_RETENTION.days + 1) * 86_400_000
  );
  pruneUnusedData(f.store.db, [hash]);
  expect(f.store.db.prepare('SELECT 1 FROM image_blobs WHERE hash=?').get(hash)).toBeUndefined();
});

test('an earlier task restores a note after a later task was rolled back, though the note has a new id', () => {
  const f = fixture();
  const first = f.store.story.notes.write(f.chat.id, {
    text: '처음 메모',
    author: 'Synthetic author',
    expectedRevision: 0,
    expectedHeadRevision: f.store.chat(f.chat.id).headRevision,
    idempotencyKey: 'note-seed',
  }).note;
  const edit = (task: HelperTask, replacesId: string, text: string) =>
    f.tracked(task, { domain: 'notes', chatId: f.chat.id }, () =>
      f.store.story.notes.write(f.chat.id, {
        text,
        replacesId,
        author: '사용자 도우미 요청',
        expectedRevision: f.store.story.notes.revision(f.chat.id),
        expectedHeadRevision: f.store.chat(f.chat.id).headRevision,
        idempotencyKey: randomUUID(),
      })
    ) as { note: { id: string } };
  const earlier = f.begin();
  const middle = edit(earlier, first.id, '앞 작업 메모').note;
  f.finish(earlier);
  const later = f.begin();
  edit(later, middle.id, '뒤 작업 메모');
  f.finish(later);
  expect(f.rollBack(later).units).toMatchObject([{ status: 'restored' }]);
  expect(noteShape(f.store, f.chat.id)).toEqual(['author-note\n앞 작업 메모']);
  expect(f.rollBack(earlier).units).toMatchObject([{ status: 'restored' }]);
  expect(noteShape(f.store, f.chat.id)).toEqual(['author-note\n처음 메모']);
});

test('a task that rewrote or retired an imported memory rolls back to the memory with its origin', () => {
  const f = fixture();
  const origin = { fileHash: 'a'.repeat(64), entryId: 'entry-1', title: '가져온 기억' };
  const memory = (text: string, key: string) =>
    f.store.story.notes.write(f.chat.id, {
      text,
      kind: 'imported-memory',
      origin,
      author: 'Synthetic import',
      expectedRevision: f.store.story.notes.revision(f.chat.id),
      expectedHeadRevision: f.store.chat(f.chat.id).headRevision,
      idempotencyKey: key,
    }).note;
  const rewritten = memory('다리를 건넌 기억', 'memory-rewritten');
  const retired = memory('강을 본 기억', 'memory-retired');
  const task = f.begin();
  const write = (body: Record<string, unknown>) =>
    f.tracked(task, { domain: 'notes', chatId: f.chat.id }, () =>
      f.store.story.notes.write(f.chat.id, {
        ...body,
        author: '사용자 도우미 요청',
        expectedRevision: f.store.story.notes.revision(f.chat.id),
        expectedHeadRevision: f.store.chat(f.chat.id).headRevision,
        idempotencyKey: randomUUID(),
      })
    );
  write({ text: '고쳐 쓴 기억', replacesId: rewritten.id });
  write({ retired: true, replacesId: retired.id });
  f.finish(task);
  expect(f.rollBack(task).units).toMatchObject([
    { unit: `notes:${f.chat.id}`, status: 'restored' },
  ]);
  const notes = f.store.story.notes.entries(
    f.store.story.notes.scope(f.chat.id, f.store.chat(f.chat.id).headRevision)
  );
  expect(notes.map(({ kind, text, origin: from }) => ({ kind, text, origin: from }))).toEqual(
    expect.arrayContaining([
      { kind: 'imported-memory', text: '다리를 건넌 기억', origin },
      { kind: 'imported-memory', text: '강을 본 기억', origin },
    ])
  );
  expect(notes).toHaveLength(2);
});

test('a bot change recorded with the card-only state hash still rolls back unless its settings changed', () => {
  const f = fixture();
  const module = f.store.product.content({ ...fixtureBotInput('함께 쓰는 모듈'), kind: 'module' });
  const bots = ['가', '나'].map(
    (name) => f.store.product.content(fixtureBotInput(`${name} 봇`, `${name} 처음`)) as Content
  );
  const task = f.begin();
  for (const bot of bots)
    f.resource(task, 'resource.patch', {
      kind: 'content',
      id: bot.id,
      expectedRevision: bot.revision,
      changes: [{ op: 'set', path: '/package/nativeRisu/card/description', value: '도우미 설명' }],
    });
  f.finish(task);
  for (const bot of bots)
    f.store.db
      .prepare('UPDATE helper_changes SET result=? WHERE target_id=?')
      .run(
        helperStateHash(
          authoredView(
            'content',
            editableResource('content', readResource(f.store, 'content', bot.id))
          )
        ),
        `content:${bot.id}`
      );
  const saved = readResource(f.store, 'content', bots[1]!.id);
  const model = structuredClone(editableResource('content', saved)) as any;
  model.package.modules = [{ id: module.id, revision: module.revision }];
  saveResource(f.store, {
    kind: 'content',
    id: bots[1]!.id,
    expectedRevision: saved.revision,
    model: model as ResourceModel,
  });
  expect(f.rollBack(task).units.map(({ status }) => status)).toEqual(['restored', 'changed-since']);
  expect(bots.map((bot) => description(f.store, bot.id))).toEqual(['가 처음', '도우미 설명']);
});

test('a task that changed only a bot package setting rolls back', () => {
  const f = fixture();
  const module = f.store.product.content({ ...fixtureBotInput('함께 쓰는 모듈'), kind: 'module' });
  const bot = f.store.product.content(fixtureBotInput('설정 봇', '처음 설명')) as Content;
  const task = f.begin();
  const model = structuredClone(
    editableResource('content', readResource(f.store, 'content', bot.id))
  ) as any;
  model.package.modules = [{ id: module.id, revision: module.revision }];
  f.resource(task, 'resource.save', {
    kind: 'content',
    id: bot.id,
    expectedRevision: bot.revision,
    model,
  });
  f.finish(task);
  expect(f.rollBack(task).units).toMatchObject([
    { unit: `resource:content:${bot.id}`, status: 'restored' },
  ]);
  expect((readResource(f.store, 'content', bot.id) as Content).package.modules).toBeUndefined();
});

test('an outline rollback cancels only the scheduled scenes whose plan it changes', () => {
  const f = fixture();
  const created = f.store.outline.applyReceipt(
    f.chat.id,
    {
      idempotencyKey: 'outline-seed',
      operations: [
        { op: 'create', ref: 'a', level: 'arc', title: '1부', intent: '떠난다' },
        { op: 'create', ref: 'b', parentRef: 'a', level: 'episode', title: '1화', intent: '출발' },
        { op: 'create', ref: 'c', level: 'arc', title: '2부', intent: '돌아온다' },
        { op: 'create', ref: 'd', parentRef: 'c', level: 'episode', title: '2화', intent: '귀향' },
        { op: 'create', ref: 'e', parentRef: 'c', level: 'episode', title: '3화', intent: '재회' },
      ],
    },
    'user'
  ).created;
  const id = (ref: string) => created.find((item) => item.ref === ref)!.id;
  const node = (ref: string) =>
    f.store.outline.nodes(f.chat.id).find((item) => item.id === id(ref))!;
  f.store.outline.applyReceipt(
    f.chat.id,
    {
      idempotencyKey: 'outline-related',
      operations: [
        { op: 'update', id: id('b'), expectedRevision: node('b').revision, relatedIds: [id('d')] },
      ],
    },
    'user'
  );
  const task = f.begin();
  f.tracked(task, { domain: 'outline', chatId: f.chat.id }, () =>
    f.store.outline.applyReceipt(
      f.chat.id,
      {
        idempotencyKey: 'outline-move',
        operations: [
          {
            op: 'move',
            id: id('d'),
            expectedRevision: node('d').revision,
            parentId: id('a'),
            position: 1,
          },
        ],
      },
      'user'
    )
  );
  f.finish(task);
  const scheduled = Object.fromEntries(
    ['b', 'd', 'e'].map((ref) => [
      ref,
      f.store.outline.sceneCommand(id(ref), { idempotencyKey: randomUUID() }).id,
    ])
  );
  expect(f.rollBack(task).units).toMatchObject([{ status: 'restored' }]);
  expect(node('d').parentId).toBe(id('c'));
  expect(
    Object.fromEntries(
      Object.entries(scheduled).map(([ref, command]) => [
        ref,
        f.store.story.command(command).status,
      ])
    )
  ).toEqual({ b: 'pending', d: 'cancelled', e: 'pending' });
});

test('chat-only lore edits and removals roll back to the override the chat had before the task', () => {
  const f = fixture();
  const model = fixtureBotInput('로어 봇', '설명');
  model.package = nativeContent({
    name: '로어 봇',
    description: '설명',
    character_book: {
      entries: [
        { keys: ['마을'], comment: '마을', content: '조용한 마을', constant: true },
        { keys: ['숲'], comment: '숲', content: '깊은 숲', constant: true },
      ],
    },
  });
  const bot = f.store.product.content(model) as Content;
  const chat = createFixtureChat(f.store, '로어 채팅', { botId: bot.id });
  const service = new ChatOverridesStore(f.store);
  const selector = (loreId: string) => ({
    id: bot.id,
    role: 'bot',
    modulePath: [],
    loreId,
    field: 'text',
  });
  const guards = () => {
    const state = service.get(chat.id);
    return {
      expectedRevision: state.revision,
      expectedHeadRevision: state.headRevision,
      operationId: randomUUID(),
    };
  };
  const patch = (requestId: string, loreId: string, value: string) => {
    const state = service.get(chat.id);
    const lore = state.attachments[0]!.lore.find((entry) => entry.id === loreId)!;
    return {
      ...guards(),
      selector: selector(loreId),
      value,
      expectedProfileRevision: state.profileRevision,
      expectedPackageRevision: state.attachments[0]!.packageRevision,
      expectedFieldHash: chatOverrideHash(lore.text),
      requestId,
    };
  };
  const write = (task: HelperTask | null, action: 'patch' | 'remove', body: any) => {
    const { requestId, ...input } = body;
    const run = () => {
      const prior = service.current(chat.id, input.selector);
      const saved = service[action](chat.id, input, requestId);
      if (task) recordHelperChatLoreChange(f.store, task, chat.id, prior, saved.entry);
      return saved;
    };
    return task
      ? f.workspace.operation(task.id, `${task.id}:${input.operationId}`, { input }, run)
      : run();
  };
  const [village, forest] = service.get(chat.id).attachments[0]!.lore.map((entry) => entry.id);
  write(null, 'patch', patch('user', village!, '사용자가 바꾼 마을'));
  const task = f.begin();
  write(task, 'remove', { ...guards(), selector: selector(village!), requestId: task.id });
  write(task, 'patch', patch(task.id, forest!, '도우미가 바꾼 숲'));
  f.finish(task);
  const overrides = () =>
    Object.fromEntries(
      service.get(chat.id).overrides.map((entry) => [entry.selector.loreId, entry.value])
    );
  expect(overrides()).toEqual({ [forest!]: '도우미가 바꾼 숲' });
  expect(
    helperRollbackView(f.store, f.workspace, task.id).units.map(({ domain, status, touches }) => [
      domain,
      status,
      touches,
    ])
  ).toEqual([
    ['chat-lore', 'restorable', null],
    ['chat-lore', 'restorable', null],
  ]);
  expect(f.rollBack(task).units.map((unit) => unit.status)).toEqual(['restored', 'restored']);
  expect(overrides()).toEqual({ [village!]: '사용자가 바꾼 마을' });
  expect(f.rollBack(task).units.map((unit) => unit.status)).toEqual(['restored', 'restored']);
  expect(overrides()).toEqual({ [village!]: '사용자가 바꾼 마을' });

  const later = f.begin();
  write(later, 'remove', { ...guards(), selector: selector(village!), requestId: later.id });
  f.finish(later);
  write(null, 'patch', patch('user', village!, '다시 바꾼 마을'));
  expect(f.rollBack(later).units).toMatchObject([
    { domain: 'chat-lore', status: 'changed-since', reason: 'changed-after-task' },
  ]);
  expect(overrides()).toEqual({ [village!]: '다시 바꾼 마을' });
});

test('rolling back one target leaves the other targets of the task as they are', () => {
  const f = fixture();
  const [first, second] = f.scenes;
  const task = f.begin();
  f.scene(task, { ...f.read(first!.id), text: '한 곳.\n' });
  f.scene(task, { ...f.read(second!.id), text: '다른 곳.\n' });
  f.finish(task);
  expect(f.rollBack(task, `scene:${second!.id}`).units).toMatchObject([
    { unit: `scene:${second!.id}`, status: 'restored' },
  ]);
  expect(f.store.source(first!.id).text).toBe('한 곳.\n');
  expect(f.store.source(second!.id).text).toBe('둘째 장면이에요.\n그녀가 말했다.\n');
  expect(() => f.rollBack(task, 'scene:missing')).toThrow('HELPER_ROLLBACK_UNIT_NOT_FOUND');
});

type Target = string;
type World = {
  f: Fixture;
  bots: string[];
  state: (target: Target) => string;
  targets: () => Target[];
};

function world(): World {
  const f = fixture();
  completedSource(f.store, f.chat.id, '메모가 붙는 장면이에요.\n');
  const bots = ['하나', '둘', '셋'].map(
    (name) => f.store.product.content(fixtureBotInput(`${name} 봇`, `${name} 설명`)).id
  );
  f.store.outline.applyReceipt(
    f.chat.id,
    {
      operations: [
        { op: 'create', level: 'arc', title: '1부', intent: '떠난다' },
        { op: 'create', level: 'arc', title: '2부', intent: '돌아온다' },
      ],
      idempotencyKey: 'outline-seed',
    },
    'user'
  );
  f.store.story.notes.write(f.chat.id, {
    text: '첫 메모',
    author: 'Synthetic author',
    expectedRevision: 0,
    expectedHeadRevision: f.store.chat(f.chat.id).headRevision,
    idempotencyKey: 'note-seed',
  });
  const state = (target: Target) => {
    const [kind, id] = target.split(':') as [string, string];
    if (kind === 'res') return helperResourceHash('content', readResource(f.store, 'content', id));
    if (kind === 'scene') return JSON.stringify([f.store.source(id).text, f.translation(id)]);
    if (kind === 'outline') return JSON.stringify(outlineShape(f.store, f.chat.id));
    return JSON.stringify(noteShape(f.store, f.chat.id));
  };
  const targets = () => [
    ...bots.map((id) => `res:${id}`),
    ...f.scenes.map((scene) => `scene:${scene.id}`),
    'outline:',
    'notes:',
  ];
  return { f, bots, state, targets };
}

function generator(seed: number) {
  let value = seed | 0;
  const random = () => {
    value = (value + 0x6d2b79f5) | 0;
    let mixed = Math.imul(value ^ (value >>> 15), 1 | value);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
  return { random, pick };
}

function runSeed(seed: number) {
  const { random, pick } = generator(seed);
  const w = world();
  const { f } = w;
  let counter = 0;
  const fresh = (label: string) => `${label} ${seed}-${counter++}`;
  type Touch = { start: string; left: string; interrupted: boolean };
  const touches = new Map<string, Map<Target, Touch>>();
  const beforeTasks = new Map<Target, string>();
  const userAfterTasks = new Set<Target>();
  const note = (writer: string, targets: Target[], write: () => void) => {
    const before = new Map(targets.map((target) => [target, w.state(target)]));
    write();
    for (const target of targets) {
      if (writer === 'user') {
        if (beforeTasks.has(target) && w.state(target) !== before.get(target))
          userAfterTasks.add(target);
        continue;
      }
      if (!beforeTasks.has(target)) beforeTasks.set(target, before.get(target)!);
      const touched = touches.get(writer) ?? new Map<Target, Touch>();
      const touch = touched.get(target);
      if (touch) {
        touch.interrupted ||= touch.left !== before.get(target);
        touch.left = w.state(target);
      } else
        touched.set(target, {
          start: before.get(target)!,
          left: w.state(target),
          interrupted: false,
        });
      const net = touched.get(target)!;
      if (!target.startsWith('scene:') && net.left === net.start) touched.delete(target);
      touches.set(writer, touched);
    }
  };
  const visibleNotes = () =>
    captureHelperTarget(f.store, { domain: 'notes', chatId: f.chat.id }).value as {
      id: string;
    }[];
  const noteBody = () => ({
    author: 'Synthetic author',
    expectedRevision: f.store.story.notes.revision(f.chat.id),
    expectedHeadRevision: f.store.chat(f.chat.id).headRevision,
    idempotencyKey: randomUUID(),
  });
  const outlineOperation = (): Record<string, unknown> => {
    const nodes = f.store.outline.nodes(f.chat.id);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const levelOf = (id: string | null) => (id === null ? null : byId.get(id)!.level);
    const within = (id: string, ancestor: string): boolean =>
      id === ancestor ||
      (byId.get(id)!.parentId !== null && within(byId.get(id)!.parentId!, ancestor));
    const fits = (parentId: string | null, level: OutlineLevel, id?: string) =>
      outlineParentAllowed(levelOf(parentId), level) &&
      nodes.every((child) => child.parentId !== id || outlineParentAllowed(level, child.level));
    const choice = random();
    const node = nodes.length ? pick(nodes) : undefined;
    const guard = node && { id: node.id, expectedRevision: node.revision };
    if (node && choice < 0.25)
      return { op: 'update', ...guard, [random() < 0.5 ? 'title' : 'intent']: fresh('구성') };
    if (node && choice < 0.4) {
      const levels = OUTLINE_LEVELS.filter(
        (level) => level !== node.level && fits(node.parentId, level, node.id)
      );
      if (levels.length) return { op: 'update', ...guard, level: pick(levels) };
    }
    if (node && choice < 0.55) {
      const parents = [null, ...nodes.map((item) => item.id)].filter(
        (id) => (id === null || !within(id, node.id)) && fits(id, node.level)
      );
      return {
        op: 'move',
        ...guard,
        parentId: pick(parents),
        position: Math.floor(random() * 4),
      };
    }
    if (node && choice < 0.65)
      return {
        op: 'update',
        ...guard,
        relatedIds: nodes
          .filter((item) => item.id !== node.id && random() < 0.4)
          .map((item) => item.id),
      };
    if (choice < 0.85 || nodes.length < 2) {
      const level = pick(OUTLINE_LEVELS);
      const parents = [null, ...nodes.map((item) => item.id)].filter((id) => fits(id, level));
      const parentId = pick(parents);
      return {
        op: 'create',
        ...(parentId === null ? {} : { parentId }),
        level,
        title: fresh('새 구성'),
        intent: fresh('의도'),
      };
    }
    const root = pick(nodes.filter((item) => item.parentId === null));
    return { op: 'remove', id: root.id, expectedRevision: root.revision };
  };
  const noteOperation = (): Record<string, unknown> => {
    const notes = visibleNotes();
    const choice = random();
    if (choice < 0.5 && notes.length) return { text: fresh('메모'), replacesId: pick(notes).id };
    if (choice < 0.75 && notes.length) return { retired: true, replacesId: pick(notes).id };
    return { text: fresh('새 메모') };
  };
  const descriptionPatch = (id: string) => ({
    kind: 'content',
    id,
    expectedRevision: readResource(f.store, 'content', id).revision,
    changes: [
      { op: 'set', path: '/package/nativeRisu/card/description', value: fresh('도우미 설명') },
    ],
  });

  const userEdit = () => {
    const target = pick(w.targets());
    const [kind, id] = target.split(':') as [string, string];
    note('user', [target], () => {
      if (kind === 'res') setDescription(f.store, id, fresh('사용자 설명'));
      else if (kind === 'scene') {
        if (random() < 0.5)
          f.store.editSource(id, {
            text: fresh('사용자 원문'),
            expectedRevision: f.store.source(id).editRevision ?? 0,
          });
        else f.translate(id, fresh('User translation'));
      } else if (kind === 'outline')
        f.store.outline.applyReceipt(
          f.chat.id,
          { operations: [outlineOperation()], idempotencyKey: randomUUID() },
          'user'
        );
      else f.store.story.notes.write(f.chat.id, { ...noteOperation(), ...noteBody() });
    });
  };
  const helperEdit = (task: HelperTask) => {
    const target = pick(w.targets());
    const [kind, id] = target.split(':') as [string, string];
    if (kind === 'res' && random() < 0.4) {
      const bots = w.bots.filter(() => random() < 0.7);
      if (bots.length < 2) bots.splice(0, bots.length, ...w.bots);
      note(
        task.id,
        bots.map((bot) => `res:${bot}`),
        () => f.resource(task, 'resource.patchMany', { items: bots.map(descriptionPatch) })
      );
      return;
    }
    note(task.id, [target], () => {
      if (kind === 'res') f.resource(task, 'resource.patch', descriptionPatch(id));
      else if (kind === 'scene') {
        const shown = f.translation(id);
        const choice = random();
        if (choice < 0.4 || shown === null)
          f.scene(task, { ...f.read(id), text: fresh('도우미 원문') });
        else if (choice < 0.7)
          f.scene(task, { ...f.read(id, 'translation'), text: fresh('Helper translation') });
        else
          f.scene(task, {
            ...f.read(id),
            text: fresh('도우미 원문'),
            translation: { ...f.read(id, 'translation'), text: fresh('Helper co-edit') },
          });
      } else if (kind === 'outline')
        f.tracked(task, { domain: 'outline', chatId: f.chat.id }, () =>
          f.store.outline.applyReceipt(
            f.chat.id,
            { operations: [outlineOperation()], idempotencyKey: randomUUID() },
            'user'
          )
        );
      else
        f.tracked(task, { domain: 'notes', chatId: f.chat.id }, () =>
          f.store.story.notes.write(f.chat.id, {
            ...noteOperation(),
            ...noteBody(),
            author: '사용자 도우미 요청',
          })
        );
    });
  };

  const tasks: HelperTask[] = [];
  for (let round = 2 + Math.floor(random() * 3); round > 0; round--) {
    if (random() < 0.5) userEdit();
    const task = f.begin();
    tasks.push(task);
    for (let steps = 1 + Math.floor(random() * 4); steps > 0; steps--)
      if (random() < 0.2) userEdit();
      else helperEdit(task);
    f.finish(task);
  }
  for (let edits = Math.floor(random() * 3); edits > 0; edits--) userEdit();

  const unitTarget = (unit: string) =>
    unit.startsWith('resource:content:')
      ? `res:${unit.slice('resource:content:'.length)}`
      : unit.startsWith('scene:')
        ? unit
        : `${unit.slice(0, unit.indexOf(':'))}:`;
  const version = (target: Target) => {
    const [kind, id] = target.split(':') as [string, string];
    if (kind === 'res') return String(readResource(f.store, 'content', id).revision);
    if (kind === 'scene')
      return `${f.store.source(id).editRevision}:${latestTranslation(f.store, id)?.id}`;
    if (kind === 'outline')
      return JSON.stringify(f.store.outline.nodes(f.chat.id).map((node) => node.revision));
    return String(f.store.story.notes.revision(f.chat.id));
  };
  const rolledBack = new Set<string>();
  const act = (task: HelperTask, unit?: string) => {
    const label = `seed ${seed}: task ${tasks.indexOf(task)}${unit ? ` ${unit}` : ''}`;
    const touched = touches.get(task.id) ?? new Map<Target, Touch>();
    const selected = unit ? [unitTarget(unit)] : [...touched.keys()];
    const states = new Map(w.targets().map((target) => [target, w.state(target)]));
    const versions = new Map(w.targets().map((target) => [target, version(target)]));
    const expected = new Map<Target, { status: string; state: string }>();
    for (const target of selected) {
      const touch = touched.get(target)!;
      const key = `${task.id}|${target}`;
      if (rolledBack.has(key))
        expected.set(target, { status: 'restored', state: states.get(target)! });
      else if (!touch.interrupted && states.get(target) === touch.left) {
        expected.set(target, { status: 'restored', state: touch.start });
        rolledBack.add(key);
      } else expected.set(target, { status: 'changed-since', state: states.get(target)! });
    }
    const result = f.rollBack(task, unit);
    for (const item of result.units)
      expect(item.status, `${label}: ${item.unit}`).toBe(
        expected.get(unitTarget(item.unit))?.status
      );
    for (const target of w.targets()) {
      const wanted = expected.get(target);
      expect(w.state(target), `${label}: ${target}`).toBe(wanted?.state ?? states.get(target));
      if (!wanted || wanted.state === states.get(target))
        expect(version(target), `${label}: ${target} written`).toBe(versions.get(target));
    }
    const settled = new Map(w.targets().map((target) => [target, version(target)]));
    const again = f.rollBack(task, unit);
    expect(
      again.units.map((item) => [item.unit, item.status]),
      `${label}: repeated`
    ).toEqual(result.units.map((item) => [item.unit, item.status]));
    for (const target of w.targets())
      expect(version(target), `${label}: ${target} after repeat`).toBe(settled.get(target));
  };

  if (random() < 0.4) {
    for (const task of [...tasks].reverse()) act(task);
    for (const [target, state] of beforeTasks)
      if (!userAfterTasks.has(target))
        expect(w.state(target), `seed ${seed}: ${target} after reverse pass`).toBe(state);
  } else
    for (let steps = 2 + Math.floor(random() * 5); steps > 0; steps--) {
      const task = pick(tasks);
      const units = helperRollbackView(f.store, f.workspace, task.id).units.filter((item) =>
        w.targets().includes(unitTarget(item.unit))
      );
      act(task, units.length && random() < 0.5 ? pick(units).unit : undefined);
    }
  for (const { dir, store } of owned.splice(0)) {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const SEEDS = Number(process.env.UIMORI_ROLLBACK_SEEDS ?? 80);
test(
  'rolling back several tasks and single units in random order after random helper and user edits keeps every invariant',
  () => {
    const start = Number(process.env.UIMORI_ROLLBACK_SEED ?? 1);
    for (let seed = start; seed < start + SEEDS; seed++) {
      try {
        runSeed(seed);
      } catch (error) {
        throw new Error(`rollback property failed for seed ${seed}`, { cause: error });
      }
    }
  },
  Math.max(60_000, SEEDS * 1000)
);

test('the rollback routes preview and restore a task that ran through the app', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-helper-rollback-'));
  const app = await createApp({
    dbPath: join(directory, 'app.sqlite'),
    buildId: 'helper-rollback',
    testMode: true,
  });
  try {
    selectFixtureModels(app.store);
    const chat = createFixtureChat(app.store, '경로 채팅');
    const source = completedSource(app.store, chat.id, '처음 원문이에요.\n');
    let round = 0;
    vi.spyOn(transport, 'executeProvider').mockImplementation(async (_target, request, options) => {
      options.beforeTurn?.();
      const step = round++;
      if (step === 0)
        return helperCall('read', 'scene.read', { sourceId: source.id, target: 'original' });
      if (step === 1) {
        const read = (request.input.results as unknown as { callId: string; result: any }[]).find(
          (item) => item.callId === 'read'
        )!.result;
        return helperCall('patch', 'scene.patch', {
          ...read.editTarget,
          text: '고친 원문이에요.\n',
        });
      }
      return structuredClone(helperDone);
    });
    const conversation = (
      await app.inject({
        method: 'POST',
        url: '/api/helper/conversations',
        payload: { scope: { kind: 'chat', chatId: chat.id } },
      })
    ).json<{ id: string }>();
    const task = (
      await app.inject({
        method: 'POST',
        url: `/api/helper/conversations/${conversation.id}/messages`,
        payload: { requestKey: randomUUID(), text: '원문을 고쳐 줘' },
      })
    ).json<HelperTask>();
    const workspace = new HelperWorkspace(app.store);
    await vi.waitFor(() => expect(workspace.task(task.id).status).toBe('completed'));
    expect(app.store.source(source.id).text).toBe('고친 원문이에요.\n');
    const preview = await app.inject({
      method: 'GET',
      url: `/api/helper/tasks/${task.id}/rollback`,
    });
    expect(preview.json()).toMatchObject({
      blocked: null,
      units: [{ unit: `scene:${source.id}`, status: 'restorable' }],
    });
    const restored = await app.inject({
      method: 'POST',
      url: `/api/helper/tasks/${task.id}/rollback`,
      payload: { unit: `scene:${source.id}` },
    });
    expect(restored.json()).toMatchObject({ units: [{ status: 'restored' }] });
    expect(app.store.source(source.id).text).toBe('처음 원문이에요.\n');
  } finally {
    vi.restoreAllMocks();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function helperRuns(store: Store, chatId: string) {
  const http = selectFixtureModels(store);
  const codexConnection = store.product.connection({
    title: 'Synthetic Codex',
    protocol: 'codex-app-server-v1',
    endpoint: 'codex://local',
    enabled: true,
  });
  const codex = store.product.model({
    title: 'Synthetic Codex',
    connectionId: codexConnection.id,
    modelId: 'synthetic-codex',
    maxOutputTokens: 1024,
    temperature: null,
  });
  const sources: { protocol: string; source: Record<string, unknown> }[] = [];
  let failNext = false;
  const outcome = (): transport.ProviderResult => {
    if (!failNext) return structuredClone(helperDone);
    failNext = false;
    return {
      ...structuredClone(helperDone),
      status: 'error',
      text: '',
      error: { code: 'SYNTHETIC' },
    };
  };
  const wire = (protocol: transport.WireRecord['protocol']): transport.WireRecord => ({
    connectionId: 'synthetic',
    protocol,
    role: 'helper',
    modelId: 'synthetic',
    method: 'POST',
    url: 'http://127.0.0.1:9',
    headers: {},
    body: {},
    bodySha256: 'synthetic',
    stablePrefixSha256: 'synthetic',
  });
  vi.spyOn(transport, 'executeProvider').mockImplementation(async (target, request, options) => {
    options.beforeTurn?.();
    await options.onWire?.(wire(target.protocol));
    sources.push({
      protocol: target.protocol,
      source: request.input.source as Record<string, unknown>,
    });
    return outcome();
  });
  const work: Promise<void>[] = [];
  const runtime = new HelperRuntime(store, {
    owner: 'rollback-feedback',
    signal: new AbortController().signal,
    track: (promise) => work.push(promise),
    streams: new ResponseStreamStore(store),
    executeCodexAgent: async (connection, request, options) => {
      await options.beforeTurn?.();
      await options.onWire?.(wire(connection.protocol));
      sources.push({ protocol: connection.protocol, source: JSON.parse(request.text).source });
      return outcome();
    },
  });
  const conversation = runtime.workspace.open({ kind: 'chat', chatId });
  const use = (model: { id: string }) => {
    const selected = modelWorkspace(store);
    updateModelWorkspace(store, {
      expectedRevision: selected.revision,
      routes: selected.routes,
      translationPolicy: selected.translationPolicy,
      helperModel: { id: model.id },
    });
  };
  const run = async (request: string, options: { retryOf?: string; fail?: boolean } = {}) => {
    failNext = !!options.fail;
    const task = runtime.enqueue(
      conversation.id,
      randomUUID(),
      request,
      undefined,
      undefined,
      options.retryOf
    );
    await Promise.all(work);
    return runtime.workspace.task(task.id);
  };
  return { http, codex, sources, use, run, conversation };
}

test('the next task is told once what was rolled back, and a retry on Codex keeps the same list', async () => {
  const f = fixture();
  const [first] = f.scenes;
  const bot = f.store.product.content(fixtureBotInput('되돌릴 봇', '처음 설명'));
  const task = f.begin();
  f.scene(task, { ...f.read(first!.id), text: '도우미가 고친 장면.\n' });
  f.resource(task, 'resource.patch', {
    kind: 'content',
    id: bot.id,
    expectedRevision: bot.revision,
    changes: [{ op: 'set', path: '/package/nativeRisu/card/description', value: '도우미 설명' }],
  });
  f.finish(task);
  const kept = f.begin();
  f.scene(kept, { ...f.read(f.scenes[1]!.id), text: '남겨 둘 장면.\n' });
  f.finish(kept);
  expect(f.rollBack(task).units.map((unit) => unit.status)).toEqual(['restored', 'restored']);

  const h = helperRuns(f.store, f.chat.id);
  const failed = await h.run('다음 요청', { fail: true });
  expect(failed.status).toBe('failed');
  const expected = [
    {
      taskId: task.id,
      request: 'Edit',
      domain: 'scene',
      targetId: first!.id,
      title: expect.any(String),
    },
    {
      taskId: task.id,
      request: 'Edit',
      domain: 'resource',
      kind: 'content',
      targetId: bot.id,
      title: '되돌릴 봇',
    },
  ];
  expect(failed.snapshot.revertedChanges).toEqual({ changes: expected, omitted: 0 });
  const httpSource = h.sources.at(-1)!;
  expect(httpSource.protocol).toBe('fixture-sse-v1');
  expect(httpSource.source.revertedChanges).toEqual(failed.snapshot.revertedChanges!.changes);
  expect(httpSource.source).not.toHaveProperty('revertedChangesOmitted');

  h.use(h.codex);
  const retried = await h.run('다음 요청', { retryOf: failed.id });
  expect(retried.status).toBe('completed');
  expect(retried.snapshot.revertedChanges).toEqual(failed.snapshot.revertedChanges);
  const codexSource = h.sources.at(-1)!;
  expect(codexSource.protocol).toBe('codex-app-server-v1');
  expect(codexSource.source.revertedChanges).toEqual(httpSource.source.revertedChanges);

  h.use(h.http);
  const later = await h.run('그다음 요청');
  expect(later.snapshot.revertedChanges).toBeUndefined();
  expect(h.sources.at(-1)!.source).not.toHaveProperty('revertedChanges');
});
