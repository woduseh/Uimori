import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { Content } from '../core/product.js';
import { deleteChat } from '../server/chat-deletion.js';
import { helperConfirmationGate } from '../server/helper-confirmations.js';
import { readHelperTaskResults } from '../server/helper-task-results.js';
import { deleteLibraryItem } from '../server/library-deletion.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { Store } from '../server/store.js';
import { createFixtureChat, fixtureBotInput } from './fixtures/chat.js';
import { completedSource } from './fixtures/illustration.js';
import {
  helperCall,
  helperDone,
  runScriptedChatHelper,
  selectFixtureModels,
} from './fixtures/scripted-helper.js';

const owned: { stores: Store[]; directory: string }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const { stores, directory } of owned.splice(0)) {
    for (const store of stores) if (store.db.isOpen) store.close();
    const inside = relative(resolve(tmpdir()), resolve(directory));
    if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('uimori-confirm-'))
      throw new Error('Unsafe cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-confirm-'));
  const path = join(directory, 'confirm.sqlite');
  const entry = { stores: [new Store(path)], directory };
  owned.push(entry);
  const store = () => entry.stores.at(-1)!;
  const restart = () => {
    store().close();
    entry.stores.push(new Store(path));
    return store();
  };
  selectFixtureModels(store());
  const chat = createFixtureChat(store(), '확인 채팅');
  completedSource(store(), chat.id, '첫 장면이에요.\n');
  const bots = ['하나', '둘', '셋'].map(
    (name) => store().product.content(fixtureBotInput(`${name} 봇`, '설명')) as Content
  );
  const patch = (bot: Content, title: string) => ({
    kind: 'content',
    id: bot.id,
    expectedRevision: bot.revision,
    changes: [{ op: 'set', path: '/package/nativeRisu/card/description', value: title }],
  });
  const exists = (id: string) => !store().product.isHidden('content', id);
  return { store, restart, chat, bots, patch, exists };
}

test('resource deletion and a patch of three resources wait for confirmation, a patch of two does not', async () => {
  const f = fixture();
  const [one, two, three] = f.bots as [Content, Content, Content];
  const run = await runScriptedChatHelper(f.store(), f.chat.id, [
    helperCall('delete', 'resource.delete', {
      kind: 'content',
      id: one.id,
      expectedRevision: one.revision,
    }),
    helperCall('three', 'resource.patchMany', {
      items: [f.patch(one, '1'), f.patch(two, '2'), f.patch(three, '3')],
    }),
    helperCall('two', 'resource.patchMany', { items: [f.patch(one, '1'), f.patch(two, '2')] }),
    helperDone,
  ]);
  expect(run.finished('delete')).toMatchObject({
    denied: true,
    errorCode: 'CONFIRMATION_REQUIRED',
  });
  expect(run.finished('three')).toMatchObject({ denied: true, errorCode: 'CONFIRMATION_REQUIRED' });
  expect(run.finished('two')).toMatchObject({ denied: false });
  expect(f.exists(one.id)).toBe(true);
  expect(readHelperTaskResults(f.store(), run.task.id).confirmations).toEqual([
    {
      id: expect.any(String),
      taskId: run.task.id,
      operation: 'resource.delete',
      reason: 'delete',
      chatId: f.chat.id,
      targets: [{ kind: 'content', id: one.id }],
      grantedBy: null,
      grantable: true,
    },
    expect.objectContaining({
      operation: 'resource.patchMany',
      reason: 'bulk',
      targets: [
        { kind: 'content', id: one.id },
        { kind: 'content', id: two.id },
        { kind: 'content', id: three.id },
      ],
    }),
  ]);
});

