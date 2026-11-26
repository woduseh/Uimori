import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Store } from '../server/store.js';
import { readHelperChatContext } from '../server/helper-context.js';
import { helperWritingSnapshot } from '../server/helper-runtime.js';
import { prepareNativeRisuReadOnly } from '../server/risu-native-readonly.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { createFixtureChat } from './fixtures/chat.js';

const owned: { store: Store; directory: string }[] = [];

afterEach(() => {
  for (const { store, directory } of owned.splice(0)) {
    store.close();
    const inside = relative(resolve(tmpdir()), resolve(directory));
    if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('uimori-context-read-'))
      throw new Error('Unsafe context read cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-context-read-')),
    store = new Store(join(directory, 'synthetic.sqlite'));
  owned.push({ store, directory });
  const connection = store.product.connection({
    title: 'Unused synthetic context connection',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = store.product.model({
    title: 'Synthetic context read model',
    connectionId: connection.id,
    modelId: 'fixture-context-read',
    temperature: null,
    maxOutputTokens: 1024,
  });
  const workspace = modelWorkspace(store);
  updateModelWorkspace(store, {
    expectedRevision: workspace.revision,
    routes: { ...workspace.routes, main: { id: model.id } },
    translationPolicy: workspace.translationPolicy,
  });
  const chat = createFixtureChat(store, 'Synthetic context read history');
  for (let index = 0; index < 4; index++) {
    const current = store.chat(chat.id),
      request = `Synthetic request ${index}`;
    const run = store.createRun(
      chat.id,
      {
        request,
        expectedRevision: current.headRevision,
        expectedSettingsRevision: current.settingsRevision,
        idempotencyKey: randomUUID(),
      },
      (captured) => ({
        chatId: chat.id,
        parentRevision: captured.headRevision,
        settingsRevision: captured.settingsRevision,
        settings: captured.settings,
        request,
        history: store.history(captured.headRevision),
        resources: [],
      })
    ).run;
    store.startRun(run.id);
    store.completeRun(run.id, `Synthetic source ${index}. The promise remains unresolved.`, {
      modelCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  }
  const snapshot = await prepareNativeRisuReadOnly(
    helperWritingSnapshot(store, chat.id),
    'context'
  );
  const saved = store.context.edit(
    chat.id,
    {
      expectedRevision: 0,
      expectedHeadRevision: snapshot.parentRevision,
      idempotencyKey: 'active-summary',
      summary: 'The current summary retains the unresolved promise and its source.',
    },
    snapshot
  );
  const read = () => readHelperChatContext(store, chat.id);
  return { store, chatId: chat.id, saved, read };
}

test('context.read returns only the asked sections, always with the revisions, and lists compacted scenes on request', async () => {
  const f = await fixture();
  const all = f.read();
  expect(all.checkpoint!.plan).toHaveProperty('compactedScenes');
  expect(all.checkpoint!.plan).not.toHaveProperty('compacted');
  expect(all).toHaveProperty('notes');
  expect(all).toHaveProperty('storyGuide');
  const guide = readHelperChatContext(f.store, f.chatId, { sections: ['storyGuide'] });
  expect(Object.keys(guide).sort()).toEqual(
    ['activeRevision', 'headRevision', 'notesRevision', 'scopeKey', 'storyGuide'].sort()
  );
  const full = readHelperChatContext(f.store, f.chatId, {
    sections: ['summary'],
    includeCompacted: true,
  });
  expect(full.checkpoint!.plan.compacted).toHaveLength(full.checkpoint!.plan.compactedScenes);
  expect(() => readHelperChatContext(f.store, f.chatId, { sections: ['prose'] })).toThrow(
    'Invalid sections'
  );
});

test('active-only reads recheck current notes and preserve active checkpoint hash validation', async () => {
  const f = await fixture(),
    before = f.read();
  f.store.story.notes.write(f.chatId, {
    expectedRevision: before.notesRevision,
    expectedHeadRevision: before.headRevision,
    idempotencyKey: 'new-correction',
    author: 'Synthetic user',
    text: 'The old derived promise was corrected by the user.',
  });
  const after = f.read(),
    { jobs: _jobs, ...metadata } = f.store.context.detail(f.chatId);
  expect(after.checkpoint).toEqual(before.checkpoint);
  expect(after).toMatchObject({
    activeRevision: before.activeRevision,
    notesRevision: before.notesRevision + 1,
    usable: false,
  });
  expect(after.invalidReason).toBeTruthy();
  expect(after.notes).toHaveLength(1);
  expect(f.store.context.current(f.chatId)).toEqual(metadata);
  f.store.db
    .prepare("UPDATE context_checkpoints SET plan=json_set(plan,'$.summary',?) WHERE id=?")
    .run('Corrupted active summary', before.checkpoint!.id);
  expect(f.read).toThrow('CONTEXT_CHECKPOINT_HASH_MISMATCH');
});
