import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { HelperChange, HelperTask } from '../core/helper.js';
import type { Content } from '../core/product.js';
import { applyTextDiff } from '../core/text-diff.js';
import { chatOverrideHash } from '../core/chat-overrides.js';
import { ChatOverridesStore } from '../server/chat-overrides.js';
import { nativeContent } from './fixtures/native-content.js';
import { deleteChat } from '../server/chat-deletion.js';
import { applyHelperChatState } from '../server/helper-chat-state-tools.js';
import {
  HELPER_CHANGE_RETENTION,
  forgetHelperResourceChanges,
  pruneHelperChanges,
  recordHelperChatLoreChange,
  withHelperChange,
} from '../server/helper-changes.js';
import { pruneThemeAssets } from '../server/theme-assets.js';
import { applyHelperResourceMutation } from '../server/helper-resource-undo.js';
import { helperResourceOperation } from '../server/helper-resource-tools.js';
import { invokeHelperSceneTool } from '../server/helper-scene-tools.js';
import { readHelperTaskResults } from '../server/helper-task-results.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { deleteLibraryItem } from '../server/library-deletion.js';
import { deleteScenes, sceneDeletionImpact } from '../server/scene-deletion.js';
import { Store } from '../server/store.js';
import { pruneUnusedData } from '../server/unused-data.js';
import { createFixtureChat, fixtureBotInput } from './fixtures/chat.js';
import { completedSource } from './fixtures/illustration.js';

