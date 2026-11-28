import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { Content, ModelPreset } from '../core/product.js';
import type { Json } from '../core/transport.js';
import type { HelperTask } from '../core/helper.js';
import { deleteChat } from '../server/chat-deletion.js';
import { ChatOptionsStore, invokeHelperOptions } from '../server/chat-options.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { importChatTranscript } from '../server/chat-transcript.js';
import { sceneTitle } from '../server/scene-titles.js';
import { Store } from '../server/store.js';
import { deleteLibraryItem } from '../server/library-deletion.js';
import { invokeHelperModelParameterTool } from '../server/helper-model-parameter-tools.js';
import { createFixtureChat, fixtureBotInput } from './fixtures/chat.js';
import { softDeleteLibraryItem } from './fixtures/soft-delete.js';
import { nativeContent } from './fixtures/native-content.js';
import { listBookmarks } from '../server/reading-state.js';
import { readSceneContext } from '../server/scene-context.js';
import {
  helperCall,
  helperDone,
  runScriptedChatHelper,
  selectFixtureModels,
} from './fixtures/scripted-helper.js';

const owned: { store: Store; directory: string }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const { store, directory } of owned.splice(0)) {
    store.close();
    const inside = relative(resolve(tmpdir()), resolve(directory));
    if (
      isAbsolute(inside) ||
      inside.startsWith('..') ||
      !inside.startsWith('uimori-chat-settings-')
    )
      throw new Error('Unsafe cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-chat-settings-'));
  const store = new Store(join(directory, 'story.sqlite'));
  owned.push({ store, directory });
  const bot = store.product.content(fixtureBotInput('Harbor keeper')) as Content;
  const chat = importChatTranscript(
    store,
    {
      idempotencyKey: randomUUID(),
      transcript: {
        format: 'uimori-chat-transcript',
        version: 2,
        exportedAt: new Date().toISOString(),
        title: 'Harbor story',
        packageAttachments: [{ id: bot.id, revision: bot.revision, role: 'bot' }],
        notes: [],
        entries: [{ request: 'Arrive.', text: 'The harbor bell rang once.', translation: null }],
      },
    },
    'library'
  ).chat;
  const model = selectFixtureModels(store) as ModelPreset;
  return { store, chat: store.chat(chat.id), model };
}

test('options.fix saves chat option values that later reads report as fixed', async () => {
  const { store, chat } = fixture();
  const options = new ChatOptionsStore(store);
  const state = options.get(chat.id);
  const control = state.controls!.find(
    (item) => item.type === 'boolean' || (item.options?.length ?? 0) > 1
  )!;
  const value =
    control.type === 'boolean'
      ? !control.default
      : control.options!.find((option) => option.value !== control.default)!.value;
  const fix = {
    expectedRevision: state.revision,
    binding: state.binding as unknown as Json,
    values: { [control.id]: value } as Json,
  };
  const run = await runScriptedChatHelper(store, chat.id, [
    helperCall('fix', 'options.fix', fix),
    helperCall('stale', 'options.fix', fix),
    helperDone,
  ]);
  expect(options.get(chat.id).fixedValues).toEqual({ [control.id]: value });
  expect(options.get(chat.id).pending).toEqual([]);
  expect(run.finished('stale')).toMatchObject({ denied: true });
  expect(run.results).toEqual([
    expect.objectContaining({
      operation: 'options.fix',
      targets: [expect.objectContaining({ kind: 'settings', setting: 'chat.options' })],
    }),
  ]);
});

