import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { Content } from '../core/product.js';
import { importChatTranscript } from '../server/chat-transcript.js';
import { readChatVariables, writeChatVariables } from '../server/chat-variables.js';
import { readHelperChatState } from '../server/helper-chat-state-tools.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import * as nativeRuntime from '../server/risu-native-runtime.js';
import { Store } from '../server/store.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { helperCall, helperDone, runScriptedChatHelper } from './fixtures/scripted-helper.js';

const owned: { store: Store; directory: string }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await nativeRuntime.disposeAllNativeRisuSessions();
  for (const { store, directory } of owned.splice(0)) {
    store.close();
    const inside = relative(resolve(tmpdir()), resolve(directory));
    if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('uimori-chat-state-'))
      throw new Error('Unsafe cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-chat-state-'));
  const store = new Store(join(directory, 'story.sqlite'));
  owned.push({ store, directory });
  const input = fixtureBotInput('Harbor keeper', 'Synthetic bot body');
  input.package.nativeRisu.card.character_book = {
    entries: [
      {
        id: 1,
        keys: ['harbor'],
        comment: 'Pinned harbor',
        content: 'PINNED_HARBOR_LORE',
        constant: true,
        enabled: true,
      },
    ],
  };
  input.package.nativeRisu.card.extensions = {
    risuai: { defaultVariables: `mood=calm\nscore=1\nlog=${'x'.repeat(400)}` },
  };
  const bot = store.product.content(input) as Content;
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
        entries: [
          { request: 'Arrive.', text: 'The harbor bell rang once.', translation: null },
          { request: 'Wait.', text: 'Fog rolled over the pier.', translation: null },
        ],
      },
    },
    'library'
  ).chat;
  const connection = store.product.connection({
    title: 'Synthetic connection',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = store.product.model({
    title: 'Synthetic model',
    connectionId: connection.id,
    modelId: 'fixture',
    temperature: null,
    maxOutputTokens: 1024,
    inputTokenLimit: 64_000,
  });
  const selected = modelWorkspace(store);
  updateModelWorkspace(store, {
    expectedRevision: selected.revision,
    routes: { ...selected.routes, main: { id: model.id } },
    translationPolicy: selected.translationPolicy,
    helperModel: { id: model.id },
  });
  return { store, chat: store.chat(chat.id) };
}

const changes = (store: Store) =>
  Number(store.db.prepare('SELECT total_changes() AS count').get()!.count);

test('chat.preview lists, searches and pages the assembled next request without writing', async () => {
  const { store, chat } = fixture();
  const before = changes(store);
  const list = (await readHelperChatState(store, chat.id, 'chat.preview', {
    request: 'Ring the bell.',
  })) as Record<string, any>;
  expect(list.preview).toMatchObject({
    error: null,
    selected: { model: { title: 'Synthetic model' } },
    tokens: { inputTokenLimit: expect.any(Number), estimatedInputTokens: expect.any(Number) },
  });
  expect(list.promptHash).toMatch(/^[a-f0-9]{64}$/u);
  expect(list.messages).toHaveLength(20);
  expect(list.nextOffset).toBe(list.totalMessages > 20 ? 20 : null);
  expect(list.lore).toMatchObject({ enabled: expect.any(Boolean) });

  const history = (await readHelperChatState(store, chat.id, 'chat.preview', {
    request: 'Ring the bell.',
    contains: 'fog rolled over the pier',
  })) as Record<string, any>;
  expect(history.messages).toEqual([
    expect.objectContaining({ origin: 'history', sourceId: chat.headRevision }),
  ]);

  const found = (await readHelperChatState(store, chat.id, 'chat.preview', {
    request: 'Ring the bell.',
    contains: 'pinned_harbor_lore',
  })) as Record<string, any>;
  expect(found.total).toBeGreaterThan(0);
  const hit = found.messages[0];
  expect(hit.matchOffset).toBeGreaterThanOrEqual(0);

  const page = (await readHelperChatState(store, chat.id, 'chat.preview', {
    request: 'Ring the bell.',
    message: hit.index,
    textOffset: hit.matchOffset,
    textLimit: 18,
    expectedPromptHash: list.promptHash,
  })) as Record<string, any>;
  expect(page).toMatchObject({
    promptHash: list.promptHash,
    index: hit.index,
    text: 'PINNED_HARBOR_LORE',
    range: { start: hit.matchOffset, end: hit.matchOffset + 18 },
  });

  await expect(
    readHelperChatState(store, chat.id, 'chat.preview', {
      request: 'A different request.',
      message: hit.index,
      expectedPromptHash: list.promptHash,
    })
  ).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/^PREVIEW_CHANGED/u) });
  await expect(
    readHelperChatState(store, chat.id, 'chat.preview', { textLimit: 10 })
  ).rejects.toMatchObject({ statusCode: 400 });
  expect(changes(store)).toBe(before);
});

