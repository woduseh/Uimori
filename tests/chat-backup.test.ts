import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { Store } from '../server/store.js';
import { createFixtureChat } from './fixtures/chat.js';
import { exportChatBackup, importChatBackup } from '../server/chat-backup.js';
import { editTranslation, successfulTranslation } from '../server/source-editing.js';
import type { RunSnapshot } from '../core/types.js';

const owned: { directory: string; store: Store }[] = [];
afterEach(async () => {
  for (const { directory, store } of owned.splice(0)) {
    store.close();
    const target = resolve(directory),
      within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('uimori-chat-backup-test-')
    )
      throw new Error('Unsafe cleanup');
    await rm(target, { recursive: true, force: true });
  }
});
async function database() {
  const directory = await mkdtemp(join(tmpdir(), 'uimori-chat-backup-test-'));
  const store = new Store(join(directory, 'story.sqlite'));
  owned.push({ directory, store });
  return store;
}
function turn(store: Store, chatId: string, request: string, text: string, branchId?: string) {
  const chat = store.chat(chatId),
    branch = store.product.branch(chatId, branchId),
    profile = store.product.snapshot(chatId);
  const { run } = store.createRun(
    chatId,
    {
      request,
      expectedRevision: branch.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
      ...(branchId ? { branchId } : {}),
    },
    (current): RunSnapshot => ({
      chatId,
      parentRevision: current.headRevision,
      settingsRevision: current.settingsRevision,
      settings: current.settings,
      request,
      history: store.history(current.headRevision),
      resources: store.product.resources(chatId, profile),
      profile,
    })
  );
  store.startRun(run.id);
  return store.completeRun(
    run.id,
    text,
    { modelCalls: 1, inputTokens: 11, outputTokens: 12, costUsd: 0.01 },
    run.snapshot.settings
  );
}
function fixture(store: Store) {
  const chat = createFixtureChat(store, '모든 분기 백업');
  const first = turn(store, chat.id, 'first request', `First scene; literal identity ${chat.id}.`);
  const branch = store.product.createBranch(chat.id, {
    title: '다른 전개',
    fromRevision: first.id,
  });
  const alternative = turn(store, chat.id, 'alternate request', 'Alternative scene.', branch.id);
  const last = turn(store, chat.id, 'last request', 'Main final scene.');
  store.editSource(first.id, { text: `수정된 첫 장면 ${chat.id}`, expectedRevision: 0 });
  editTranslation(store, last.id, {
    text: '마지막 번역.',
    expectedRevision: 0,
    expectedSourceHash: last.hash,
  });
  store.story.notes.write(chat.id, {
    text: `메모 원문 ${chat.id}`,
    author: 'user',
    branchId: `main:${chat.id}`,
    expectedRevision: 0,
    expectedHeadRevision: last.id,
    idempotencyKey: 'backup-note',
  });
  return { chat, first, last, alternative };
}

