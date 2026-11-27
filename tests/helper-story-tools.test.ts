import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { Content } from '../core/product.js';
import * as transport from '../core/transport.js';
import type { Chat, Job, Run } from '../core/types.js';
import { importChatTranscript } from '../server/chat-transcript.js';
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
    if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('uimori-story-tools-'))
      throw new Error('Unsafe cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
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
  selectFixtureModels(store);
  const started: ({ run: Run } | { job: Job })[] = [];
  const run = await runScriptedChatHelper(store, chat.id, steps(store.chat(chat.id)), {
    story: {
      requireRunModel: () => {},
      requireTranslationModel: () => {},
      started: (item) => started.push(item),
    },
  });
  return { ...run, store, chat: store.chat(chat.id), started };
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
      helperCall('stale', 'scene.request', { ...args, expectedSettingsRevision: 99 }),
      helperCall('first', 'scene.request', args),
      helperCall('busy', 'scene.request', { ...args, request: 'Another scene.' }),
      helperDone,
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
  expect(f.finished('stale')).toMatchObject({ denied: true, errorCode: 'REVISION_CONFLICT' });
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
      helperCall('translate', 'scene.translate', { sourceId }),
      helperCall('again', 'scene.translate', { sourceId, retranslate: true }),
      helperCall('outside', 'scene.translate', { sourceId: 'missing-scene' }),
      helperDone,
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