test('chat.variables.update answers REVISION_CONFLICT for an unchanged write on a stale revision or source', async () => {
  const { store, chat } = fixture();
  const sourceHash = store.source(chat.headRevision!).hash;
  writeChatVariables(store, chat.id, {
    expectedRevision: 0,
    expectedSourceHash: sourceHash,
    idempotencyKey: randomUUID(),
    values: { mood: 'tense' },
  });
  const { finished } = await runScriptedChatHelper(store, chat.id, [
    helperCall('stale-revision', 'chat.variables.update', {
      expectedRevision: 0,
      expectedSourceHash: sourceHash,
      set: { mood: 'tense' },
    }),
    helperCall('stale-source', 'chat.variables.update', {
      expectedRevision: 1,
      expectedSourceHash: 'a'.repeat(64),
      set: { mood: 'tense' },
    }),
    helperCall('empty', 'chat.variables.update', {
      expectedRevision: 1,
      expectedSourceHash: sourceHash,
    }),
    helperCall('unsafe', 'chat.variables.update', {
      expectedRevision: 1,
      expectedSourceHash: sourceHash,
      set: JSON.parse('{"__proto__":"x","mood":"calm"}'),
    }),
    helperCall('unsafe-unset', 'chat.variables.update', {
      expectedRevision: 1,
      expectedSourceHash: sourceHash,
      unset: ['__proto__', 'mood'],
    }),
    helperCall('extra', 'chat.variables.update', {
      expectedRevision: 1,
      expectedSourceHash: sourceHash,
      set: { mood: 'calm' },
      note: 'x',
    }),
    helperDone,
  ]);
  for (const call of ['stale-revision', 'stale-source'])
    expect(finished(call), call).toMatchObject({ denied: true, errorCode: 'REVISION_CONFLICT' });
  for (const call of ['empty', 'extra'])
    expect(finished(call), call).toMatchObject({ denied: true });
  expect(readChatVariables(store, chat.id).values).toEqual({ mood: 'tense' });
});

test('chat.variables.update merges changes with a receipt and rejects a stale read', async () => {
  const { store, chat } = fixture();
  const sourceHash = store.source(chat.headRevision!).hash;
  writeChatVariables(store, chat.id, {
    expectedRevision: 0,
    expectedSourceHash: sourceHash,
    idempotencyKey: randomUUID(),
    values: { mood: 'tense', quest: 'started' },
  });
  const chatChanged = vi.fn();
  const { finished, results } = await runScriptedChatHelper(
    store,
    chat.id,
    [
      helperCall('merge', 'chat.variables.update', {
        expectedRevision: 1,
        expectedSourceHash: sourceHash,
        set: { score: '5' },
        unset: ['mood'],
      }),
      helperCall('stale', 'chat.variables.update', {
        expectedRevision: 1,
        expectedSourceHash: sourceHash,
        set: { score: '6' },
      }),
      helperCall('same', 'chat.variables.update', {
        expectedRevision: 2,
        expectedSourceHash: sourceHash,
        set: { score: '5' },
      }),
      helperDone,
    ],
    { chatChanged }
  );

  expect(readChatVariables(store, chat.id)).toEqual({
    revision: 2,
    values: { quest: 'started', score: '5' },
  });
  expect(chatChanged).toHaveBeenCalledTimes(1);
  expect(chatChanged).toHaveBeenCalledWith(chat.id);
  expect(finished('merge')).toMatchObject({ denied: false });
  expect(finished('stale')).toMatchObject({
    denied: true,
    errorCode: 'REVISION_CONFLICT',
  });
  expect(finished('same')).toMatchObject({ denied: false });
  expect(results.map((item) => [item.operation, item.changedTargets])).toEqual([
    ['chat.variables.update', 1],
    ['chat.variables.update', 0],
  ]);
  expect(results[0]!.targets).toEqual([
    {
      kind: 'settings',
      id: chat.id,
      title: chat.title,
      revision: 2,
      setting: 'chat.variables',
    },
  ]);
});