test('paid generation waits for confirmation only when the helper setting asks for it', async () => {
  const f = fixture();
  const translate = (sourceId: string) =>
    runScriptedChatHelper(
      f.store(),
      f.chat.id,
      [helperCall('translate', 'scene.translate', { sourceId }), helperDone],
      {
        story: {
          requireRunModel: () => {},
          requireTranslationModel: () => {},
          started: () => {},
        },
      }
    );
  const sourceId = f.store().chat(f.chat.id).headRevision!;
  expect(modelWorkspace(f.store()).helperConfirmPaidGeneration).toBe(false);
  expect((await translate(sourceId)).finished('translate')).toMatchObject({ denied: false });
  const current = modelWorkspace(f.store());
  updateModelWorkspace(f.store(), {
    expectedRevision: current.revision,
    routes: current.routes,
    translationPolicy: current.translationPolicy,
    helperConfirmPaidGeneration: true,
  });
  expect(modelWorkspace(f.store()).helperConfirmPaidGeneration).toBe(true);
  const held = await translate(sourceId);
  expect(held.finished('translate')).toMatchObject({
    denied: true,
    errorCode: 'CONFIRMATION_REQUIRED',
  });
  expect(readHelperTaskResults(f.store(), held.task.id).confirmations).toMatchObject([
    { operation: 'scene.translate', reason: 'paid', targets: [{ kind: 'scene', id: sourceId }] },
  ]);
});

test('a grant survives a restart, runs the exact call once and rejects other arguments', async () => {
  const f = fixture();
  const [one, two] = f.bots as [Content, Content];
  const remove = (bot: Content) => ({
    kind: 'content',
    id: bot.id,
    expectedRevision: bot.revision,
  });
  const first = await runScriptedChatHelper(f.store(), f.chat.id, [
    helperCall('delete', 'resource.delete', remove(one)),
    helperDone,
  ]);
  const [confirmation] = readHelperTaskResults(f.store(), first.task.id).confirmations;
  const second = await runScriptedChatHelper(
    f.restart(),
    f.chat.id,
    [
      helperCall('other', 'resource.delete', remove(two)),
      helperCall('changed', 'resource.delete', { ...remove(one), expectedRevision: 99 }),
      helperCall('confirmed', 'resource.delete', remove(one)),
      helperCall('again', 'resource.delete', remove(one)),
      helperDone,
    ],
    {},
    { request: '지워 줘', confirmations: [confirmation!.id] }
  );
  expect(second.finished('other')).toMatchObject({ errorCode: 'CONFIRMATION_REQUIRED' });
  expect(second.finished('changed')).toMatchObject({ errorCode: 'CONFIRMATION_REQUIRED' });
  expect(second.finished('confirmed')).toMatchObject({ denied: false });
  expect(second.finished('again')).toMatchObject({ errorCode: 'CONFIRMATION_REQUIRED' });
  expect(f.exists(one.id)).toBe(false);
  expect(f.exists(two.id)).toBe(true);
  expect(second.requests[0]!.input.source).toMatchObject({
    confirmedCalls: [{ name: 'resource.delete', arguments: remove(one), chatId: f.chat.id }],
  });
  expect(readHelperTaskResults(f.store(), first.task.id).confirmations).toMatchObject([
    { id: confirmation!.id, grantedBy: second.task.id, grantable: false },
  ]);
});

test('a call held again after an earlier grant can be confirmed again', async () => {
  const f = fixture();
  const [one, two, three] = f.bots as [Content, Content, Content];
  const stale = (bot: Content, title: string) => ({ ...f.patch(bot, title), expectedRevision: 99 });
  const call = () =>
    helperCall('patch', 'resource.patchMany', {
      items: [stale(one, '1'), stale(two, '2'), stale(three, '3')],
    });
  const first = await runScriptedChatHelper(f.store(), f.chat.id, [call(), helperDone]);
  const [confirmation] = readHelperTaskResults(f.store(), first.task.id).confirmations;
  const granted = await runScriptedChatHelper(
    f.store(),
    f.chat.id,
    [call(), helperDone],
    {},
    { request: '바꿔 줘', confirmations: [confirmation!.id] }
  );
  expect(granted.finished('patch')).toMatchObject({ errorCode: 'SOURCE_CONFLICT' });
  const again = await runScriptedChatHelper(f.store(), f.chat.id, [call(), helperDone]);
  expect(again.finished('patch')).toMatchObject({ errorCode: 'CONFIRMATION_REQUIRED' });
  expect(readHelperTaskResults(f.store(), again.task.id).confirmations).toMatchObject([
    { id: confirmation!.id, taskId: again.task.id, grantedBy: null, grantable: true },
  ]);
  expect(readHelperTaskResults(f.store(), first.task.id).confirmations).toMatchObject([
    { grantedBy: granted.task.id, grantable: false },
  ]);
  const regranted = await runScriptedChatHelper(
    f.store(),
    f.chat.id,
    [call(), helperDone],
    {},
    { request: '다시 바꿔 줘', confirmations: [confirmation!.id] }
  );
  expect(regranted.finished('patch')).toMatchObject({ errorCode: 'SOURCE_CONFLICT' });
  expect(readHelperTaskResults(f.store(), again.task.id).confirmations).toMatchObject([
    { grantedBy: regranted.task.id, grantable: false },
  ]);
  expect(readHelperTaskResults(f.store(), first.task.id).confirmations).toMatchObject([
    { grantedBy: granted.task.id },
  ]);
});