test('options.fix set and unset change only the named options and keep the other fixed values', async () => {
  const { store, chat } = fixture();
  const options = new ChatOptionsStore(store);
  const state = options.get(chat.id);
  const changeable = state.controls!.filter(
    (item) => item.type === 'boolean' || (item.options?.length ?? 0) > 1
  );
  expect(changeable.length).toBeGreaterThanOrEqual(2);
  const other = (control: (typeof changeable)[number]) =>
    control.type === 'boolean'
      ? !control.default
      : control.options!.find((option) => option.value !== control.default)!.value;
  const [first, second] = changeable;
  await runScriptedChatHelper(store, chat.id, [
    helperCall('both', 'options.fix', {
      expectedRevision: state.revision,
      binding: state.binding as unknown as Json,
      values: { [first!.id]: other(first!), [second!.id]: other(second!) } as Json,
    }),
    helperDone,
  ]);
  const fixed = options.get(chat.id);
  const run = await runScriptedChatHelper(store, chat.id, [
    helperCall('unknown', 'options.fix', {
      expectedRevision: fixed.revision,
      binding: fixed.binding as unknown as Json,
      unset: ['absent-option'],
    }),
    helperCall('ambiguous', 'options.fix', {
      expectedRevision: fixed.revision,
      binding: fixed.binding as unknown as Json,
      unset: [second!.id],
      set: { [second!.id]: other(second!) } as Json,
    }),
    helperCall('unset', 'options.fix', {
      expectedRevision: fixed.revision,
      binding: fixed.binding as unknown as Json,
      unset: [first!.id],
    }),
    helperCall('mixed', 'options.fix', {
      expectedRevision: fixed.revision + 1,
      binding: fixed.binding as unknown as Json,
      values: {},
      set: {},
    }),
    helperDone,
  ]);
  expect(options.get(chat.id).fixedValues).toEqual({ [second!.id]: other(second!) });
  for (const call of ['unknown', 'ambiguous', 'mixed'])
    expect(run.finished(call)).toMatchObject({ denied: true });
  const read = output(run, 'unset') as { definitions?: unknown; controls?: unknown };
  expect(read.definitions).toBeDefined();
  expect(read).not.toHaveProperty('controls');
});

test('settings.update saves several settings of one group together or none of them', async () => {
  const { store, chat } = fixture();
  const revision = store.chat(chat.id).settingsRevision;
  const run = await runScriptedChatHelper(store, chat.id, [
    helperCall('mismatch', 'settings.update', {
      updates: [
        { setting: 'chat.storyUi', expectedRevision: revision, value: true },
        { setting: 'chat.maxCalls', expectedRevision: revision + 5, value: 3 },
      ],
    }),
    helperCall('invalid', 'settings.update', {
      updates: [
        { setting: 'chat.storyUi', expectedRevision: revision, value: true },
        { setting: 'chat.maxCalls', expectedRevision: revision, value: 0 },
      ],
    }),
    helperCall('batch', 'settings.update', {
      updates: [
        { setting: 'chat.storyUi', expectedRevision: revision, value: true },
        { setting: 'chat.storyUiStyle', expectedRevision: revision, value: 'modern' },
        { setting: 'chat.maxCalls', expectedRevision: revision, value: 3 },
      ],
    }),
    helperDone,
  ]);
  expect(run.finished('mismatch')).toMatchObject({ denied: true });
  expect(run.finished('invalid')).toMatchObject({ denied: true });
  expect(store.chat(chat.id).settings).toMatchObject({
    storyUi: true,
    storyUiStyle: 'modern',
    maxCalls: 3,
  });
  expect(store.chat(chat.id).settingsRevision).toBe(revision + 3);
  expect(output(run, 'batch')).toMatchObject({
    updates: [
      { setting: 'chat.storyUi', value: true },
      { setting: 'chat.storyUiStyle', value: 'modern' },
      { setting: 'chat.maxCalls', revision: revision + 3, value: 3 },
    ],
  });
  expect(run.results).toEqual([
    expect.objectContaining({ operation: 'settings.update', changedTargets: 3 }),
  ]);
});

test('library.organize renames and removes a folder without deleting its items', async () => {
  const { store, chat } = fixture();
  const bot = store.product.content(fixtureBotInput('Filed bot')) as Content;
  const created = store.libraryOrganization.createFolder({
    expectedRevision: store.libraryOrganization.snapshot().revision,
    category: 'bot',
    title: 'Old name',
  });
  const folderId = created.folders.find((folder) => folder.title === 'Old name')!.id;
  store.libraryOrganization.move({
    expectedRevision: store.libraryOrganization.snapshot().revision,
    category: 'bot',
    items: [{ kind: 'content', id: bot.id }],
    folderId,
  });
  const revision = store.libraryOrganization.snapshot().revision;
  const run = await runScriptedChatHelper(store, chat.id, [
    helperCall('wrong-category', 'library.organize', {
      action: 'delete-folder',
      body: { expectedRevision: revision, category: 'module', folderId },
    }),
    helperCall('rename', 'library.organize', {
      action: 'update-folder',
      body: { expectedRevision: revision, category: 'bot', folderId, title: 'New name' },
    }),
    helperCall('remove', 'library.organize', {
      action: 'delete-folder',
      body: { expectedRevision: revision + 1, category: 'bot', folderId },
    }),
    helperDone,
  ]);
  expect(run.finished('wrong-category')).toMatchObject({ denied: true });
  expect(run.finished('rename')).toMatchObject({ denied: false });
  expect(run.finished('remove')).toMatchObject({ denied: false });
  expect(store.libraryOrganization.snapshot().folders.some((f) => f.id === folderId)).toBe(false);
  expect(store.product.stored<Content>('content', bot.id).title).toBe('Filed bot');
});

