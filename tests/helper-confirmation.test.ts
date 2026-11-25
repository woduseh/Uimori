import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { Content } from '../core/product.js';
import { deleteChat } from '../server/chat-deletion.js';
import { helperConfirmationGate } from '../server/helper-confirmations.js';
import { helperRollbackView, rollBackHelperTask } from '../server/helper-rollback.js';
import { HELPER_APP_TOOLS, helperToolTraits } from '../server/helper-app-tools.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HelperConfirmation } from '../core/helper.js';
import {
  HELPER_CONFIRMATION_OPERATION_LABELS,
  HelperConfirmations,
} from '../web/HelperConfirmations.js';
import { t } from '../web/i18n.js';
import { readHelperTaskResults } from '../server/helper-task-results.js';
import { requestTranslation } from '../server/source-editing.js';
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

const remove = (bot: Content, expectedRevision = bot.revision) => ({
  kind: 'content',
  id: bot.id,
  expectedRevision,
});

test('resource deletion waits for confirmation, and a patch of three resources saves with an undo for each', async () => {
  const f = fixture();
  const [one, two, three] = f.bots as [Content, Content, Content];
  const run = await runScriptedChatHelper(f.store(), f.chat.id, [
    helperCall('delete', 'resource.delete', remove(one)),
    helperCall('three', 'resource.patchMany', {
      items: [f.patch(one, '1'), f.patch(two, '2'), f.patch(three, '3')],
    }),
    helperDone,
  ]);
  expect(run.finished('delete')).toMatchObject({
    denied: true,
    errorCode: 'CONFIRMATION_REQUIRED',
  });
  expect(run.finished('three')).toMatchObject({ denied: false });
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
  ]);
  const workspace = new HelperWorkspace(f.store());
  expect(
    helperRollbackView(f.store(), workspace, run.task.id).units.map(({ unit, status }) => [
      unit,
      status,
    ])
  ).toEqual([one, two, three].map((bot) => [`resource:content:${bot.id}`, 'restorable'] as const));
  rollBackHelperTask(f.store(), workspace, run.task.id, undefined);
  expect(
    [one, two, three].map(
      (bot) => f.store().product.get<Content>('content', bot.id).package!.nativeRisu!.card
    )
  ).toMatchObject([{ description: '설명' }, { description: '설명' }, { description: '설명' }]);
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

test('a declined call reaches only the next task, without its arguments', async () => {
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
  const [held] = readHelperTaskResults(f.store(), first.task.id).confirmations;
  const second = await runScriptedChatHelper(
    f.store(),
    f.chat.id,
    [helperDone],
    {},
    {
      request: '다른 걸 해 줘',
      declinedConfirmations: [held!.id, 'unknown-confirmation'],
    }
  );
  const declined = {
    reason: 'delete',
    chatId: f.chat.id,
    targets: [{ kind: 'content', id: one.id }],
  };
  expect(second.task.snapshot.declinedCalls).toEqual([
    { id: held!.id, operation: 'resource.delete', ...declined },
  ]);
  expect((second.requests[0]!.input.source as { declinedCalls: unknown }).declinedCalls).toEqual([
    { name: 'resource.delete', ...declined },
  ]);
  expect(readHelperTaskResults(f.store(), first.task.id).confirmations).toMatchObject([
    { id: held!.id, grantedBy: null, grantable: false },
  ]);
  const third = await runScriptedChatHelper(
    f.store(),
    f.chat.id,
    [helperDone],
    {},
    {
      request: '계속해 줘',
      declinedConfirmations: [held!.id],
    }
  );
  expect(third.task.snapshot.declinedCalls).toBeUndefined();
  expect(third.requests[0]!.input.source).not.toHaveProperty('declinedCalls');
});

test('a call held again after an earlier grant can be confirmed again', async () => {
  const f = fixture();
  const [one] = f.bots as [Content];
  const call = () => helperCall('patch', 'resource.delete', remove(one, 99));
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
  const [one] = f.bots as [Content];
  const call = () => helperCall('patch', 'resource.delete', remove(one));
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
    { id: confirmation!.id, operation: 'resource.delete', chatId: f.chat.id },
  ]);
  expect(readHelperTaskResults(f.store(), first.task.id).confirmations).toMatchObject([
    { grantedBy: granted.task.id, grantable: false },
  ]);
});