test('a portable backup keeps every branch, exact text/edits/translation/notes and repeatedly restores new chats', async () => {
  const store = await database();
  const original = fixture(store);
  const unrelated = createFixtureChat(store, 'unrelated private chat');
  turn(store, unrelated.id, 'private request', 'MUST NOT BE IN CHAT BACKUP');
  const backup = exportChatBackup(store, original.chat.id);
  expect(backup).toMatchObject({
    format: 'uimori-chat-backup',
    version: 1,
    chatId: original.chat.id,
  });
  expect(JSON.stringify(backup)).not.toContain('MUST NOT BE IN CHAT BACKUP');
  expect(backup.records.chat).toHaveLength(1);
  expect(backup.records.branches).toHaveLength(2);
  expect(backup.records.sources).toHaveLength(3);
  const before = store.product.export().tables;
  const saved = JSON.stringify(backup);
  const copies = ['one', 'two'].map((key) =>
    importChatBackup(store, { backup, idempotencyKey: key })
  );
  expect(new Set(copies.map((copy) => copy.chat.id)).size).toBe(2);
  for (const copy of copies) {
    expect(copy.chat.id).not.toBe(original.chat.id);
    expect(copy).toMatchObject({ created: true, branches: 2, sources: 3 });
    const exported = exportChatBackup(store, copy.chat.id);
    expect(exported.records.sources.map((row) => row.text)).toEqual(
      backup.records.sources.map((row) => row.text)
    );
    expect(exported.records.sourceEdits.map((row) => row.text)).toEqual(
      backup.records.sourceEdits.map((row) => row.text)
    );
    expect(exported.records.turns.map((row) => row.usage)).toEqual(
      backup.records.turns.map((row) => row.usage)
    );
    const head = store.source(copy.chat.headRevision!);
    expect(successfulTranslation(store, head)?.result?.text).toBe('마지막 번역.');
    expect(exported.records.notes.map((row) => (row.entry as { text: string }).text)).toEqual([
      `메모 원문 ${original.chat.id}`,
    ]);
    expect(
      store.db.prepare('SELECT COUNT(*) n FROM attempts WHERE chat_id=?').get(copy.chat.id)!.n
    ).toBe(0);
  }
  const repeated = importChatBackup(store, { backup, idempotencyKey: 'one' });
  expect(repeated).toMatchObject({ created: false, chat: { id: copies[0].chat.id } });
  expect(JSON.stringify(backup)).toBe(saved);
  for (const row of before.sources)
    expect(store.db.prepare('SELECT * FROM sources WHERE id=?').get(row.id)).toEqual(row);
  const archive = await database();
  expect(archive.product.import(store.product.export()).restored).toBe(true);
});

test('cross-workspace import preserves existing work and a restored backup can be imported again', async () => {
  const origin = await database();
  const original = fixture(origin);
  const target = await database();
  const existing = createFixtureChat(target, 'Existing work');
  const existingSource = turn(target, existing.id, 'existing request', 'Existing source');
  const environment = target.db.prepare('SELECT body FROM prompt_workspace WHERE id=1').get();
  const copy = importChatBackup(target, {
    backup: exportChatBackup(origin, original.chat.id),
    idempotencyKey: 'external',
  });
  expect(target.source(existingSource.id).text).toBe('Existing source');
  expect(target.db.prepare('SELECT body FROM prompt_workspace WHERE id=1').get()).toEqual(
    environment
  );
  const again = importChatBackup(target, {
    backup: exportChatBackup(target, copy.chat.id),
    idempotencyKey: 'again',
  });
  expect(again.chat.id).not.toBe(copy.chat.id);
  expect(again.sources).toBe(3);
  turn(target, again.chat.id, 'Continue restored chat', 'New continuation');
  expect(target.history(target.chat(again.chat.id).headRevision)).toHaveLength(3);
});

test('invalid versions, corrupt data and reused keys fail atomically without modifying the backup', async () => {
  const store = await database(),
    { chat } = fixture(store),
    backup = exportChatBackup(store, chat.id);
  const before = store.product.export().tables;
  expect(() =>
    importChatBackup(store, { backup: { ...backup, version: 999 }, idempotencyKey: 'invalid' })
  ).toThrow('CHAT_BACKUP_UNSUPPORTED_VERSION');
  const bad = structuredClone(backup);
  bad.records.sources[0].text = 'tampered text';
  const input = JSON.stringify(bad);
  expect(() => importChatBackup(store, { backup: bad, idempotencyKey: 'corrupt' })).toThrow();
  expect(JSON.stringify(bad)).toBe(input);
  expect(store.product.export().tables).toEqual(before);
  importChatBackup(store, { backup, idempotencyKey: 'same' });
  expect(() =>
    importChatBackup(store, {
      backup: { ...backup, createdAt: '2026-09-11T01:00:00.000Z' },
      idempotencyKey: 'same',
    })
  ).toThrow('CHAT_BACKUP_IMPORT_CONFLICT');
});