test('scene.title names a scene and refuses a stale expected name', async () => {
  const { store, chat } = fixture();
  const sourceId = chat.headRevision!;
  const run = await runScriptedChatHelper(store, chat.id, [
    helperCall('name', 'scene.title', { sourceId, title: ' 종소리 ', expectedTitle: '' }),
    helperCall('stale', 'scene.title', { sourceId, title: '안개', expectedTitle: '' }),
    helperCall('outside', 'scene.title', { sourceId: 'missing', title: '안개', expectedTitle: '' }),
    helperDone,
  ]);
  expect(sceneTitle(store, sourceId)).toBe('종소리');
  expect(run.finished('stale')).toMatchObject({ denied: true, errorCode: 'REVISION_CONFLICT' });
  expect(run.finished('outside')).toMatchObject({ denied: true, errorCode: 'SCENE_NOT_IN_CHAT' });
  expect(run.results).toEqual([
    expect.objectContaining({
      operation: 'scene.title',
      targets: [{ kind: 'scene', id: sourceId, chatId: chat.id, title: '종소리', revision: 1 }],
    }),
  ]);
});

test('option tools refuse what their schema does not name and write nothing', async () => {
  const { store, chat } = fixture();
  const options = new ChatOptionsStore(store);
  const state = options.get(chat.id);
  const control = state.controls!.find(
    (item) => item.type === 'boolean' || (item.options?.length ?? 0) > 1
  )!;
  const base = {
    expectedRevision: state.revision,
    binding: state.binding as unknown as Json,
  };
  const value =
    control.type === 'boolean'
      ? !control.default
      : control.options!.find((option) => option.value !== control.default)!.value;
  const values = { [control.id]: value } as Json;
  const run = await runScriptedChatHelper(store, chat.id, [
    helperCall('chat-id', 'options.fix', { ...base, values, chatId: 'another-chat' }),
    helperCall('operation-id', 'options.fix', { ...base, values, operationId: 'forced' }),
    helperCall('set-null', 'options.fix', { ...base, set: null }),
    helperCall('unset-null', 'options.fix', { ...base, unset: null }),
    helperCall('oneoff-chat-id', 'options.oneoff', { ...base, values, chatId: 'another-chat' }),
    helperDone,
  ]);
  for (const call of ['chat-id', 'operation-id', 'set-null', 'unset-null', 'oneoff-chat-id'])
    expect(run.finished(call), call).toMatchObject({ denied: true });
  expect(options.get(chat.id)).toMatchObject({ revision: state.revision, pending: [] });
  expect(run.results).toEqual([]);
});

test('options.fix refuses a values object whose key the parser would drop and keeps the fixed options', async () => {
  const { store, chat } = fixture();
  const options = new ChatOptionsStore(store);
  const state = options.get(chat.id);
  const control = state.controls!.find(
    (item) => item.type === 'boolean' || (item.options?.length ?? 0) > 1
  )!;
  const value =
    control.type === 'boolean'
      ? !control.default
      : control.options!.find((option) => option.value !== control.default)!.value;
  await runScriptedChatHelper(store, chat.id, [
    helperCall('fix', 'options.fix', {
      expectedRevision: state.revision,
      binding: state.binding as unknown as Json,
      values: { [control.id]: value } as Json,
    }),
    helperDone,
  ]);
  const fixed = options.get(chat.id);
  expect(fixed.fixedValues).toEqual({ [control.id]: value });
  const unsafe = (key: string) => JSON.parse(`{"${key}":"x"}`) as Json;
  const run = await runScriptedChatHelper(store, chat.id, [
    ...['__proto__', 'constructor', 'prototype'].map((key) =>
      helperCall(`values-${key}`, 'options.fix', {
        expectedRevision: fixed.revision,
        binding: fixed.binding as unknown as Json,
        values: unsafe(key),
      })
    ),
    helperCall('set', 'options.fix', {
      expectedRevision: fixed.revision,
      binding: fixed.binding as unknown as Json,
      set: unsafe('__proto__'),
    }),
    helperDone,
  ]);
  for (const call of ['values-__proto__', 'values-constructor', 'values-prototype', 'set'])
    expect(run.finished(call), call).toMatchObject({ denied: true });
  expect(options.get(chat.id)).toMatchObject({
    revision: fixed.revision,
    fixedValues: { [control.id]: value },
  });
});

