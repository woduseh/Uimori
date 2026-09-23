import { prepareNativeFixtureRun } from './fixtures/native-run.js';
import { createFixtureChat } from './fixtures/chat.js';
import { afterEach, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { Store } from '../server/store.js';
import { chatDeletionImpact, deleteChat } from '../server/chat-deletion.js';
import { readChatVariables } from '../server/chat-variables.js';

const owned: { directory: string; store?: Store }[] = [];
afterEach(async () => {
  for (const item of owned.splice(0)) {
    item.store?.close();
    const target = resolve(item.directory),
      inside = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(inside) ||
      inside.startsWith('..') ||
      !basename(target).startsWith('Uimori deletion ')
    )
      throw new Error('Unexpected cleanup path');
    await rm(target, { recursive: true, force: true });
  }
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'Uimori deletion '));
  const store = new Store(join(directory, 'story.sqlite'));
  owned.push({ directory, store });
  return store;
}
async function run(store: Store, chatId: string, branchId = `main:${chatId}`, finish = true) {
  const branch = store.product.branch(chatId, branchId),
    chat = store.chat(chatId),
    profile = {
      ...store.product.snapshot(chatId),
      variableState: readChatVariables(store, chatId, branch.id),
    };
  const created = store.createRun(
    chatId,
    {
      request: 'Synthetic',
      expectedRevision: branch.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: crypto.randomUUID(),
      branchId,
    },
    (current) => ({
      chatId,
      parentRevision: branch.headRevision,
      settingsRevision: current.settingsRevision,
      settings: current.settings,
      request: 'Synthetic',
      history: store.history(branch.headRevision),
      resources: store.product.resources(chatId, profile),
      profile,
    })
  );
  const run = await prepareNativeFixtureRun(store, created.run);
  if (!finish) return { run, source: null };
  store.startRun(run.id);
  const source = store.completeRun(
    run.id,
    'Synthetic scene.',
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    { ...run.snapshot.settings, status: false }
  );
  return { run, source };
}

test('active run or outstanding provider attempt blocks deletion until completion', async () => {
  const store = await fixture(),
    chat = createFixtureChat(store, 'Busy');
  const pending = (await run(store, chat.id, undefined, false)).run;
  expect(() => deleteChat(store, chat.id, chatDeletionImpact(store, chat.id).request)).toThrow(
    '진행 중'
  );
  store.finishRun(pending.id, 'cancelled', 'Synthetic cancellation');
  store.db
    .prepare(
      "INSERT INTO attempts(id,chat_id,run_id,role,connection_id,model_id,status,request) VALUES('attempt',?,?,'main','fixture','fixture','running','{}')"
    )
    .run(chat.id, pending.id);
  const time = new Date().toISOString();
  store.db
    .prepare(
      "INSERT INTO anthropic_batches VALUES('attempt',?,0,'batch-delete','attempt','request','ended',NULL,?,?)"
    )
    .run(pending.id, time, time);
  expect(() => deleteChat(store, chat.id, chatDeletionImpact(store, chat.id).request)).toThrow(
    '공급자 요청'
  );
  store.db.prepare("UPDATE attempts SET status='cancelled'").run();
  deleteChat(store, chat.id, chatDeletionImpact(store, chat.id).request);
  expect(store.chats()).toEqual([]);
  expect(store.db.prepare('SELECT count(*) AS count FROM anthropic_batches').get()).toEqual({
    count: 0,
  });
});