test('deleting a target a held call names removes its arguments and the hold expires', async () => {
  const f = fixture();
  const [, two] = f.bots as [Content, Content];
  const held = await runScriptedChatHelper(f.store(), f.chat.id, [
    helperCall('patch', 'resource.delete', remove(two)),
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
  const [, two] = f.bots as [Content, Content];
  const call = () => helperCall('patch', 'resource.delete', remove(two, 99));
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

test('a plan-mode request cannot carry a confirmation, which stays grantable', async () => {
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
  const conversation = new HelperWorkspace(f.store()).open({ kind: 'chat', chatId: f.chat.id });
  expect(() =>
    first.runtime.enqueue(
      conversation.id,
      randomUUID(),
      '지우는 계획만 세워 줘',
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      { mode: 'plan', confirmations: [confirmation!.id] }
    )
  ).toThrow('HELPER_PLAN_CONFIRMATIONS');
  expect(readHelperTaskResults(f.store(), first.task.id).confirmations).toMatchObject([
    { id: confirmation!.id, grantedBy: null, grantable: true },
  ]);
});

const UNCONFIRMED_DELETIONS: Record<string, string> = {
  'chat.lore:remove':
    'turn rollback brings back the chat-only override the removal retired (tests/helper-rollback.test.ts)',
  'chat.bookmark:delete':
    'a bookmark marks a place in the reader, and its earlier title and note stay in the change record',
  'chat.organize:delete-folder':
    'the chats of the folder move to the top level; no chat is deleted',
  'library.organize:delete-folder':
    'the items of the folder move to the top of their category; no library item is deleted',
};

function operationCases(tool: (typeof HELPER_APP_TOOLS)[number]) {
  const actions = (
    (tool.inputSchema as { properties?: { action?: { enum?: unknown[] } } }).properties?.action
      ?.enum ?? []
  ).filter((value): value is string => typeof value === 'string');
  return [
    { key: tool.name, args: {} as Record<string, unknown> },
    ...actions.map((action) => ({ key: `${tool.name}:${action}`, args: { action } })),
  ];
}

test('every deleting operation waits for confirmation or names why it does not, and every held operation has a card label', () => {
  const deleting = HELPER_APP_TOOLS.flatMap((tool) =>
    operationCases(tool).filter(({ key }) => /(^|[.:])(delete|remove)[^.:]*$/.test(key))
  );
  expect(deleting.length).toBeGreaterThan(5);
  const unexplained = deleting
    .filter(
      ({ key, args }) =>
        helperToolTraits(key.split(':')[0]!, args).confirmation !== 'delete' &&
        !UNCONFIRMED_DELETIONS[key]
    )
    .map(({ key }) => key);
  expect(unexplained).toEqual([]);
  const held = new Set([
    ...HELPER_APP_TOOLS.flatMap((tool) =>
      operationCases(tool)
        .filter(({ args }) => helperToolTraits(tool.name, args).confirmation)
        .map(() => tool.name)
    ),
  ]);
  expect([...held].filter((name) => !HELPER_CONFIRMATION_OPERATION_LABELS[name])).toEqual([]);
});

function heldTask(f: ReturnType<typeof fixture>, confirmPaidGeneration: boolean) {
  const workspace = new HelperWorkspace(f.store());
  const conversation = workspace.open({ kind: 'chat', chatId: f.chat.id });
  const task = workspace.enqueue(conversation.id, randomUUID(), '삽화 그려 줘', {
    scope: conversation.scope,
    model: {} as never,
    history: [],
    persona: '',
    limits: { totalCalls: 3, helperCalls: 2 },
    ...(confirmPaidGeneration ? { confirmPaidGeneration: true as const } : {}),
  });
  return { workspace, task };
}

test('paid illustration and retry calls wait only when paid confirmation is on, and the card counts the pictures', () => {
  const f = fixture();
  const moment = (sourceId: string, focus: string) => ({
    sourceId,
    expectedSourceHash: 'a'.repeat(64),
    startAnchor: 'p1',
    endAnchor: 'p1',
    focus,
  });
  const second = completedSource(f.store(), f.chat.id, '두 번째 장면이에요.\n');
  const sceneIds = f
    .store()
    .history(f.store().chat(f.chat.id).headRevision)
    .map((item) => item.revision);
  const args = {
    moments: [moment(sceneIds[0]!, '종'), moment(second.id, '안개'), moment(second.id, '등대')],
  };
  const off = heldTask(f, false);
  expect(
    helperConfirmationGate(f.store(), off.workspace, off.task, 'illustration.generate', args, 'r1')
  ).toBeNull();
  const on = heldTask(f, true);
  expect(
    helperConfirmationGate(f.store(), on.workspace, on.task, 'illustration.generate', args, 'r2')
  ).toMatchObject({
    code: 'CONFIRMATION_REQUIRED',
    confirmation: {
      operation: 'illustration.generate',
      reason: 'paid',
      count: 3,
      targets: [
        { kind: 'scene', id: sceneIds[0] },
        { kind: 'scene', id: second.id },
      ],
    },
  });
  expect(
    helperConfirmationGate(
      f.store(),
      on.workspace,
      on.task,
      'task.retry',
      { kind: 'run', id: 'run-1' },
      'r3'
    )
  ).toMatchObject({ confirmation: { operation: 'task.retry', reason: 'paid', targets: [] } });
  const translation = requestTranslation(f.store(), sceneIds[0]!);
  expect(
    helperConfirmationGate(
      f.store(),
      on.workspace,
      on.task,
      'task.retry',
      { kind: 'job', id: translation.id },
      'r-job'
    )
  ).toMatchObject({ confirmation: { operation: 'task.retry', reason: 'paid' } });
  for (const [index, args] of [
    { kind: 'helper', id: 'helper-1' },
    { kind: 'job', id: 'missing-job' },
  ].entries())
    expect(
      helperConfirmationGate(f.store(), on.workspace, on.task, 'task.retry', args, `r${index + 4}`)
    ).toBeNull();
});

test('an irreversible deletion waits even without paid confirmation and names its target', () => {
  const f = fixture();
  const connection = f.store().product.all('connection')[0] as { id: string };
  const model = f.store().product.model({
    title: 'Retired',
    connectionId: connection.id,
    modelId: 'retired',
    maxOutputTokens: 512,
    temperature: null,
  }) as unknown as { id: string; title: string };
  const { workspace, task } = heldTask(f, false);
  expect(
    helperConfirmationGate(
      f.store(),
      workspace,
      task,
      'model.delete',
      { modelId: model.id, expectedRevision: 1 },
      'r1'
    )
  ).toMatchObject({
    confirmation: {
      reason: 'delete',
      targets: [{ kind: 'model', id: model.id, title: model.title }],
    },
  });
  expect(
    helperConfirmationGate(
      f.store(),
      workspace,
      task,
      'chat.lore',
      { action: 'patch', body: {} },
      'r2'
    )
  ).toBeNull();
  expect(
    helperConfirmationGate(
      f.store(),
      workspace,
      task,
      'chat.lore',
      { action: 'remove', body: {} },
      'r3'
    )
  ).toBeNull();
});

test('the confirmation card shows titles the server attached and the number of pictures', () => {
  const held = (overrides: Partial<HelperConfirmation>): HelperConfirmation => ({
    id: 'held',
    taskId: 'task',
    operation: 'model.delete',
    reason: 'delete',
    chatId: null,
    targets: [],
    grantedBy: null,
    grantable: true,
    ...overrides,
  });
  const html = renderToStaticMarkup(
    createElement(HelperConfirmations, {
      confirmations: [
        held({ id: 'model', targets: [{ kind: 'model', id: 'm1', title: 'Old model' }] }),
        held({
          id: 'draw',
          operation: 'illustration.generate',
          reason: 'paid',
          chatId: 'c1',
          targets: [{ kind: 'scene', id: 's1' }],
          count: 3,
        }),
      ],
      nameTarget: (target) => `named:${target.id}`,
      pending: [],
      onConfirm: () => {},
    })
  );
  expect(html).toContain('Old model');
  expect(html).not.toContain('named:m1');
  expect(html).toContain('named:s1');
  expect(html).toContain(t('helperConfirm.pictures', { count: 3 }));
  expect(html).toContain(t('helperConfirm.modelDelete'));
});

test('a model still in use is refused without a confirmation card, and an unused one waits', async () => {
  const f = fixture();
  const used = f.store().product.all('model')[0] as { id: string; revision: number };
  const connection = f.store().product.all('connection')[0] as { id: string };
  const spare = f.store().product.model({
    title: 'Spare',
    connectionId: connection.id,
    modelId: 'spare',
    maxOutputTokens: 512,
    temperature: null,
  });
  const run = await runScriptedChatHelper(f.store(), f.chat.id, [
    helperCall('used', 'model.delete', { modelId: used.id, expectedRevision: used.revision }),
    helperCall('spare', 'model.delete', { modelId: spare.id, expectedRevision: spare.revision }),
    helperDone,
  ]);
  expect(run.finished('used')).toMatchObject({ denied: true, errorCode: 'MODEL_IN_USE' });
  expect(run.finished('spare')).toMatchObject({ denied: true, errorCode: 'CONFIRMATION_REQUIRED' });
  expect(readHelperTaskResults(f.store(), run.task.id).confirmations).toEqual([
    expect.objectContaining({
      operation: 'model.delete',
      targets: [{ kind: 'model', id: spare.id, title: 'Spare' }],
    }),
  ]);
});