test('options.fix patches refuse to run empty or against a changed definition and keep the fixed options', async () => {
  const { store, chat } = fixture();
  const options = new ChatOptionsStore(store);
  const state = options.get(chat.id);
  const changeable = state.controls!.filter(
    (item) => item.type === 'boolean' || (item.options?.length ?? 0) > 1
  );
  const other = (control: (typeof changeable)[number]) =>
    control.type === 'boolean'
      ? !control.default
      : control.options!.find((option) => option.value !== control.default)!.value;
  const [first, second] = changeable;
  await runScriptedChatHelper(store, chat.id, [
    helperCall('fix', 'options.fix', {
      expectedRevision: state.revision,
      binding: state.binding as unknown as Json,
      values: { [first!.id]: other(first!), [second!.id]: other(second!) } as Json,
    }),
    helperDone,
  ]);
  const stored = () =>
    String(
      store.db.prepare('SELECT body FROM chat_prompt_options WHERE chat_id=?').get(chat.id)!.body
    );
  store.db
    .prepare(
      "UPDATE chat_prompt_options SET body=json_set(body,'$.binding.definitionHash',?) WHERE chat_id=?"
    )
    .run('a'.repeat(64), chat.id);
  const before = stored();
  const changed = options.get(chat.id);
  expect(changed.conflicts).toContain('fixed_definition_changed');
  const request = {
    expectedRevision: changed.revision,
    binding: changed.binding as unknown as Json,
  };
  const run = await runScriptedChatHelper(store, chat.id, [
    helperCall('empty-set', 'options.fix', { ...request, set: {} }),
    helperCall('empty-unset', 'options.fix', { ...request, unset: [] }),
    helperCall('set', 'options.fix', { ...request, set: { [first!.id]: other(first!) } as Json }),
    helperCall('unset', 'options.fix', { ...request, unset: [first!.id] }),
    helperDone,
  ]);
  for (const call of ['empty-set', 'empty-unset', 'set', 'unset'])
    expect(run.finished(call), call).toMatchObject({ denied: true });
  expect(stored()).toBe(before);
});

test('options.read refuses input that is not an empty object', () => {
  const { store, chat } = fixture();
  const task = { id: 'task', snapshot: { scope: { kind: 'chat', chatId: chat.id } } } as HelperTask;
  for (const input of [null, [], 123, '', { chatId: 'another-chat' }])
    expect(() => invokeHelperOptions(store, task, 'options.read', input, 'read')).toThrow(
      'INVALID_REQUEST'
    );
  expect(invokeHelperOptions(store, task, 'options.read', {}, 'read')).toMatchObject({
    chatId: chat.id,
  });
});

test('options.fix on a chat deleted underneath the task answers REVISION_CONFLICT', () => {
  const { store, chat } = fixture();
  const state = new ChatOptionsStore(store).get(chat.id);
  const task = { id: 'task', snapshot: { scope: { kind: 'chat', chatId: chat.id } } } as HelperTask;
  vi.spyOn(HelperWorkspace.prototype, 'assertRunning').mockReturnValue(undefined as never);
  deleteChat(store, chat.id);
  expect(() =>
    invokeHelperOptions(
      store,
      task,
      'options.fix',
      { expectedRevision: state.revision, binding: state.binding, values: {} },
      'fix'
    )
  ).toThrow('REVISION_CONFLICT');
});

