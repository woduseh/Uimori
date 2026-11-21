import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { HelperRollbackUnit, HelperTask } from '../core/helper.js';
import type { Content } from '../core/product.js';
import { editableResource, type ResourceModel } from '../core/resource-editing.js';
import * as transport from '../core/transport.js';
import { createApp } from '../server/app.js';
import {
  HELPER_CHANGE_RETENTION,
  captureHelperTarget,
  helperResourceHash,
  pruneHelperChanges,
  withHelperChange,
} from '../server/helper-changes.js';
import { applyHelperResourceMutation } from '../server/helper-resource-undo.js';
import { helperResourceOperation } from '../server/helper-resource-tools.js';
import { helperRollbackView, rollBackHelperTask } from '../server/helper-rollback.js';
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
  const note = (writer: string, target: Target, write: () => void) => {
    const before = w.state(target);
    write();
    if (writer === 'user') return;
    const touched = touches.get(writer) ?? new Map<Target, Touch>();
    const touch = touched.get(target);
    if (touch) {
      touch.interrupted ||= touch.left !== before;
      touch.left = w.state(target);
    } else touched.set(target, { start: before, left: w.state(target), interrupted: false });
    touches.set(writer, touched);
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
  const outlineOperation = () => {
    const nodes = f.store.outline.nodes(f.chat.id);
    const choice = random();
    if (choice < 0.4 && nodes.length)
      return (() => {
        const node = pick(nodes);
        return {
          op: 'update',
          id: node.id,
          expectedRevision: node.revision,
          [random() < 0.5 ? 'title' : 'intent']: fresh('구성'),
        };
      })();
    if (choice < 0.7 || nodes.length < 2)
      return { op: 'create', level: 'arc', title: fresh('새 구성'), intent: fresh('의도') };
    const node = pick(nodes.filter((item) => item.parentId === null));
    return { op: 'remove', id: node.id, expectedRevision: node.revision };
  };
  const noteOperation = (): Record<string, unknown> => {
    const notes = visibleNotes();
    const choice = random();
    if (choice < 0.5 && notes.length) return { text: fresh('메모'), replacesId: pick(notes).id };
    if (choice < 0.75 && notes.length) return { retired: true, replacesId: pick(notes).id };
    return { text: fresh('새 메모') };
  };

  const userEdit = () => {
    const target = pick(w.targets());
    const [kind, id] = target.split(':') as [string, string];
    note('user', target, () => {
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
    note(task.id, target, () => {
      if (kind === 'res')
        f.resource(task, 'resource.patch', {
          kind: 'content',
          id,
          expectedRevision: readResource(f.store, 'content', id).revision,
          changes: [
            {
              op: 'set',
              path: '/package/nativeRisu/card/description',
              value: fresh('도우미 설명'),
            },
          ],
        });
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
  for (let round = 1 + Math.floor(random() * 3); round > 0; round--) {
    for (let edits = Math.floor(random() * 2); edits > 0; edits--) userEdit();
    const task = f.begin();
    tasks.push(task);
    for (let steps = 1 + Math.floor(random() * 4); steps > 0; steps--)
      if (random() < 0.25) userEdit();
      else helperEdit(task);
    f.finish(task);
  }
  for (let edits = Math.floor(random() * 3); edits > 0; edits--) userEdit();

  const chosen = pick(tasks);
  const before = new Map(w.targets().map((target) => [target, w.state(target)]));
  const touched = touches.get(chosen.id) ?? new Map<Target, Touch>();
  const changedByOthers = (target: Target) => {
    const touch = touched.get(target);
    return !!touch && (touch.interrupted || before.get(target) !== touch.left);
  };
  const unitTarget = (unit: HelperRollbackUnit) =>
    unit.unit.startsWith('resource:content:')
      ? `res:${unit.unit.slice('resource:content:'.length)}`
      : unit.unit.startsWith('scene:')
        ? unit.unit
        : `${unit.domain}:`;

  const once = f.rollBack(chosen);
  const statuses = once.units.map((unit) => [unit.unit, unit.status]);
  for (const unit of once.units) {
    const target = unitTarget(unit);
    expect(unit.status, `seed ${seed}: ${unit.unit}`).toBe(
      changedByOthers(target) ? 'changed-since' : 'restored'
    );
  }
  for (const target of w.targets()) {
    const expected =
      touched.has(target) && !changedByOthers(target)
        ? touched.get(target)!.start
        : before.get(target);
    expect(w.state(target), `seed ${seed}: ${target}`).toBe(expected);
  }
  const after = new Map(w.targets().map((target) => [target, w.state(target)]));
  const twice = f.rollBack(chosen);
  expect(
    twice.units.map((unit) => [unit.unit, unit.status]),
    `seed ${seed}: second rollback`
  ).toEqual(statuses);
  for (const target of w.targets())
    expect(w.state(target), `seed ${seed}: ${target} after second rollback`).toBe(
      after.get(target)
    );
  for (const { dir, store } of owned.splice(0)) {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const SEEDS = Number(process.env.UIMORI_ROLLBACK_SEEDS ?? 80);
test(
  'rollback after random helper and user edits restores untouched targets, keeps edited ones and is idempotent',
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