const storedArguments = (store: Store) => ({
  held: store.db
    .prepare(
      "SELECT task_id AS taskId FROM helper_events WHERE kind='confirmation.required' AND json_type(data,'$.arguments') IS NOT NULL"
    )
    .all()
    .map((row) => row.taskId),
  granted: store.db
    .prepare(
      "SELECT t.id FROM helper_tasks t, json_each(t.snapshot,'$.confirmations') c WHERE json_type(c.value,'$.arguments') IS NOT NULL"
    )
    .all()
    .map((row) => row.id),
});

test('held and granted call arguments are released once the call can no longer be confirmed', async () => {
  const f = fixture();
  const [one, two, three] = f.bots as [Content, Content, Content];
  const call = () =>
    helperCall('patch', 'resource.patchMany', {
      items: [f.patch(one, '첫 문장'), f.patch(two, '둘'), f.patch(three, '셋')],
    });
  const first = await runScriptedChatHelper(f.store(), f.chat.id, [call(), helperDone]);
  expect(storedArguments(f.store())).toEqual({ held: [first.task.id], granted: [] });
  const [confirmation] = readHelperTaskResults(f.store(), first.task.id).confirmations;
  const granted = await runScriptedChatHelper(
    f.store(),
    f.chat.id,
    [call(), helperDone],
    {},
    { request: '바꿔 줘', confirmations: [confirmation!.id] }
  );
  expect(granted.finished('patch')).toMatchObject({ denied: false });
  expect(storedArguments(f.store())).toEqual({ held: [], granted: [] });
  expect(granted.task.snapshot.confirmations).toEqual([
    { id: confirmation!.id, operation: 'resource.patchMany', chatId: f.chat.id },
  ]);
  expect(readHelperTaskResults(f.store(), first.task.id).confirmations).toMatchObject([
    { grantedBy: granted.task.id, grantable: false },
  ]);
});

test('deleting a target a held call names removes its arguments and the hold expires', async () => {
  const f = fixture();
  const [one, two, three] = f.bots as [Content, Content, Content];
  const held = await runScriptedChatHelper(f.store(), f.chat.id, [
    helperCall('patch', 'resource.patchMany', {
      items: [f.patch(one, '첫 문장'), f.patch(two, '둘'), f.patch(three, '셋')],
    }),
    helperDone,
  ]);
  const [confirmation] = readHelperTaskResults(f.store(), held.task.id).confirmations;
  deleteLibraryItem(f.store(), 'content', two.id, { expectedRevision: two.revision });
  expect(storedArguments(f.store())).toEqual({ held: [], granted: [] });
  expect(readHelperTaskResults(f.store(), held.task.id).confirmations).toMatchObject([
    { id: confirmation!.id, grantedBy: null, grantable: false },
  ]);
  const conversation = held.runtime.workspace.open({ kind: 'chat', chatId: f.chat.id });
  expect(() =>
    held.runtime.enqueue(
      conversation.id,
      randomUUID(),
      '바꿔 줘',
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      { confirmations: [confirmation!.id] }
    )
  ).toThrow('CONFIRMATION_UNAVAILABLE');
});