test('deleted outline creation receipts keep distinct historical identities after repeated restore', async () => {
  const store = await database(),
    { chat } = fixture(store);
  const created = store.outline.apply(
    chat.id,
    {
      idempotencyKey: 'outline-create',
      operations: [{ op: 'create', level: 'theme', title: '삭제한 구성', intent: '' }],
    },
    'user'
  );
  const node = created.detail.nodes[0];
  store.outline.apply(
    chat.id,
    {
      idempotencyKey: 'outline-remove',
      operations: [{ op: 'remove', id: node.id, expectedRevision: node.revision }],
    },
    'user'
  );
  const backup = exportChatBackup(store, chat.id);
  expect(backup.records.outlineNodes).toHaveLength(0);
  for (const key of ['outline-copy-one', 'outline-copy-two'])
    importChatBackup(store, { backup, idempotencyKey: key });
  const fresh = await database();
  expect(fresh.product.import(store.product.export()).restored).toBe(true);
});

test('reused shared content keeps destination visibility and placement while retaining original organization evidence', async () => {
  const store = await database(),
    { chat } = fixture(store);
  const botId = store.db
    .prepare('SELECT bot_id FROM chat_organization WHERE chat_id=?')
    .get(chat.id)!.bot_id as string;
  store.db.prepare("INSERT INTO library_hidden VALUES('content',?)").run(botId);
  const backup = exportChatBackup(store, chat.id);
  store.db.prepare("DELETE FROM library_hidden WHERE kind='content' AND id=?").run(botId);
  const placement = store.db
    .prepare("SELECT * FROM library_placements WHERE kind='content' AND id=?")
    .get(botId);
  const copy = importChatBackup(store, { backup, idempotencyKey: 'reuse-visible' });
  expect(
    store.db.prepare("SELECT * FROM library_hidden WHERE kind='content' AND id=?").get(botId)
  ).toBeUndefined();
  expect(
    store.db.prepare("SELECT * FROM library_placements WHERE kind='content' AND id=?").get(botId)
  ).toEqual(placement);
  const environment = JSON.parse(
    store.db
      .prepare(
        "SELECT entity_id FROM events WHERE chat_id=? AND kind='chat.backup-environment' ORDER BY seq DESC LIMIT 1"
      )
      .get(copy.chat.id)!.entity_id as string
  );
  expect(environment.libraryOrganization.hidden).toContainEqual({ kind: 'content', id: botId });
  const reexported = exportChatBackup(store, copy.chat.id);
  expect(
    reexported.records.chatEvents.some(
      (row) => row.kind === 'chat.backup-environment' && String(row.entityId).includes(botId)
    )
  ).toBe(true);
});

test('original generator choices survive as passive evidence without restoring automatic execution or credential references', async () => {
  const store = await database(),
    { chat } = fixture(store);
  const row = store.db.prepare('SELECT body FROM illustration_settings WHERE id=1').get()!;
  const settings = JSON.parse(row.body as string);
  settings.generator = 'fixture';
  settings.automatic = true;
  settings.comfyui.authorizationEnv = 'SYNTHETIC_SECRET_REF';
  store.db
    .prepare('UPDATE illustration_settings SET body=? WHERE id=1')
    .run(JSON.stringify(settings));
  const backup = exportChatBackup(store, chat.id);
  const environments = backup.records.chatEvents
    .filter((event) => event.kind === 'chat.backup-environment')
    .map((event) => JSON.parse(event.entityId as string));
  expect(
    environments.some((environment) =>
      environment.illustrationSettings.some(
        (item: typeof settings) => item.generator === 'fixture' && item.automatic
      )
    )
  ).toBe(true);
  expect(JSON.stringify(backup)).not.toContain('SYNTHETIC_SECRET_REF');
  const target = await database();
  const before = target.db.prepare('SELECT body FROM illustration_settings WHERE id=1').get();
  const copy = importChatBackup(target, { backup, idempotencyKey: 'passive-environment' });
  expect(target.db.prepare('SELECT body FROM illustration_settings WHERE id=1').get()).toEqual(
    before
  );
  const again = exportChatBackup(target, copy.chat.id);
  expect(
    again.records.chatEvents.some(
      (event) =>
        event.kind === 'chat.backup-environment' &&
        String(event.entityId).includes('"generator":"fixture","automatic":true')
    )
  ).toBe(true);
});