const owned: { dir: string; store: Store }[] = [];
afterEach(() => {
  for (const { dir, store } of owned.splice(0)) {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-helper-changes-'));
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
    modelId: 'fixture-changes',
    temperature: null,
    maxOutputTokens: 1024,
  });
  const chat = createFixtureChat(store, '변경 기록 채팅');
  const first = completedSource(store, chat.id, '첫 장면이에요.\n그는 다리를 건넜다.\n');
  const second = completedSource(store, chat.id, '둘째 장면이에요.\n“가자,” 그녀가 말했다.\n');
  const conversation = workspace.open({ kind: 'chat', chatId: chat.id });
  const begin = (key = randomUUID()) => {
    const task = workspace.enqueue(conversation.id, key, 'Edit', {
      scope: conversation.scope,
      model: store.product.modelSnapshot(model.id),
      history: [],
      persona: '',
      limits: { helperCalls: 12, totalCalls: 24 },
    });
    workspace.start(task.id, 'changes-fixture');
    return workspace.task(task.id);
  };
  const resource = (
    task: HelperTask,
    name: string,
    args: Record<string, unknown>,
    callId: string = randomUUID()
  ) => {
    const operation = helperResourceOperation(name, args);
    if (!operation || operation.readOnly) throw new Error(`not a resource mutation: ${name}`);
    const receiptId = `${task.id}:${callId}`;
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
  const scene = (
    task: HelperTask,
    name: string,
    args: Record<string, unknown>,
    callId: string = randomUUID()
  ) =>
    workspace.operation(task.id, `${task.id}:${callId}`, { name, args, chatId: chat.id }, () =>
      invokeHelperSceneTool(store, chat.id, name, args, task)
    ) as Record<string, any>;
  const read = (sourceId: string, target = 'original') =>
    (({ chatId: _chatId, ...guards }) => guards)(
      (invokeHelperSceneTool(store, chat.id, 'scene.read', { sourceId, target }) as any).editTarget
    );
  const changes = (task: HelperTask) => readHelperTaskResults(store, task.id).changes;
  const rows = () =>
    store.db
      .prepare('SELECT baseline,entries,text_removed FROM helper_changes')
      .all()
      .map((row) => `${row.baseline ?? ''}${row.entries}`)
      .join('\n');
  return {
    store,
    workspace,
    chat,
    first,
    second,
    conversation,
    begin,
    resource,
    scene,
    read,
    changes,
    rows,
  };
}

const hunksOf = (change: HelperChange) => {
  if (!change.diff || 'omitted' in change.diff) throw new Error('diff expected');
  return change.diff;
};

test('several edits of one scene and one resource in a task leave one net change each', () => {
  const f = fixture();
  const bot = f.store.product.content(fixtureBotInput('기록 봇', '처음 설명이에요.'));
  const task = f.begin();
  f.scene(task, 'scene.patch', {
    ...f.read(f.first.id),
    changes: [{ oldText: '다리를', newText: '강을' }],
  });
  f.scene(task, 'scene.patch', {
    ...f.read(f.first.id),
    changes: [{ oldText: '건넜다', newText: '헤엄쳤다' }],
  });
  const path = '/package/nativeRisu/card/description';
  let revision = bot.revision;
  for (const [oldText, newText] of [
    ['처음', '고친'],
    ['고친', '다시 고친'],
  ])
    revision = f.resource(task, 'resource.patch', {
      kind: 'content',
      id: bot.id,
      expectedRevision: revision,
      changes: [{ op: 'replaceText', path, oldText, newText }],
    }).revision;

  const changes = f.changes(task);
  expect(changes.map((change) => [change.domain, change.location, change.action])).toEqual([
    ['scene', '장면 1 · 원문', 'update'],
    ['resource', 'description', 'update'],
  ]);
  const sceneDiff = hunksOf(changes[0]!);
  expect(sceneDiff).toMatchObject({ mode: 'prose', added: 2, removed: 2 });
  expect(applyTextDiff(f.first.text, sceneDiff.hunks)).toBe(f.store.source(f.first.id).text);
  expect(changes[0]!.anchor).toEqual({
    domain: 'scene',
    chatId: f.chat.id,
    sourceId: f.first.id,
    field: 'original',
    paragraph: 1,
  });
  expect(changes[1]).toMatchObject({
    title: '기록 봇',
    targetId: bot.id,
    anchor: { domain: 'resource', kind: 'content', id: bot.id, path, section: 'field' },
  });
  expect(applyTextDiff('처음 설명이에요.', hunksOf(changes[1]!).hunks)).toBe(
    '다시 고친 설명이에요.'
  );

  f.scene(task, 'scene.patch', {
    ...f.read(f.first.id),
    text: f.first.text,
  });
  expect(f.changes(task).map((change) => change.domain)).toEqual(['resource']);
});

test('lore entries, scene titles and created resources get their own entries', () => {
  const f = fixture();
  const bot = f.store.product.content(fixtureBotInput('로어 봇', '설명'));
  const task = f.begin();
  const lore = '/package/nativeRisu/card/character_book/entries';
  const inserted = f.resource(task, 'resource.patch', {
    kind: 'content',
    id: bot.id,
    expectedRevision: bot.revision,
    changes: [
      {
        op: 'insert',
        path: `${lore}/0`,
        value: { comment: '마을', keys: ['마을'], content: '조용한 마을' },
      },
    ],
  });
  const created = f.resource(task, 'resource.save', {
    kind: 'content',
    model: fixtureBotInput('새 봇', '새 설명'),
  });
  f.workspace.operation(task.id, `${task.id}:title`, { name: 'scene.title' }, () =>
    applyHelperChatState(f.store, f.workspace, task, `${task.id}:title`, f.chat.id, 'scene.title', {
      sourceId: f.second.id,
      title: '출발',
      expectedTitle: '',
    })
  );
  const changes = f.changes(task);
  expect(changes.map((change) => [change.domain, change.action, change.location])).toEqual([
    ['resource', 'create', '로어북 › 마을'],
    ['resource', 'create', null],
    ['scene', 'create', '장면 2 · 제목'],
  ]);
  expect(changes[0]!.anchor).toEqual({
    domain: 'resource',
    kind: 'content',
    id: bot.id,
    path: `${lore}/0`,
    section: 'lore',
    index: 0,
  });
  expect(changes[1]).toMatchObject({ targetId: created.id, title: '새 봇', diff: null });
  expect(inserted.revision).toBeGreaterThan(bot.revision);
});

test('a retried operation records once and a failed or cancelled task keeps only committed changes', () => {
  const f = fixture();
  const task = f.begin();
  const args = { ...f.read(f.first.id), changes: [{ oldText: '다리를', newText: '강을' }] };
  f.scene(task, 'scene.patch', args, 'same-call');
  const before = f.store.db.prepare('SELECT * FROM helper_changes').all();
  expect(f.scene(task, 'scene.patch', args, 'same-call')).toMatchObject({ changed: true });
  expect(f.store.db.prepare('SELECT * FROM helper_changes').all()).toEqual(before);

  expect(() =>
    f.workspace.operation(task.id, `${task.id}:fails`, { name: 'scene.patch' }, () => {
      invokeHelperSceneTool(
        f.store,
        f.chat.id,
        'scene.patch',
        { ...f.read(f.second.id), changes: [{ oldText: '가자', newText: '멈춰' }] },
        task
      );
      throw new Error('after save');
    })
  ).toThrow('after save');
  expect(f.store.source(f.second.id).text).toBe(f.second.text);
  expect(f.changes(task).map((change) => change.targetId)).toEqual([`${f.first.id}:original`]);

  f.workspace.cancel(task.id);
  expect(() =>
    f.scene(task, 'scene.patch', {
      ...f.read(f.second.id),
      changes: [{ oldText: '가자', newText: '멈춰' }],
    })
  ).toThrow('HELPER_TASK_NO_LONGER_ACTIVE');
  expect(f.changes(task).map((change) => change.targetId)).toEqual([`${f.first.id}:original`]);
});

test('scene, chat, conversation and resource deletion leave no edited text in the record', () => {
  const marker = 'SECRET_MARKER';
  const f = fixture();
  const bot = f.store.product.content(fixtureBotInput('삭제 봇', `${marker} 설명`));
  const task = f.begin();
  f.scene(task, 'scene.patch', {
    ...f.read(f.second.id),
    changes: [{ oldText: '가자', newText: `${marker} 가자` }],
  });
  f.resource(task, 'resource.patch', {
    kind: 'content',
    id: bot.id,
    expectedRevision: bot.revision,
    changes: [
      {
        op: 'replaceText',
        path: '/package/nativeRisu/card/description',
        oldText: '설명',
        newText: `${marker} 새 설명`,
      },
    ],
  });
  f.workspace.finish(task.id, 'changes-fixture', 1, 'completed', '', null);
  expect(f.rows()).toContain(marker);

  deleteScenes(f.store, f.chat.id, f.second.id, {
    ...sceneDeletionImpact(f.store, f.chat.id, f.second.id).request,
    scope: 'only',
    idempotencyKey: randomUUID(),
  });
  const saved = f.store.product.get<Content>('content', bot.id);
  deleteLibraryItem(f.store, 'content', bot.id, { expectedRevision: saved.revision });
  expect(f.rows()).not.toContain(marker);
  expect(f.rows()).not.toContain('가자');
  expect(f.changes(task)).toEqual([
    {
      domain: 'scene',
      targetId: `${f.second.id}:original`,
      title: '변경 기록 채팅',
      location: null,
      action: 'update',
      diff: null,
      anchor: null,
      textRemoved: 'deleted',
    },
    {
      domain: 'resource',
      targetId: bot.id,
      title: '삭제 봇',
      location: null,
      action: 'update',
      diff: null,
      anchor: null,
      textRemoved: 'deleted',
    },
  ]);

  const next = f.begin();
  f.scene(next, 'scene.patch', {
    ...f.read(f.first.id),
    changes: [{ oldText: '다리를', newText: `${marker} 다리를` }],
  });
  f.workspace.finish(next.id, 'changes-fixture', 1, 'completed', '', null);
  const { request } = f.workspace.deletionImpact(f.conversation.id);
  f.workspace.delete(f.conversation.id, request);
  expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM helper_changes').get()).toEqual({ n: 0 });

  const other = f.workspace.open({ kind: 'chat', chatId: f.chat.id });
  const again = f.workspace.enqueue(other.id, randomUUID(), 'Edit', next.snapshot);
  f.workspace.start(again.id, 'changes-fixture');
  f.scene(f.workspace.task(again.id), 'scene.patch', {
    ...f.read(f.first.id),
    changes: [{ oldText: '다리를', newText: `${marker} 다리를` }],
  });
  f.workspace.finish(again.id, 'changes-fixture', 1, 'completed', '', null);
  expect(f.rows()).toContain(marker);
  deleteChat(f.store, f.chat.id, {});
  expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM helper_changes').get()).toEqual({ n: 0 });
});

test('changes older than the retained turns or days lose their text but stay listed', () => {
  const f = fixture();
  const task = f.begin();
  f.scene(task, 'scene.patch', {
    ...f.read(f.first.id),
    changes: [{ oldText: '다리를', newText: '강을' }],
  });
  f.workspace.finish(task.id, 'changes-fixture', 1, 'completed', '', null);
  for (let turn = 1; turn < HELPER_CHANGE_RETENTION.turns; turn++) {
    const later = f.begin();
    f.workspace.finish(later.id, 'changes-fixture', 1, 'completed', '', null);
  }
  expect(f.changes(task)[0]!.diff).not.toBeNull();
  const later = f.begin();
  f.scene(later, 'scene.patch', {
    ...f.read(f.second.id),
    changes: [{ oldText: '가자', newText: '멈춰' }],
  });
  expect(f.changes(task)).toMatchObject([{ textRemoved: 'expired', diff: null, location: null }]);
  expect(f.rows()).not.toContain('다리를');
  expect(f.changes(later)[0]!.diff).not.toBeNull();

  pruneHelperChanges(
    f.store.db,
    undefined,
    Date.now() + (HELPER_CHANGE_RETENTION.days + 1) * 86_400_000
  );
  expect(f.changes(later)).toMatchObject([{ textRemoved: 'expired', diff: null }]);
  expect(f.rows()).not.toContain('가자');
});

test('unused image cleanup keeps images that a recorded baseline still references', () => {
  const f = fixture();
  const hash = 'a'.repeat(64);
  f.store.db
    .prepare('INSERT INTO image_blobs(hash,mime,bytes) VALUES(?,?,?)')
    .run(hash, 'image/png', Buffer.from([1]));
  const bot = f.store.product.content(
    fixtureBotInput('이미지 봇', `![그림](/api/package-image-blobs/${hash})`)
  );
  const task = f.begin();
  f.resource(task, 'resource.patch', {
    kind: 'content',
    id: bot.id,
    expectedRevision: bot.revision,
    changes: [
      {
        op: 'set',
        path: '/package/nativeRisu/card/description',
        value: '그림 없음',
      },
    ],
  });
  const saved = f.store.product.get<Content>('content', bot.id);
  f.resource(task, 'resource.patch', {
    kind: 'content',
    id: bot.id,
    expectedRevision: saved.revision,
    changes: [{ op: 'set', path: '/package/nativeRisu/card/creator_notes', value: '다른 메모' }],
  });
  f.workspace.finish(task.id, 'changes-fixture', 1, 'completed', '', null);
  expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM resource_undo').get()).toEqual({ n: 1 });
  pruneUnusedData(f.store.db, [hash]);
  expect(f.store.db.prepare('SELECT 1 AS kept FROM image_blobs WHERE hash=?').get(hash)).toEqual({
    kept: 1,
  });
  f.store.db.prepare('UPDATE helper_changes SET baseline=NULL').run();
  pruneUnusedData(f.store.db, [hash]);
  expect(f.store.db.prepare('SELECT 1 FROM image_blobs WHERE hash=?').get(hash)).toBeUndefined();
});

test('outline and author notes record node and note changes, and a deleted target has no anchor', () => {
  const f = fixture();
  const bot = f.store.product.content(fixtureBotInput('지울 봇', '설명'));
  f.store.outline.applyReceipt(
    f.chat.id,
    {
      operations: [{ op: 'create', level: 'arc', title: '1부', intent: '마을을 떠난다' }],
      idempotencyKey: 'outline-seed',
    },
    'user'
  );
  const node = f.store.outline.nodes(f.chat.id)[0]!;
  const note = f.store.story.notes.write(f.chat.id, {
    text: '그는 다리를 두려워한다.',
    author: 'Synthetic author',
    expectedRevision: 0,
    expectedHeadRevision: f.second.id,
    idempotencyKey: 'note-seed',
  }).note;
  const task = f.begin();
  const write = (target: Parameters<typeof withHelperChange>[2], mutate: () => unknown) =>
    f.workspace.operation(task.id, `${task.id}:${randomUUID()}`, { target }, () =>
      withHelperChange(f.store, task, target, mutate)
    );
  write({ domain: 'outline', chatId: f.chat.id }, () =>
    f.store.outline.applyReceipt(
      f.chat.id,
      {
        operations: [
          { op: 'update', id: node.id, expectedRevision: node.revision, intent: '마을로 돌아온다' },
          { op: 'create', level: 'arc', title: '2부', intent: '강을 건넌다' },
        ],
        idempotencyKey: 'outline-edit',
      },
      'user'
    )
  );
  write({ domain: 'notes', chatId: f.chat.id }, () =>
    f.store.story.notes.write(f.chat.id, {
      text: '그는 강을 두려워한다.',
      author: '사용자 도우미 요청',
      expectedRevision: 1,
      expectedHeadRevision: f.second.id,
      replacesId: note.id,
      idempotencyKey: 'note-edit',
    })
  );
  f.resource(task, 'resource.delete', {
    kind: 'content',
    id: bot.id,
    expectedRevision: bot.revision,
  });
  const changes = f.changes(task);
  expect(changes.map((change) => [change.domain, change.action, change.location])).toEqual([
    ['outline', 'update', 'arc · 1부 · intent'],
    ['outline', 'create', 'arc · 2부'],
    ['notes', 'update', '작가 노트 · 그는 강을 두려워한다.'],
    ['resource', 'delete', null],
  ]);
  expect(changes[0]!.anchor).toEqual({
    domain: 'outline',
    chatId: f.chat.id,
    nodeId: node.id,
    field: 'intent',
  });
  expect(hunksOf(changes[2]!)).toMatchObject({ added: 1, removed: 1 });
  expect(changes[3]).toMatchObject({
    targetId: bot.id,
    title: '지울 봇',
    anchor: null,
    diff: null,
  });
  expect(
    f.store.db.prepare("SELECT baseline FROM helper_changes WHERE domain='resource'").get()
  ).toEqual({ baseline: 'null' });
});

test('theme asset cleanup keeps fonts and images a recorded theme baseline references', () => {
  const f = fixture();
  const task = f.begin();
  const hash = 'b'.repeat(64);
  f.store.db
    .prepare('INSERT INTO theme_assets(hash,kind,mime,bytes,created_at) VALUES(?,?,?,?,?)')
    .run(hash, 'font', 'font/woff2', Buffer.from([1]), new Date().toISOString());
  f.store.db
    .prepare(
      "INSERT INTO helper_changes(task_id,domain,target_id,position,baseline,entries,updated_at) VALUES(?,'resource','theme:custom',1,?,'[]',?)"
    )
    .run(task.id, JSON.stringify({ assets: [{ hash, kind: 'font' }] }), new Date().toISOString());
  pruneThemeAssets(f.store.db, [hash]);
  expect(f.store.db.prepare('SELECT 1 AS kept FROM theme_assets WHERE hash=?').get(hash)).toEqual({
    kept: 1,
  });
  forgetHelperResourceChanges(f.store.db, 'theme', 'custom');
  pruneThemeAssets(f.store.db, [hash]);
  expect(f.store.db.prepare('SELECT 1 FROM theme_assets WHERE hash=?').get(hash)).toBeUndefined();
});

test('a chat lore patch that leaves the effective text unchanged records nothing', () => {
  const f = fixture();
  const model = fixtureBotInput('로어 채팅 봇', '설명');
  model.package = nativeContent({
    name: '로어 채팅 봇',
    description: '설명',
    character_book: {
      entries: [{ keys: ['마을'], comment: '마을', content: '조용한 마을', constant: true }],
    },
  });
  const bot = f.store.product.content(model) as Content;
  const chat = createFixtureChat(f.store, '로어 채팅', { botId: bot.id });
  const service = new ChatOverridesStore(f.store);
  const selector = { id: bot.id, role: 'bot', modulePath: [], loreId: 'lore-0', field: 'text' };
  const task = f.begin();
  const patch = (value: string) => {
    const state = service.get(chat.id);
    const attachment = state.attachments[0]!;
    const body = {
      selector,
      value,
      expectedRevision: state.revision,
      expectedHeadRevision: state.headRevision,
      expectedProfileRevision: state.profileRevision,
      expectedPackageRevision: attachment.packageRevision,
      expectedFieldHash: chatOverrideHash(attachment.lore[0]!.text),
      operationId: randomUUID(),
    };
    f.workspace.operation(task.id, `${task.id}:${body.operationId}`, { body }, () => {
      const prior = service.current(chat.id, selector);
      const saved = service.patch(chat.id, body, task.id);
      recordHelperChatLoreChange(f.store, task, chat.id, prior, saved.entry);
      return saved;
    });
  };
  patch('조용한 마을');
  expect(f.changes(task)).toEqual([]);
  patch('시끄러운 마을');
  expect(f.changes(task).map((change) => [change.domain, change.action])).toEqual([
    ['chat-lore', 'update'],
  ]);
  patch('조용한 마을');
  expect(f.changes(task)).toEqual([]);
});
