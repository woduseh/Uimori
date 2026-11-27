import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { Content, SavedPromptCombination } from '../core/product.js';
import { applyHelperPromptCombination } from '../server/helper-prompt-combination-tools.js';
import { readHelperTaskResults } from '../server/helper-task-results.js';
import { deleteLibraryItem } from '../server/library-deletion.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { promptWorkspace } from '../server/prompt-workspace.js';
import { Store } from '../server/store.js';
import { createFixtureChat, fixtureBotInput } from './fixtures/chat.js';
import { nativeContent } from './fixtures/native-content.js';
import {
  helperCall,
  helperDone,
  runScriptedChatHelper,
  selectFixtureModels,
} from './fixtures/scripted-helper.js';

const owned: { store: Store; dir: string }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const { store, dir } of owned.splice(0)) {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-chat-lifecycle-'));
  const store = new Store(join(dir, 'test.sqlite'));
  owned.push({ store, dir });
  selectFixtureModels(store);
  const bot = store.product.content({
    ...fixtureBotInput('등대지기'),
    package: nativeContent({ name: '등대지기', first_mes: '안개 낀 밤, 등대에 불이 켜졌다.' }),
  }) as Content;
  const persona = store.product.content({
    ...fixtureBotInput('여행자'),
    kind: 'persona',
    package: nativeContent({ name: '여행자' }, {}, 'persona'),
  }) as Content;
  const chat = createFixtureChat(store, '지금 채팅', { botId: bot.id });
  return { store, bot, persona, chat };
}

test('chat.create starts a chat with the bot and its first message, and an empty titled one on request', async () => {
  const f = fixture();
  const chatCreated = vi.fn();
  const run = await runScriptedChatHelper(
    f.store,
    f.chat.id,
    [
      helperCall('default', 'chat.create', { botId: f.bot.id }),
      helperCall('empty', 'chat.create', {
        botId: f.bot.id,
        title: '빈 채팅',
        persona: f.persona.id,
        startId: null,
      }),
      helperCall('persona-as-bot', 'chat.create', { botId: f.persona.id }),
      helperDone,
    ],
    { chatCreated }
  );
  expect(run.finished('default')).toMatchObject({ denied: false });
  expect(run.finished('empty')).toMatchObject({ denied: false });
  expect(run.finished('persona-as-bot')).toMatchObject({ denied: true });
  const created = f.store.chats().filter((chat) => chat.id !== f.chat.id);
  expect(created).toHaveLength(2);
  const [opened, empty] = [
    created.find((chat) => chat.title === '등대지기')!,
    created.find((chat) => chat.title === '빈 채팅')!,
  ];
  expect(opened).toMatchObject({ botId: f.bot.id });
  expect(opened.headRevision).toEqual(expect.any(String));
  expect(f.store.history(opened.headRevision).map((item) => item.text)).toEqual([
    expect.stringContaining('등대에 불이 켜졌다'),
  ]);
  expect(empty.headRevision).toBeNull();
  expect(f.store.product.profile(empty.id).packageAttachments).toEqual([
    { id: f.bot.id, revision: f.bot.revision, role: 'bot' },
    { id: f.persona.id, revision: f.persona.revision, role: 'persona' },
  ]);
  expect(chatCreated.mock.calls).toEqual([
    [opened.id, 'ko'],
    [empty.id, null],
  ]);
  expect(f.store.chat(f.chat.id).headRevision).toBe(f.chat.headRevision);
  expect(run.results).toMatchObject([
    { operation: 'chat.create', targets: [{ kind: 'chat', id: opened.id }] },
    { operation: 'chat.create', targets: [{ kind: 'chat', id: empty.id }] },
  ]);
});

test('chat.delete waits for confirmation, deletes the chat with its helper conversations, and refuses its own chat', async () => {
  const f = fixture();
  const other = createFixtureChat(f.store, '지울 채팅', { botId: f.bot.id });
  new HelperWorkspace(f.store).open({ kind: 'chat', chatId: other.id });
  const held = await runScriptedChatHelper(f.store, f.chat.id, [
    helperCall('own', 'chat.delete', { chatId: f.chat.id }),
    helperCall('other', 'chat.delete', { chatId: other.id }),
    helperDone,
  ]);
  expect(held.finished('own')).toMatchObject({
    denied: true,
    errorCode: 'CURRENT_CHAT_DELETION',
  });
  expect(held.finished('other')).toMatchObject({ errorCode: 'CONFIRMATION_REQUIRED' });
  const [confirmation] = readHelperTaskResults(f.store, held.task.id).confirmations;
  expect(confirmation).toMatchObject({
    operation: 'chat.delete',
    reason: 'delete',
    targets: [{ kind: 'chat', id: other.id, title: '지울 채팅' }],
  });
  const chatDeleted = vi.fn();
  const granted = await runScriptedChatHelper(
    f.store,
    f.chat.id,
    [helperCall('other', 'chat.delete', { chatId: other.id }), helperDone],
    { chatDeleted },
    { request: '지워 줘', confirmations: [confirmation!.id] }
  );
  expect(granted.finished('other')).toMatchObject({ denied: false });
  expect(f.store.chats().map((chat) => chat.id)).toEqual([f.chat.id]);
  expect(
    f.store.db
      .prepare('SELECT COUNT(*) AS n FROM helper_conversations WHERE chat_id=?')
      .get(other.id)
  ).toEqual({ n: 0 });
  expect(chatDeleted).toHaveBeenCalledWith(other.id);
  expect(granted.results).toMatchObject([
    { operation: 'chat.delete', targets: [{ kind: 'chat', id: other.id, title: '지울 채팅' }] },
  ]);
});