test('model.parameters.update changes supported parameters and keeps pricing', async () => {
  const { store, chat, model } = fixture();
  const pricing = {
    mode: 'manual' as const,
    rates: { input: 2, output: 8, cacheRead: 0, cacheWrite: null },
    sourceUrl: 'https://example.com/official-prices',
    checkedAt: '2026-10-18',
  };
  const priced = store.product.save(
    'model',
    { ...model, pricing },
    model.id,
    model.revision
  ) as ModelPreset;
  const run = await runScriptedChatHelper(store, chat.id, [
    helperCall('unsupported', 'model.parameters.update', {
      modelId: priced.id,
      expectedRevision: priced.revision,
      changes: { topP: 0.9 },
    }),
    helperCall('change', 'model.parameters.update', {
      modelId: priced.id,
      expectedRevision: priced.revision,
      changes: { temperature: 0.7, thinkingLevel: 'LOW' },
    }),
    helperCall('remove', 'model.parameters.update', {
      modelId: priced.id,
      expectedRevision: priced.revision + 1,
      changes: { thinkingLevel: null },
    }),
    helperDone,
  ]);
  const saved = store.product.stored<ModelPreset>('model', priced.id);
  expect(saved).toMatchObject({
    revision: priced.revision + 2,
    title: priced.title,
    connectionId: priced.connectionId,
    maxOutputTokens: 1024,
    temperature: 0.7,
    pricing,
  });
  expect(saved).not.toHaveProperty('thinkingLevel');
  expect(run.finished('unsupported')).toMatchObject({
    denied: true,
    errorCode: 'MODEL_PARAMETER_UNSUPPORTED',
  });
  expect(run.results.map((item) => [item.operation, item.changedTargets])).toEqual([
    ['model.parameters.update', 1],
    ['model.parameters.update', 1],
  ]);
});

function output(run: { requests: { input: Record<string, unknown> }[] }, callId: string) {
  return run.requests
    .flatMap((request) => (request.input.results ?? []) as { callId: string; result: unknown }[])
    .find((event) => event.callId === callId)?.result as Record<string, unknown> | undefined;
}

function libraryContent(store: Store, kind: 'persona' | 'module', title: string) {
  return store.product.content({
    ...fixtureBotInput(title),
    kind,
    package: nativeContent({ name: title, description: title }, {}, kind),
  }) as Content;
}

test('chat.profile.update attaches a persona and modules, keeps the bot and records the earlier author note', async () => {
  const { store, chat } = fixture();
  const persona = libraryContent(store, 'persona', 'Reader');
  const weather = libraryContent(store, 'module', 'Weather');
  const initial = store.product.profile(chat.id);
  store.product.updateProfile(chat.id, {
    expectedRevision: initial.revision,
    image: initial.image,
    authorNote: 'Owner wrote this first.',
  });
  const before = store.product.profile(chat.id);
  const botId = before.packageAttachments!.find((ref) => ref.role === 'bot')!.id;
  const run = await runScriptedChatHelper(store, chat.id, [
    helperCall('first-note', 'chat.profile.update', {
      expectedRevision: before.revision,
      authorNote: 'Keep the harbor quiet.',
    }),
    helperCall('attach', 'chat.profile.update', {
      expectedRevision: before.revision + 1,
      persona: persona.id,
      modules: [weather.id],
      authorNote: 'Keep the harbor loud.',
    }),
    helperCall('wrong-kind', 'chat.profile.update', {
      expectedRevision: before.revision + 2,
      modules: [botId],
    }),
    helperCall('stale', 'chat.profile.update', {
      expectedRevision: before.revision,
      persona: null,
    }),
    helperCall('read', 'chat.profile.read', {}),
    helperCall('same', 'chat.profile.update', {
      expectedRevision: before.revision + 2,
      authorNote: 'Keep the harbor loud.',
    }),
    helperDone,
  ]);
  const profile = store.product.profile(chat.id);
  expect(profile.revision).toBe(before.revision + 2);
  expect(profile.packageAttachments?.map((ref) => `${ref.role}:${ref.id}`)).toEqual([
    `bot:${botId}`,
    `persona:${persona.id}`,
    `module:${weather.id}`,
  ]);
  expect(profile.authorNote).toBe('Keep the harbor loud.');
  expect(run.finished('wrong-kind')).toMatchObject({ denied: true, errorCode: 'NOT_A_MODULE' });
  expect(run.finished('stale')).toMatchObject({ denied: true });
  expect(output(run, 'read')).toMatchObject({
    profileRevision: profile.revision,
    bot: { id: botId },
    persona: { id: persona.id, title: 'Reader' },
    modules: [{ id: weather.id, title: 'Weather' }],
    authorNote: 'Keep the harbor loud.',
  });
  expect(run.results[1]).toMatchObject({
    operation: 'chat.profile.update',
    targets: [
      expect.objectContaining({ kind: 'settings', setting: 'chat.attachments' }),
      expect.objectContaining({ kind: 'settings', setting: 'chat.authorNote', id: chat.id }),
    ],
  });
});

