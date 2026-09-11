import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { deleteBranch } from '../server/chat-deletion.js';
import { exportChatBackup, importChatBackup } from '../server/chat-backup.js';
import { createFixtureChat, injectWithFixtureBot } from './fixtures/chat.js';

const owned: { path: string; store?: Store }[] = [];
afterEach(async () => {
  for (const item of owned.splice(0)) {
    item.store?.close();
    const target = resolve(item.path),
      within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('uimori-default-branch-')
    )
      throw new Error('Unsafe cleanup');
    await rm(target, { recursive: true, force: true });
  }
});
async function database() {
  const path = await mkdtemp(join(tmpdir(), 'uimori-default-branch-'));
  const store = new Store(join(path, 'story.sqlite'));
  owned.push({ path, store });
  return store;
}
function command(store: Store, chatId: string, key: string, branchId?: string) {
  return {
    request: key,
    expectedRevision: store.product.branch(chatId, branchId).headRevision,
    expectedSettingsRevision: store.chat(chatId).settingsRevision,
    idempotencyKey: key,
    ...(branchId ? { branchId } : {}),
  };
}
function reserve(store: Store, chatId: string, input: ReturnType<typeof command>) {
  return store.createRun(chatId, input, (chat) => ({
    chatId,
    parentRevision: chat.headRevision,
    settingsRevision: chat.settingsRevision,
    settings: chat.settings,
    request: input.request,
    history: store.history(chat.headRevision),
    resources: [],
    profile: store.product.snapshot(chatId),
  }));
}
function finish(store: Store, runId: string) {
  const run = store.run(runId);
  store.startRun(run.id);
  return store.completeRun(
    run.id,
    run.request,
    {
      modelCalls: 0,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    },
    { ...run.snapshot.settings, translation: false, status: false }
  );
}
function switchTo(store: Store, chatId: string, branchId: string) {
  const current = store.product.branch(chatId);
  return store.product.setDefaultBranch(chatId, branchId, {
    expectedRevision: store.product.branch(chatId, branchId).revision,
    expectedDefaultBranchId: current.id,
    expectedDefaultBranchRevision: current.revision,
  });
}

test('switching the default resolves new implicit runs there while preserving in-flight snapshots and replay', async () => {
  const store = await database();
  const chat = createFixtureChat(store, 'Default selection');
  const original = store.product.branch(chat.id);
  const alternative = store.product.createBranch(chat.id, {
    title: 'Alternative',
    fromRevision: null,
  });
  const pendingCommand = command(store, chat.id, 'pending');
  const pending = reserve(store, chat.id, pendingCommand).run;
  const alternateSource = finish(
    store,
    reserve(store, chat.id, command(store, chat.id, 'alternative', alternative.id)).run.id
  );
  const snapshots = store.db.prepare('SELECT id,snapshot FROM runs ORDER BY id').all();
  switchTo(store, chat.id, alternative.id);
  expect(store.product.branch(chat.id)).toMatchObject({ id: alternative.id, default: true });
  expect(store.chat(chat.id).headRevision).toBe(alternateSource.id);
  expect(store.product.branches(chat.id).filter((branch) => branch.default)).toHaveLength(1);
  expect(store.db.prepare('SELECT id,snapshot FROM runs ORDER BY id').all()).toEqual(snapshots);
  expect(reserve(store, chat.id, pendingCommand)).toMatchObject({
    created: false,
    run: { id: pending.id },
  });
  const originalSource = finish(store, pending.id);
  expect(store.product.branch(chat.id, original.id).headRevision).toBe(originalSource.id);
  expect(store.chat(chat.id).headRevision).toBe(alternateSource.id);
  const next = reserve(store, chat.id, command(store, chat.id, 'new default')).run;
  expect(next.snapshot.branchId).toBe(alternative.id);
  expect(next.parentRevision).toBe(alternateSource.id);
  expect(
    store.db.prepare("SELECT entity_id FROM events WHERE kind='branch.default.changed'").get()
  ).toMatchObject({ entity_id: alternative.id });
});

test('default changes reject stale target, stale default, ABA selection and foreign branches without mutation', async () => {
  const store = await database();
  const chat = createFixtureChat(store, 'CAS');
  const original = store.product.branch(chat.id);
  const target = store.product.createBranch(chat.id, { title: 'Target', fromRevision: null });
  const other = createFixtureChat(store, 'Other');
  const expected = {
    expectedRevision: target.revision,
    expectedDefaultBranchId: original.id,
    expectedDefaultBranchRevision: original.revision,
  };
  for (const body of [
    { ...expected, expectedRevision: 2 },
    { ...expected, expectedDefaultBranchRevision: 2 },
  ]) {
    expect(() => store.product.setDefaultBranch(chat.id, target.id, body)).toThrow('분기가 변경');
    expect(store.product.branch(chat.id).id).toBe(original.id);
  }
  expect(() =>
    store.product.setDefaultBranch(chat.id, store.product.branch(other.id).id, expected)
  ).toThrow('Branch not found');
  switchTo(store, chat.id, target.id);
  switchTo(store, chat.id, original.id);
  const before = store.product.export().tables;
  expect(() => store.product.setDefaultBranch(chat.id, target.id, expected)).toThrow('분기가 변경');
  expect(store.product.export().tables).toEqual(before);
  const failedEvent = vi.spyOn(store, 'event').mockImplementation(() => {
    throw new Error('Injected event failure');
  });
  try {
    expect(() => switchTo(store, chat.id, target.id)).toThrow('Injected event failure');
  } finally {
    failedEvent.mockRestore();
  }
  expect(store.product.export().tables).toEqual(before);
});