test('option presets are listed, saved, renamed, applied and deleted through the prompt settings functions', async () => {
  const f = fixture();
  const workspaceRevision = promptWorkspace(f.store).revision;
  const run = await runScriptedChatHelper(f.store, f.chat.id, [
    helperCall('save', 'prompt.combination.save', { title: '짧게', workspaceRevision }),
    helperDone,
  ]);
  expect(run.finished('save')).toMatchObject({ denied: false });
  const [saved] = f.store.product.all('prompt-combination') as SavedPromptCombination[];
  expect(saved).toMatchObject({ title: '짧게', role: 'main', owner: expect.any(Object) });
  const listed = await runScriptedChatHelper(f.store, f.chat.id, [
    helperCall('list', 'prompt.combination.list', {}),
    helperCall('rename', 'prompt.combination.update', {
      id: saved!.id,
      expectedRevision: saved!.revision,
      sourceRevision:
        promptWorkspace(f.store).main.presetRevision ?? promptWorkspace(f.store).revision,
      title: '짧고 담백하게',
      values: {},
    }),
    helperCall('apply', 'prompt.combination.apply', {
      id: saved!.id,
      workspaceRevision: promptWorkspace(f.store).revision,
    }),
    helperCall('delete', 'prompt.combination.delete', {
      id: saved!.id,
      expectedRevision: saved!.revision + 1,
    }),
    helperDone,
  ]);
  expect(listed.finished('list')).toMatchObject({ denied: false });
  expect(listed.finished('rename')).toMatchObject({ denied: false });
  expect(listed.finished('apply')).toMatchObject({ denied: false });
  expect(listed.finished('delete')).toMatchObject({ errorCode: 'CONFIRMATION_REQUIRED' });
  expect(f.store.product.get<SavedPromptCombination>('prompt-combination', saved!.id).title).toBe(
    '짧고 담백하게'
  );
  expect(listed.results.map((result) => result.operation)).toEqual([
    'prompt.combination.update',
    'prompt.combination.apply',
  ]);
  const [confirmation] = readHelperTaskResults(f.store, listed.task.id).confirmations;
  expect(confirmation).toMatchObject({
    operation: 'prompt.combination.delete',
    targets: [{ kind: 'prompt-combination', id: saved!.id, title: '짧고 담백하게' }],
  });
  const deleted = await runScriptedChatHelper(
    f.store,
    f.chat.id,
    [
      helperCall('delete', 'prompt.combination.delete', {
        id: saved!.id,
        expectedRevision: saved!.revision + 1,
      }),
      helperDone,
    ],
    {},
    { request: '지워 줘', confirmations: [confirmation!.id] }
  );
  expect(deleted.finished('delete')).toMatchObject({ denied: false });
  expect(f.store.product.isHidden('prompt-combination', saved!.id)).toBe(true);
});

test('deleting a combination already deleted elsewhere answers a revision conflict', async () => {
  const f = fixture();
  await runScriptedChatHelper(f.store, f.chat.id, [
    helperCall('save', 'prompt.combination.save', {
      title: '짧게',
      workspaceRevision: promptWorkspace(f.store).revision,
    }),
    helperDone,
  ]);
  const [saved] = f.store.product.all('prompt-combination') as SavedPromptCombination[];
  const target = { id: saved!.id, expectedRevision: saved!.revision };
  deleteLibraryItem(f.store, 'prompt-combination', saved!.id, target);
  expect(() =>
    applyHelperPromptCombination(
      f.store,
      {} as HelperWorkspace,
      { id: 'task', conversationId: 'conversation' },
      'receipt',
      'prompt.combination.delete',
      target
    )
  ).toThrow(expect.objectContaining({ statusCode: 409, message: 'REVISION_CONFLICT' }));
});