test('chat.profile.update checks the revision first and keeps a deleted module the chat holds', async () => {
  const { store, chat } = fixture();
  const held = libraryContent(store, 'module', 'Held weather');
  const added = libraryContent(store, 'module', 'Added tides');
  const initial = store.product.profile(chat.id);
  store.product.updateProfile(chat.id, {
    expectedRevision: initial.revision,
    image: initial.image,
    packageAttachments: [
      ...initial.packageAttachments!,
      { id: held.id, revision: held.revision, role: 'module' },
    ],
  });
  softDeleteLibraryItem(store, 'content', held);
  softDeleteLibraryItem(store, 'content', added);
  const before = store.product.profile(chat.id);
  const run = await runScriptedChatHelper(store, chat.id, [
    helperCall('stale', 'chat.profile.update', {
      expectedRevision: before.revision - 1,
      modules: [added.id],
    }),
    helperCall('add-deleted', 'chat.profile.update', {
      expectedRevision: before.revision,
      modules: [held.id, added.id],
    }),
    helperCall('keep-held', 'chat.profile.update', {
      expectedRevision: before.revision,
      modules: [held.id],
      authorNote: 'Keep the tide table.',
    }),
    helperDone,
  ]);
  expect(run.finished('stale')).toMatchObject({ errorCode: 'REVISION_CONFLICT' });
  expect(run.finished('add-deleted')).toMatchObject({ errorCode: 'LIBRARY_ITEM_DELETED' });
  expect(run.finished('keep-held')).not.toMatchObject({ denied: true });
  const profile = store.product.profile(chat.id);
  expect(profile.revision).toBe(before.revision + 1);
  expect(profile.authorNote).toBe('Keep the tide table.');
  expect(profile.packageAttachments!.map((ref) => `${ref.role}:${ref.id}`)).toEqual(
    before.packageAttachments!.map((ref) => `${ref.role}:${ref.id}`)
  );
});

test('scene.context.update hides a scene, replaces its request and reports the new context revision', async () => {
  const { store, chat } = fixture();
  const sourceId = chat.headRevision!;
  const sceneUpdated = vi.fn();
  const run = await runScriptedChatHelper(
    store,
    chat.id,
    [
      helperCall('hide', 'scene.context.update', {
        sourceId,
        expectedRevision: 0,
        sceneEnabled: false,
        requestText: 'Arrive quietly.',
      }),
      helperCall('stale', 'scene.context.update', {
        sourceId,
        expectedRevision: 0,
        requestEnabled: false,
      }),
      helperCall('read', 'chat.read', {}),
      helperDone,
    ],
    { sceneUpdated }
  );
  expect(readSceneContext(store.db, sourceId)).toEqual({
    revision: 1,
    requestText: 'Arrive quietly.',
    requestEnabled: true,
    sceneEnabled: false,
  });
  expect(run.finished('stale')).toMatchObject({ denied: true });
  expect(run.results).toMatchObject([
    {
      operation: 'scene.context.update',
      targets: [{ kind: 'scene', id: sourceId, setting: 'scene.context' }],
    },
  ]);
  expect(sceneUpdated).toHaveBeenCalledWith(sourceId);
  expect((output(run, 'read') as { messages: unknown[] }).messages).toEqual([
    expect.objectContaining({
      id: sourceId,
      sceneEnabled: false,
      requestEnabled: true,
      contextRevision: 1,
    }),
  ]);
});