test('archive and repeated portable backups preserve the chosen default and independent old default deletion', async () => {
  const store = await database();
  const chat = createFixtureChat(store, 'Backup');
  const original = store.product.branch(chat.id);
  const originalSource = finish(
    store,
    reserve(store, chat.id, command(store, chat.id, 'old source')).run.id
  );
  const target = store.product.createBranch(chat.id, { title: 'Chosen', fromRevision: null });
  finish(
    store,
    reserve(store, chat.id, command(store, chat.id, 'chosen source', target.id)).run.id
  );
  switchTo(store, chat.id, target.id);
  const restored = await database();
  restored.product.import(store.product.export());
  expect(restored.product.branch(chat.id)).toEqual(store.product.branch(chat.id));
  const backup = exportChatBackup(store, chat.id);
  for (const key of ['first-copy', 'second-copy']) {
    const copy = importChatBackup(store, { backup, idempotencyKey: key });
    const branch = store.product.branch(copy.chat.id);
    expect(branch.title).toBe('Chosen');
    expect(branch.id).not.toBe(`main:${copy.chat.id}`);
    expect(branch.headRevision).toBe(copy.chat.headRevision);
    expect(store.source(branch.headRevision!).text).toBe('chosen source');
  }
  expect(() =>
    deleteBranch(store, chat.id, target.id, {
      expectedRevision: store.product.branch(chat.id).revision,
    })
  ).toThrow('다른 분기를 기본');
  expect(
    deleteBranch(store, chat.id, original.id, {
      expectedRevision: store.product.branch(chat.id, original.id).revision,
    })
  ).toEqual({ deleted: true });
  expect(() => store.source(originalSource.id)).toThrow('Source not found');
  expect(store.product.branch(chat.id).id).toBe(target.id);
  const withoutOriginal = importChatBackup(store, {
    backup: exportChatBackup(store, chat.id),
    idempotencyKey: 'without-original',
  });
  expect(store.product.branch(withoutOriginal.chat.id).title).toBe('Chosen');
  expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

test('HTTP default branch route enforces revision checks and refreshes the reader default', async () => {
  const path = await mkdtemp(join(tmpdir(), 'uimori-default-branch-'));
  owned.push({ path });
  const app = await createApp({
    dbPath: join(path, 'http.sqlite'),
    buildId: 'default-branch-fixture',
    testMode: true,
  });
  try {
    const chat = createFixtureChat(app.store, 'HTTP');
    const original = app.store.product.branch(chat.id);
    const target = app.store.product.createBranch(chat.id, { title: 'Target', fromRevision: null });
    const url = `/api/chats/${chat.id}/branches/${target.id}/default`;
    const payload = {
      expectedRevision: target.revision,
      expectedDefaultBranchId: original.id,
      expectedDefaultBranchRevision: original.revision,
    };
    expect(
      (
        await injectWithFixtureBot(app, {
          method: 'PUT',
          url,
          payload: { ...payload, expectedRevision: 2 },
        })
      ).statusCode
    ).toBe(409);
    const response = await injectWithFixtureBot(app, { method: 'PUT', url, payload });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: target.id, default: true, revision: 2 });
    expect(app.store.product.branch(chat.id).id).toBe(target.id);
    const reader = await injectWithFixtureBot(app, {
      method: 'GET',
      url: `/api/chats/${chat.id}/reader`,
    });
    expect(reader.statusCode).toBe(200);
    expect(reader.json().branches.find((branch: { default: boolean }) => branch.default).id).toBe(
      target.id
    );
  } finally {
    await app.close();
  }
});

test('renaming a branch needs the current revision and stops an automatic summary from returning', async () => {
  const store = await database();
  const chat = createFixtureChat(store, 'Branch naming');
  const original = store.product.branch(chat.id);
  const target = store.product.createBranch(chat.id, {
    title: '후보 분기',
    fromRevision: null,
  });
  const renamed = store.product.renameBranch(chat.id, target.id, {
    title: '등불이 두 번 흔들린 밤',
    expectedRevision: target.revision,
  });
  expect(renamed.title).toBe('등불이 두 번 흔들린 밤');
  expect(renamed.revision).toBe(target.revision + 1);
  expect(() =>
    store.product.renameBranch(chat.id, target.id, {
      title: '뒤늦은 이름',
      expectedRevision: target.revision,
    })
  ).toThrow('분기 이름');
  expect(store.product.branch(chat.id, target.id).title).toBe('등불이 두 번 흔들린 밤');
  // The manual mark is what a later summary checks before it may overwrite a chosen name.
  expect(
    store.db
      .prepare("SELECT 1 FROM events WHERE entity_id=? AND kind='branch.title.manual'")
      .get(target.id)
  ).toBeTruthy();
  expect(store.product.branch(chat.id, original.id).title).toBe('기본 분기');
});
