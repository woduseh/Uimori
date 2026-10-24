import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import Fastify from 'fastify';
import type { ChatLoreOverride } from '../core/chat-overrides.js';
import { sourceHash } from '../core/source-history.js';
import { OrphanMemory, orphanMemoryRoutes } from '../server/orphan-memory.js';
import { ChatOverridesStore } from '../server/chat-overrides.js';
import { Store } from '../server/store.js';
import { createFixtureChat } from './fixtures/chat.js';
import { createTestDirectory } from './fixtures/test-directory.js';

const owned: { store: Store; remove: () => void }[] = [];
afterEach(() => {
  for (const item of owned.splice(0)) {
    item.store.close();
    item.remove();
  }
});
function fixture() {
  const temporary = createTestDirectory('uimori-orphan-memory-');
  const store = new Store(join(temporary.directory, 'test.sqlite'));
  owned.push({ store, remove: temporary.remove });
  const chat = createFixtureChat(store, 'Synthetic orphan review');
  const profile = store.product.snapshot(chat.id);
  const run = store.createRun(
    chat.id,
    {
      request: 'Continue',
      expectedRevision: null,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    () => ({
      chatId: chat.id,
      parentRevision: null,
      settingsRevision: chat.settingsRevision,
      settings: chat.settings,
      request: 'Continue',
      history: [],
      resources: store.product.resources(chat.id, profile),
      profile,
    })
  ).run;
  store.startRun(run.id);
  const source = store.completeRun(run.id, '마지막 장면에서 새는 은빛 바다를 보았다.', {
    modelCalls: 0,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  });
  const note = store.story.notes.write(chat.id, {
    text: '바다가 은빛이라는 기억을 남겨 둔다.',
    author: '작성자',
    expectedRevision: 0,
    expectedHeadRevision: source.id,
    idempotencyKey: 'first-note',
  }).note;
  return { store, chatId: chat.id, source, note, memory: new OrphanMemory(store) };
}
function command(
  f: ReturnType<typeof fixture>,
  action: 'reanchor' | 'retire',
  kind: 'note' | 'lore' = 'note',
  entryId = f.note.id
) {
  const detail = f.memory.detail(f.chatId);
  return {
    kind,
    entryId,
    action,
    expectedRevision: detail.revision,
    expectedLoreRevision: detail.loreRevision,
    expectedHeadRevision: detail.headRevision,
    expectedHeadHash: detail.headHash,
    idempotencyKey: randomUUID(),
  };
}

test('manual relinking retains note text, attribution and original record; repeated commands create no duplicate', () => {
  const f = fixture();
  f.store.db.prepare('UPDATE chats SET head_revision=NULL WHERE id=?').run(f.chatId);
  expect(f.store.story.detail(f.chatId).notes).toEqual([]);
  expect(f.memory.detail(f.chatId).entries).toEqual([
    { kind: 'note', note: f.note, reason: 'outside-history' },
  ]);
  const input = command(f, 'reanchor');
  const applied = f.memory.apply(f.chatId, input);
  expect(f.memory.apply(f.chatId, input)).toEqual(applied);
  expect(f.store.story.detail(f.chatId).notes).toEqual([
    { ...f.note, id: applied.entryId, atRevision: null, atHash: null },
  ]);
  expect(f.memory.detail(f.chatId).entries).toEqual([]);
  expect(
    JSON.parse(
      String(f.store.db.prepare('SELECT entry FROM author_notes WHERE id=?').get(f.note.id)?.entry)
    )
  ).toEqual(f.note);
  expect(f.store.db.prepare('SELECT COUNT(*) AS count FROM author_notes').get()?.count).toBe(2);
});

test('retiring an edited-source note preserves history and never makes its predecessor active', () => {
  const f = fixture();
  f.store.editSource(f.source.id, { expectedRevision: 0, text: '바다는 이제 보랏빛이다.' });
  expect(f.memory.detail(f.chatId).entries[0].reason).toBe('source-changed');
  f.memory.apply(f.chatId, command(f, 'retire'));
  expect(f.memory.detail(f.chatId).entries).toEqual([]);
  expect(f.store.story.detail(f.chatId).notes).toEqual([]);
  expect(f.store.db.prepare('SELECT COUNT(*) AS count FROM author_notes').get()?.count).toBe(2);
});

test('a stale reviewed head hash, memory revision, or cross-chat ID cannot modify memory', () => {
  const f = fixture();
  f.store.editSource(f.source.id, { expectedRevision: 0, text: '첫 번째 수정 원문.' });
  const before = command(f, 'reanchor');
  f.store.editSource(f.source.id, { expectedRevision: 1, text: '다시 바뀐 원문.' });
  expect(() => f.memory.apply(f.chatId, before)).toThrow('Memory changed');
  const staleRevision = command(f, 'reanchor');
  f.store.story.notes.write(f.chatId, {
    text: '새 메모',
    author: '작성자',
    expectedRevision: 1,
    expectedHeadRevision: f.source.id,
    idempotencyKey: 'new-note',
  });
  expect(() => f.memory.apply(f.chatId, staleRevision)).toThrow('Memory changed');
  expect(() =>
    f.memory.apply(f.chatId, { ...command(f, 'retire'), entryId: 'another-chat-note' })
  ).toThrow('no longer orphaned');
  expect(f.store.db.prepare('SELECT COUNT(*) AS count FROM author_notes').get()?.count).toBe(2);
});

test('deleted-source imported memories retain their origin and exclude already superseded notes', () => {
  const f = fixture();
  const imported = {
    ...f.note,
    id: 'imported-lost-note',
    atRevision: 'deleted-source',
    atHash: sourceHash('deleted source'),
    kind: 'imported-memory',
    origin: { fileHash: 'a'.repeat(64), entryId: 'entry-one', title: '가져온 원본' },
  };
  f.store.db
    .prepare('INSERT INTO author_notes VALUES(?,?,?,NULL,?)')
    .run(imported.id, f.chatId, JSON.stringify(imported), f.note.id);
  expect(f.memory.detail(f.chatId).entries).toEqual([
    { kind: 'note', note: imported, reason: 'missing-source' },
  ]);
  const result = f.memory.apply(f.chatId, command(f, 'reanchor', 'note', imported.id));
  const restored = f.store.story.detail(f.chatId).notes.find((note) => note.id === result.entryId);
  expect(restored).toMatchObject({
    text: imported.text,
    kind: 'imported-memory',
    origin: imported.origin,
    declaration: imported.declaration,
  });
  expect(f.memory.detail(f.chatId).entries).toEqual([]);
});

function lostLore(f: ReturnType<typeof fixture>): ChatLoreOverride {
  return {
    id: 'lost-lore',
    chatId: f.chatId,
    revision: 1,
    selector: {
      id: f.store.product.profile(f.chatId).packageAttachments![0].id,
      role: 'bot',
      modulePath: [],
      loreId: 'lore-0',
      field: 'text',
    },
    basePackageRevision: 1,
    baseRootRevision: 1,
    baseModuleRevisions: [],
    baseEntry: {
      id: 'lore-0',
      title: '바다',
      description: '',
      text: '푸른 바다',
      loading: 'pinned',
    },
    baseValue: '푸른 바다',
    baseHash: sourceHash('푸른 바다'),
    value: '은빛 바다',
    atSource: 'deleted-source',
    atHash: sourceHash('deleted source'),
    retired: false,
    createdAt: new Date().toISOString(),
  };
}

test('orphan lore retirement and relinking preserve base metadata and use an independent lore CAS revision', () => {
  const f = fixture();
  const override = lostLore(f);
  f.store.db
    .prepare('INSERT INTO chat_lore_overrides VALUES(?,?,?,?)')
    .run(override.id, f.chatId, 1, JSON.stringify(override));
  f.store.db.prepare('INSERT INTO chat_override_heads VALUES(?,?)').run(f.chatId, 1);
  const relink = command(f, 'reanchor', 'lore', override.id);
  const result = f.memory.apply(f.chatId, relink);
  const saved = JSON.parse(
    String(
      f.store.db.prepare('SELECT body FROM chat_lore_overrides WHERE id=?').get(result.entryId)
        ?.body
    )
  );
  expect(saved).toMatchObject({
    ...override,
    id: result.entryId,
    revision: 2,
    atSource: f.source.id,
    atHash: f.source.hash,
    retired: false,
    createdAt: expect.any(String),
  });
  expect(result).toMatchObject({ revision: 1, loreRevision: 2 });
  f.store.editSource(f.source.id, { expectedRevision: 0, text: '로어 연결 뒤 바뀐 원문.' });
  f.memory.apply(f.chatId, command(f, 'retire', 'lore', result.entryId));
  expect(f.memory.detail(f.chatId).entries.filter((entry) => entry.kind === 'lore')).toEqual([]);
  expect(f.store.db.prepare('SELECT COUNT(*) AS count FROM chat_lore_overrides').get()?.count).toBe(
    3
  );
});

test('retiring a lost lore edit leaves the surviving earlier interpretation unchanged', () => {
  const f = fixture();
  const orphan = { ...lostLore(f), revision: 2 };
  const surviving = {
    ...orphan,
    id: 'surviving-lore',
    revision: 1,
    atSource: f.source.id,
    atHash: f.source.hash,
    value: '현재 장면에 적용하는 기억',
  };
  for (const override of [surviving, orphan])
    f.store.db
      .prepare('INSERT INTO chat_lore_overrides VALUES(?,?,?,?)')
      .run(override.id, f.chatId, override.revision, JSON.stringify(override));
  f.store.db.prepare('INSERT INTO chat_override_heads VALUES(?,2)').run(f.chatId);
  expect(new ChatOverridesStore(f.store).get(f.chatId).overrides).toEqual([surviving]);
  f.memory.apply(f.chatId, command(f, 'retire', 'lore', orphan.id));
  expect(new ChatOverridesStore(f.store).get(f.chatId).overrides).toEqual([surviving]);
  expect(f.memory.detail(f.chatId).entries).toEqual([]);
});

test('HTTP cleanup publishes only after a successful manual mutation and lists no other chat memory', async () => {
  const f = fixture();
  f.store.db.prepare('UPDATE chats SET head_revision=NULL WHERE id=?').run(f.chatId);
  const published: string[] = [];
  const app = Fastify();
  orphanMemoryRoutes(app, f.store, { publish: (id) => published.push(id) });
  try {
    const listed = await app.inject({ method: 'GET', url: `/api/chats/${f.chatId}/orphan-memory` });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().entries.map((entry: { note: { id: string } }) => entry.note.id)).toEqual([
      f.note.id,
    ]);
    expect(published).toEqual([]);
    const response = await app.inject({
      method: 'POST',
      url: `/api/chats/${f.chatId}/orphan-memory`,
      payload: command(f, 'retire'),
    });
    expect(response.statusCode).toBe(200);
    expect(published).toEqual([f.chatId]);
    expect(f.store.story.detail(f.chatId).notes).toEqual([]);
  } finally {
    await app.close();
  }
});