test('chat.bookmark adds, renames and deletes bookmarks of the selected chat only', async () => {
  const { store, chat } = fixture();
  const sourceId = chat.headRevision!;
  const first = await runScriptedChatHelper(store, chat.id, [
    helperCall('add', 'chat.bookmark', { action: 'add', sourceId, title: 'Bell', note: 'Once.' }),
    helperCall('read', 'chat.bookmark', { action: 'read' }),
    helperDone,
  ]);
  const [bookmark] = listBookmarks(store, chat.id);
  expect(bookmark).toMatchObject({
    title: 'Bell',
    note: 'Once.',
    target: { chatId: chat.id, sourceId, representation: 'original' },
  });
  expect(output(first, 'read')).toMatchObject({
    bookmarks: [{ id: bookmark!.id, title: 'Bell', sourceId }],
  });
  const second = await runScriptedChatHelper(store, chat.id, [
    helperCall('rename', 'chat.bookmark', {
      action: 'update',
      id: bookmark!.id,
      expectedRevision: bookmark!.revision,
      title: 'First bell',
    }),
    helperCall('missing', 'chat.bookmark', {
      action: 'delete',
      id: '00000000-0000-0000-0000-000000000000',
      expectedRevision: 1,
    }),
    helperCall('delete', 'chat.bookmark', {
      action: 'delete',
      id: bookmark!.id,
      expectedRevision: bookmark!.revision + 1,
    }),
    helperDone,
  ]);
  expect(second.finished('rename')).toMatchObject({ denied: false });
  expect(second.results.map((result) => result.targets[0]?.setting)).toEqual([
    'chat.bookmark',
    'chat.bookmark',
  ]);
  expect(second.finished('missing')).toMatchObject({
    denied: true,
    errorCode: 'BOOKMARK_NOT_FOUND',
  });
  expect(listBookmarks(store, chat.id)).toEqual([]);
});

test('chat.organize files a chat into a folder, sets the default persona and unfiles chats of a deleted folder', async () => {
  const { store, chat } = fixture();
  const persona = libraryContent(store, 'persona', 'Reader');
  const botId = store.organization.metadata(chat.id)!.botId;
  const created = await runScriptedChatHelper(store, chat.id, [
    helperCall('folder', 'chat.organize', {
      action: 'create-folder',
      botId,
      title: 'Harbor arc',
      defaultPersona: persona.id,
    }),
    helperDone,
  ]);
  const [folder] = store.organization.folders(botId);
  expect(folder).toMatchObject({
    title: 'Harbor arc',
    defaultPersona: { id: persona.id, revision: persona.revision },
  });
  expect(created.results[0]).toMatchObject({
    operation: 'chat.organize',
    targets: [expect.objectContaining({ kind: 'content', id: botId })],
  });
  const organization = store.organization.metadata(chat.id)!;
  const defaults = store.organization.defaults(botId);
  const changed = vi.fn();
  const moved = await runScriptedChatHelper(
    store,
    chat.id,
    [
      helperCall('move', 'chat.organize', {
        action: 'move',
        botId,
        chatId: chat.id,
        expectedRevision: organization.organizationRevision,
        folderId: folder!.id,
      }),
      helperCall('persona', 'chat.organize', {
        action: 'set-default-persona',
        botId,
        expectedRevision: defaults.revision,
        persona: persona.id,
      }),
      helperCall('not-persona', 'chat.organize', {
        action: 'set-default-persona',
        botId,
        expectedRevision: defaults.revision + 1,
        persona: botId,
      }),
      helperCall('read', 'chat.organize', { action: 'read', botId }),
      helperCall('delete', 'chat.organize', {
        action: 'delete-folder',
        botId,
        folderId: folder!.id,
        expectedRevision: folder!.revision,
      }),
      helperDone,
    ],
    { chatChanged: changed }
  );
  expect(output(moved, 'read')).toMatchObject({
    defaults: { persona: { mode: 'persona', id: persona.id, title: 'Reader' } },
    folders: [{ id: folder!.id, title: 'Harbor arc' }],
    chats: [{ id: chat.id, folderId: folder!.id }],
  });
  expect(moved.finished('not-persona')).toMatchObject({ denied: true, errorCode: 'NOT_A_PERSONA' });
  expect(store.organization.metadata(chat.id)!.folderId).toBeNull();
  expect(store.organization.folders(botId)).toEqual([]);
  expect(store.chats().map((item) => item.id)).toContain(chat.id);
  expect(changed).toHaveBeenCalledWith(chat.id);
});

test('chat.organize checks the folder and defaults revisions before the persona it names', async () => {
  const { store, chat } = fixture();
  const persona = libraryContent(store, 'persona', 'Reader');
  const botId = store.organization.metadata(chat.id)!.botId;
  const folder = store.organization.createFolder({ botId: botId, title: 'Harbor arc' });
  const defaults = store.organization.defaults(botId);
  softDeleteLibraryItem(store, 'content', persona);
  const run = await runScriptedChatHelper(store, chat.id, [
    helperCall('folder', 'chat.organize', {
      action: 'update-folder',
      botId,
      folderId: folder.id,
      expectedRevision: folder.revision + 1,
      defaultPersona: persona.id,
    }),
    helperCall('defaults', 'chat.organize', {
      action: 'set-default-persona',
      botId,
      expectedRevision: defaults.revision + 1,
      persona: persona.id,
    }),
    helperDone,
  ]);
  expect(run.finished('folder')).toMatchObject({ errorCode: 'REVISION_CONFLICT' });
  expect(run.finished('defaults')).toMatchObject({ errorCode: 'REVISION_CONFLICT' });
});

