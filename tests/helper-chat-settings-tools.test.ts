import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { Content, ModelPreset } from '../core/product.js';
import type { Json } from '../core/transport.js';
import { ChatOptionsStore } from '../server/chat-options.js';
import { importChatTranscript } from '../server/chat-transcript.js';
import { sceneTitle } from '../server/scene-titles.js';
import { Store } from '../server/store.js';
import { deleteLibraryItem } from '../server/library-deletion.js';
import { invokeHelperModelParameterTool } from '../server/helper-model-parameter-tools.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { nativeContent } from './fixtures/native-content.js';
import { forgetHelperSceneChanges, readHelperChanges } from '../server/helper-changes.js';
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
  const chat = importChatTranscript(store, {
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
  }).chat;
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

test('chat.guide.update changes only the named settings and rejects invalid text', async () => {
  const { store, chat } = fixture();
  const before = store.storyGuide.get(chat.id);
  const run = await runScriptedChatHelper(store, chat.id, [
    helperCall('guide', 'chat.guide.update', {
      expectedRevision: before.revision,
      changes: { enabled: true, work: '항구 연대기 1권' },
    }),
    helperCall('invalid', 'chat.guide.update', {
      expectedRevision: before.revision + 1,
      changes: { work: 'x'.repeat(600) },
    }),
    helperDone,
  ]);
  expect(store.storyGuide.get(chat.id)).toMatchObject({
    revision: before.revision + 1,
    config: { ...before.config, enabled: true, work: '항구 연대기 1권' },
  });
  expect(run.finished('invalid')).toMatchObject({
    denied: true,
    errorCode: 'STORY_GUIDE_INVALID',
  });
  expect(run.results.map((item) => [item.operation, item.changedTargets])).toEqual([
    ['chat.guide.update', 1],
  ]);
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

function settingChange(store: Store, taskId: string, setting: string) {
  return readHelperChanges(store.db, taskId).find(
    (change) => JSON.stringify(change.location) === JSON.stringify({ kind: 'setting', setting })
  );
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
      expect.objectContaining({ kind: 'chat', id: chat.id }),
    ],
  });
  const note = settingChange(store, run.task.id, 'chat.authorNote');
  const removed = (note!.diff as { hunks: { segments: { op: string; text: string }[] }[] }).hunks
    .flatMap((hunk) => hunk.segments)
    .filter((segment) => segment.op === 'delete')
    .map((segment) => segment.text)
    .join(' ');
  expect(removed).toBe('Owner wrote this first.');
  expect(JSON.stringify(note?.diff)).toContain('loud');
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
  expect(sceneUpdated).toHaveBeenCalledWith(sourceId);
  expect((output(run, 'read') as { messages: unknown[] }).messages).toEqual([
    expect.objectContaining({
      id: sourceId,
      sceneEnabled: false,
      requestEnabled: true,
      contextRevision: 1,
    }),
  ]);
  const change = settingChange(store, run.task.id, 'scene.context');
  expect(JSON.stringify(change?.diff)).toContain('Arrive quietly.');
  forgetHelperSceneChanges(store.db, [sourceId]);
  expect(JSON.stringify(readHelperChanges(store.db, run.task.id))).not.toContain('Arrive quietly.');
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
  expect(JSON.stringify(settingChange(store, second.task.id, 'chat.bookmark')?.diff)).toContain(
    'Once.'
  );
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
