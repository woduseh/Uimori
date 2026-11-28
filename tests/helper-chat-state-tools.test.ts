import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { Content } from '../core/product.js';
import { importChatTranscript } from '../server/chat-transcript.js';
import { readHelperChatState } from '../server/helper-chat-state-tools.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import * as nativeRuntime from '../server/risu-native-runtime.js';
import { Store } from '../server/store.js';
import { fixtureBotInput } from './fixtures/chat.js';

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
