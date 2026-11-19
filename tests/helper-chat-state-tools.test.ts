import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { Content } from '../core/product.js';
import * as transport from '../core/transport.js';
import { importChatTranscript } from '../server/chat-transcript.js';
import { readChatVariables, writeChatVariables } from '../server/chat-variables.js';
import { readHelperChatState } from '../server/helper-chat-state-tools.js';
import { HelperRuntime } from '../server/helper-runtime.js';
import { readHelperTaskResults } from '../server/helper-task-results.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { ResponseStreamStore } from '../server/response-stream.js';
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
  const chat = importChatTranscript(store, {
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
  }).chat;
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

test('scene.lore reports missing records and rejects scenes outside the chat', async () => {
  const { store, chat } = fixture();
  await expect(readHelperChatState(store, chat.id, 'scene.lore', {})).resolves.toEqual({
    sourceId: chat.headRevision,
    attemptId: null,
    lore: null,
  });
  await expect(
    readHelperChatState(store, chat.id, 'scene.lore', { sourceId: 'missing-scene' })
  ).rejects.toMatchObject({
    statusCode: 404,
    message: expect.stringMatching(/^SCENE_NOT_IN_CHAT/u),
  });
});

test('chat.variables.read merges defaults with chat values and pages one long value', async () => {
  const { store, chat } = fixture();
  const sourceHash = store.source(chat.headRevision!).hash;
  writeChatVariables(store, chat.id, {
    expectedRevision: 0,
    expectedSourceHash: sourceHash,
    idempotencyKey: randomUUID(),
    values: { mood: 'tense', quest: 'started' },
  });
  const list = (await readHelperChatState(store, chat.id, 'chat.variables.read', {})) as Record<
    string,
    any
  >;
  expect(list).toMatchObject({ revision: 1, sourceHash, pending: false, nextOffset: null });
  expect(list.total).toBe(list.variables.length);
  const byName = Object.fromEntries(
    list.variables.map((item: { name: string }) => [item.name, item])
  );
  expect(byName.mood).toEqual({ name: 'mood', value: 'tense', overridden: true, default: 'calm' });
  expect(byName.quest).toEqual({ name: 'quest', value: 'started', overridden: true });
  expect(byName.score).toEqual({ name: 'score', value: '1', overridden: false, default: 'same' });
  expect(byName.log).toMatchObject({ valueLength: 400, overridden: false, default: 'same' });
  expect(byName.log.value.length).toBeLessThan(400);

  const log = (await readHelperChatState(store, chat.id, 'chat.variables.read', {
    name: 'log',
    textOffset: 390,
  })) as Record<string, any>;
  expect(log).toMatchObject({
    name: 'log',
    text: 'x'.repeat(10),
    totalChars: 400,
    nextOffset: null,
  });
  const filtered = (await readHelperChatState(store, chat.id, 'chat.variables.read', {
    query: 'MO',
  })) as Record<string, any>;
  expect(filtered.variables.map((item: { name: string }) => item.name)).toEqual(['mood']);
  await expect(
    readHelperChatState(store, chat.id, 'chat.variables.read', { name: 'unknown' })
  ).rejects.toMatchObject({ statusCode: 404 });
});

const completed: transport.ProviderResult = {
  status: 'completed',
  text: '변수를 고쳤어요.',
  toolCalls: [],
  refusal: null,
  error: null,
  usage: { inputTokens: 10, outputTokens: 4, costUsd: null, raw: null, priceRevision: null },
  opaqueState: null,
};
const update = (id: string, args: Record<string, unknown>): transport.ProviderResult => ({
  ...structuredClone(completed),
  status: 'tool_calls',
  toolCalls: [
    { id, name: 'app.call', arguments: { name: 'chat.variables.update', arguments: args } },
  ],
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
  const steps = [
    update('merge', {
      expectedRevision: 1,
      expectedSourceHash: sourceHash,
      set: { score: '5' },
      unset: ['mood'],
    }),
    update('stale', { expectedRevision: 1, expectedSourceHash: sourceHash, set: { score: '6' } }),
    update('same', { expectedRevision: 2, expectedSourceHash: sourceHash, set: { score: '5' } }),
    completed,
  ];
  let step = 0;
  vi.spyOn(transport, 'executeProvider').mockImplementation(
    async (connection, request, options) => {
      transport.validateConnection(connection);
      options.beforeTurn?.();
      await options.onWire?.({
        connectionId: connection.id,
        protocol: connection.protocol,
        role: request.role,
        modelId: request.modelId,
        method: 'POST',
        url: connection.endpoint,
        headers: {},
        body: request as unknown as transport.Json,
        bodySha256: 'synthetic',
        stablePrefixSha256: 'synthetic',
      });
      return structuredClone(steps[step++] ?? completed);
    }
  );
  const work: Promise<void>[] = [];
  const chatChanged = vi.fn();
  const runtime = new HelperRuntime(store, {
    owner: 'chat-state-test',
    signal: new AbortController().signal,
    track: (promise) => work.push(promise),
    streams: new ResponseStreamStore(store),
    services: { chatChanged },
  });
  const conversation = runtime.workspace.open({ kind: 'chat', chatId: chat.id });
  const task = runtime.enqueue(
    conversation.id,
    randomUUID(),
    '점수를 5로 바꾸고 기분은 기본값으로'
  );
  await Promise.all(work);
  expect(runtime.workspace.task(task.id).status).toBe('completed');

  expect(readChatVariables(store, chat.id)).toEqual({
    revision: 2,
    values: { quest: 'started', score: '5' },
  });
  expect(chatChanged).toHaveBeenCalledTimes(1);
  expect(chatChanged).toHaveBeenCalledWith(chat.id);
  const events = runtime.workspace.events(conversation.id);
  const finished = (callId: string) =>
    events.find(
      (event) =>
        event.kind === 'tool.finished' &&
        (event.data as { callId?: string } | null)?.callId === callId
    )?.data as Record<string, unknown>;
  expect(finished('merge')).toMatchObject({ denied: false });
  expect(finished('stale')).toMatchObject({
    denied: true,
    errorCode: 'CHAT_VARIABLE_REVISION_CONFLICT',
  });
  expect(finished('same')).toMatchObject({ denied: false });
  const results = readHelperTaskResults(store, task.id).results;
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