test('deleting a target also removes the arguments a failed granted task kept for its retry', async () => {
  const f = fixture();
  const [one, two, three] = f.bots as [Content, Content, Content];
  const stale = (bot: Content, title: string) => ({ ...f.patch(bot, title), expectedRevision: 99 });
  const call = () =>
    helperCall('patch', 'resource.patchMany', {
      items: [stale(one, '1'), stale(two, '2'), stale(three, '3')],
    });
  const held = await runScriptedChatHelper(f.store(), f.chat.id, [call(), helperDone]);
  const [confirmation] = readHelperTaskResults(f.store(), held.task.id).confirmations;
  const granted = await runScriptedChatHelper(
    f.store(),
    f.chat.id,
    [call(), helperDone],
    {},
    { request: '바꿔 줘', confirmations: [confirmation!.id] }
  );
  f.store()
    .db.prepare("UPDATE helper_tasks SET status='failed',snapshot=? WHERE id=?")
    .run(
      JSON.stringify({
        ...granted.task.snapshot,
        confirmations: [
          { ...granted.task.snapshot.confirmations![0]!, arguments: { items: ['kept'] } },
        ],
      }),
      granted.task.id
    );
  expect(storedArguments(f.store())).toEqual({ held: [], granted: [granted.task.id] });
  deleteLibraryItem(f.store(), 'content', two.id, { expectedRevision: two.revision });
  expect(storedArguments(f.store())).toEqual({ held: [], granted: [] });
  const conversation = held.runtime.workspace.open({ kind: 'chat', chatId: f.chat.id });
  expect(() =>
    held.runtime.enqueue(
      conversation.id,
      randomUUID(),
      '다시 해 줘',
      undefined,
      undefined,
      granted.task.id
    )
  ).toThrow('CONFIRMATION_UNAVAILABLE');
});

test('deleting a chat removes the arguments of a call another conversation held for it', () => {
  const f = fixture();
  const workspace = new HelperWorkspace(f.store());
  const library = workspace.open({ kind: 'library', workId: 'confirm-library' });
  const task = workspace.enqueue(library.id, 'library', '이어서 써 줘', {
    scope: library.scope,
    model: {} as never,
    history: [],
    persona: '',
    limits: { totalCalls: 3, helperCalls: 2 },
    confirmPaidGeneration: true,
  });
  const result = helperConfirmationGate(
    f.store(),
    workspace,
    { ...task, snapshot: { ...task.snapshot, scope: { kind: 'chat', chatId: f.chat.id } } },
    'scene.request',
    { text: '비밀 장면 요청' },
    'receipt'
  );
  expect(result).toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
  expect(storedArguments(f.store())).toEqual({ held: [task.id], granted: [] });
  deleteChat(f.store(), f.chat.id, {});
  expect(storedArguments(f.store())).toEqual({ held: [], granted: [] });
  expect(JSON.stringify(workspace.events(library.id))).not.toContain('비밀 장면 요청');
});

test('only a confirmation from the latest task can be granted, and declining needs no call', async () => {
  const f = fixture();
  const [one] = f.bots as [Content];
  const first = await runScriptedChatHelper(f.store(), f.chat.id, [
    helperCall('delete', 'resource.delete', {
      kind: 'content',
      id: one.id,
      expectedRevision: one.revision,
    }),
    helperDone,
  ]);
  const [confirmation] = readHelperTaskResults(f.store(), first.task.id).confirmations;
  const workspace = new HelperWorkspace(f.store());
  const conversation = workspace.open({ kind: 'chat', chatId: f.chat.id });
  const declined = await runScriptedChatHelper(
    f.store(),
    f.chat.id,
    [helperDone],
    {},
    {
      request: '지우지 말아 줘',
    }
  );
  expect(declined.task.status).toBe('completed');
  expect(f.exists(one.id)).toBe(true);
  expect(readHelperTaskResults(f.store(), first.task.id).confirmations).toMatchObject([
    { grantedBy: null, grantable: false },
  ]);
  for (const id of [confirmation!.id, 'unknown'])
    expect(() =>
      declined.runtime.enqueue(
        conversation.id,
        randomUUID(),
        '이제 지워 줘',
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        { confirmations: [id] }
      )
    ).toThrow('CONFIRMATION_UNAVAILABLE');
});
