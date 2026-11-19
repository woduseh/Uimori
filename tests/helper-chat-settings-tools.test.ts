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
import { fixtureBotInput } from './fixtures/chat.js';
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
  expect(run.finished('stale')).toMatchObject({ denied: true, errorCode: 'SOURCE_CONFLICT' });
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
  const saved = store.product.get<ModelPreset>('model', priced.id);
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
