import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { Content } from '../core/product.js';
import * as transport from '../core/transport.js';
import type { Chat, Job, Run } from '../core/types.js';
import { importChatTranscript } from '../server/chat-transcript.js';
import { HelperRuntime } from '../server/helper-runtime.js';
import { readHelperTaskResults } from '../server/helper-task-results.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { ResponseStreamStore } from '../server/response-stream.js';
import { Store } from '../server/store.js';
import { fixtureBotInput } from './fixtures/chat.js';

const owned: { store: Store; directory: string }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const { store, directory } of owned.splice(0)) {
    store.close();
    const inside = relative(resolve(tmpdir()), resolve(directory));
    if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('uimori-story-tools-'))
      throw new Error('Unsafe cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});

const completed: transport.ProviderResult = {
  status: 'completed',
  text: '요청했어요.',
  toolCalls: [],
  refusal: null,
  error: null,
  usage: { inputTokens: 10, outputTokens: 4, costUsd: null, raw: null, priceRevision: null },
  opaqueState: null,
};
const call = (
  id: string,
  name: string,
  args: Record<string, transport.Json>
): transport.ProviderResult => ({
  ...structuredClone(completed),
  status: 'tool_calls',
  toolCalls: [{ id, name: 'app.call', arguments: { name, arguments: args } }],
});

async function runHelper(steps: (chat: Chat) => transport.ProviderResult[]) {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-story-tools-'));
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
  });
  const selected = modelWorkspace(store);
  updateModelWorkspace(store, {
    expectedRevision: selected.revision,
    routes: { main: { id: model.id }, translation: { id: model.id } },
    translationPolicy: selected.translationPolicy,
    helperModel: { id: model.id },
  });
  const scripted = steps(store.chat(chat.id));
  let step = 0;
  vi.spyOn(transport, 'executeProvider').mockImplementation(async (target, request, options) => {
    transport.validateConnection(target);
    options.beforeTurn?.();
    await options.onWire?.({
      connectionId: target.id,
      protocol: target.protocol,
      role: request.role,
      modelId: request.modelId,
      method: 'POST',
      url: target.endpoint,
      headers: {},
      body: request as unknown as transport.Json,
      bodySha256: 'synthetic',
      stablePrefixSha256: 'synthetic',
    });
    return structuredClone(scripted[step++] ?? completed);
  });
  const started: ({ run: Run } | { job: Job })[] = [];
  const work: Promise<void>[] = [];
  const runtime = new HelperRuntime(store, {
    owner: 'story-tools-test',
    signal: new AbortController().signal,
    track: (promise) => work.push(promise),
    streams: new ResponseStreamStore(store),
    services: {
      story: {
        requireRunModel: () => {},
        requireTranslationModel: () => {},
        started: (item) => started.push(item),
      },
    },
  });
  const conversation = runtime.workspace.open({ kind: 'chat', chatId: chat.id });
  const task = runtime.enqueue(conversation.id, randomUUID(), '다음 장면 써줘');
  await Promise.all(work);
  expect(runtime.workspace.task(task.id).status).toBe('completed');
  const events = runtime.workspace.events(conversation.id);
  const finished = (callId: string) =>
    events.find(
      (event) =>
        event.kind === 'tool.finished' &&
        (event.data as { callId?: string } | null)?.callId === callId
    )?.data as Record<string, unknown>;
  return {
    store,
    chat: store.chat(chat.id),
    started,
    finished,
    results: readHelperTaskResults(store, task.id).results,
  };
}

test('scene.request queues one composer run and refuses a second request or a stale head', async () => {
  let head = '';
  const f = await runHelper((chat) => {
    head = chat.headRevision!;
    const args = {
      request: 'The fog lifts.',
      expectedHeadRevision: head,
      expectedSettingsRevision: chat.settingsRevision,
    };
    return [
      call('stale', 'scene.request', { ...args, expectedSettingsRevision: 99 }),
      call('first', 'scene.request', args),
      call('busy', 'scene.request', { ...args, request: 'Another scene.' }),
      completed,
    ];
  });
  const runs = f.store.db.prepare('SELECT id,status FROM runs WHERE chat_id=?').all(f.chat.id);
  const queued = runs.filter((row) => row.status === 'queued');
  expect(queued).toHaveLength(1);
  const run = f.store.run(String(queued[0]!.id));
  expect(run).toMatchObject({ request: 'The fog lifts.', parentRevision: head });
  expect(run.snapshot.history.at(-1)?.revision).toBe(head);
  expect(f.started).toEqual([{ run: expect.objectContaining({ id: run.id }) }]);
  expect(f.finished('first')).toMatchObject({ denied: false });
  expect(f.finished('busy')).toMatchObject({ denied: true, errorCode: 'SCENE_REQUEST_BUSY' });
  expect(f.finished('stale')).toMatchObject({ denied: true, errorCode: 'SOURCE_CONFLICT' });
  expect(f.results).toEqual([
    expect.objectContaining({
      operation: 'scene.request',
      changedTargets: 1,
      targets: [expect.objectContaining({ kind: 'chat', id: f.chat.id, title: f.chat.title })],
    }),
  ]);
});

test('scene.translate starts one translation, reuses it while pending and stays in the chat', async () => {
  let sourceId = '';
  const f = await runHelper((chat) => {
    sourceId = chat.headRevision!;
    return [
      call('translate', 'scene.translate', { sourceId }),
      call('again', 'scene.translate', { sourceId, retranslate: true }),
      call('outside', 'scene.translate', { sourceId: 'missing-scene' }),
      completed,
    ];
  });
  const jobs = f.store.db
    .prepare("SELECT id,status FROM jobs WHERE source_revision=? AND kind='translation'")
    .all(sourceId);
  expect(jobs).toEqual([{ id: expect.any(String), status: 'queued' }]);
  expect(f.started).toEqual([{ job: expect.objectContaining({ id: jobs[0]!.id }) }]);
  expect(f.finished('again')).toMatchObject({ denied: false });
  expect(f.finished('outside')).toMatchObject({ denied: true, errorCode: 'SCENE_NOT_IN_CHAT' });
  expect(f.results.map((item) => [item.operation, item.changedTargets])).toEqual([
    ['scene.translate', 1],
    ['scene.translate', 0],
  ]);
  expect(f.results[0]!.targets).toEqual([
    expect.objectContaining({ kind: 'translation', id: sourceId, chatId: f.chat.id }),
  ]);
});