test('chat.organize checks revisions before the persona kind and treats a hidden persona as deleted', async () => {
  const { store, chat } = fixture();
  const hidden = libraryContent(store, 'persona', 'Hidden reader');
  const module = libraryContent(store, 'module', 'Weather');
  const botId = store.organization.metadata(chat.id)!.botId;
  const folder = store.organization.createFolder({ botId, title: 'Harbor arc' });
  const defaults = store.organization.defaults(botId);
  softDeleteLibraryItem(store, 'content', hidden);
  const run = await runScriptedChatHelper(store, chat.id, [
    helperCall('stale-folder', 'chat.organize', {
      action: 'update-folder',
      botId,
      folderId: folder.id,
      expectedRevision: folder.revision + 1,
      defaultPersona: module.id,
    }),
    helperCall('stale-defaults', 'chat.organize', {
      action: 'set-default-persona',
      botId,
      expectedRevision: defaults.revision + 1,
      persona: module.id,
    }),
    helperCall('hidden', 'chat.organize', {
      action: 'create-folder',
      botId,
      title: 'Hidden default',
      defaultPersona: hidden.id,
    }),
    helperCall('module', 'chat.organize', {
      action: 'update-folder',
      botId,
      folderId: folder.id,
      expectedRevision: folder.revision,
      defaultPersona: module.id,
    }),
    helperDone,
  ]);
  expect(run.finished('stale-folder')).toMatchObject({ errorCode: 'REVISION_CONFLICT' });
  expect(run.finished('stale-defaults')).toMatchObject({ errorCode: 'REVISION_CONFLICT' });
  expect(run.finished('hidden')).toMatchObject({ errorCode: 'LIBRARY_ITEM_DELETED' });
  expect(run.finished('module')).toMatchObject({ errorCode: 'NOT_A_PERSONA' });
  expect(store.organization.folders(botId)).toEqual([folder]);
  expect(store.organization.defaults(botId)).toEqual(defaults);
});

test('chat.organize answers a deleted chat as a conflict and a chat of another bot by name', async () => {
  const { store, chat } = fixture();
  const botId = store.organization.metadata(chat.id)!.botId;
  const gone = createFixtureChat(store, 'Gone', { botId });
  deleteChat(store, gone.id);
  const foreign = createFixtureChat(store, 'Elsewhere');
  const run = await runScriptedChatHelper(store, chat.id, [
    helperCall('pin-gone', 'chat.organize', {
      action: 'pin',
      botId,
      chatId: gone.id,
      pinned: true,
    }),
    helperCall('move-gone', 'chat.organize', {
      action: 'move',
      botId,
      chatId: gone.id,
      expectedRevision: 1,
      folderId: null,
    }),
    helperCall('pin-foreign', 'chat.organize', {
      action: 'pin',
      botId,
      chatId: foreign.id,
      pinned: true,
    }),
    helperDone,
  ]);
  expect(run.finished('pin-gone')).toMatchObject({ errorCode: 'REVISION_CONFLICT' });
  expect(run.finished('move-gone')).toMatchObject({ errorCode: 'REVISION_CONFLICT' });
  expect(run.finished('pin-foreign')).toMatchObject({ errorCode: 'CHAT_OF_ANOTHER_BOT' });
});

test('model.parameters.update tells a stale or deleted target to refresh before checking changes', () => {
  const { store, model } = fixture();
  const conflict = expect.objectContaining({ statusCode: 409, message: 'REVISION_CONFLICT' });
  expect(() =>
    invokeHelperModelParameterTool(store, 'model.parameters.update', {
      modelId: model.id,
      expectedRevision: model.revision + 1,
      changes: { topP: 0.9 },
    })
  ).toThrow(conflict);
  deleteLibraryItem(store, 'model', model.id, { expectedRevision: model.revision });
  expect(() =>
    invokeHelperModelParameterTool(store, 'model.parameters.update', {
      modelId: model.id,
      expectedRevision: model.revision,
      changes: { temperature: 0.7 },
    })
  ).toThrow(conflict);
});
