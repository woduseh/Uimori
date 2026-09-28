import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import {
  addBookmark,
  updateBookmark,
  listBookmarks,
  saveReadingPosition,
  readingPositions,
} from '../server/reading-state.js';
import { captureChatCopy, restoreChatCopy } from '../server/chat-copy.js';
import { exportChatBackup, importChatBackup } from '../server/chat-backup.js';
import { deleteChat } from '../server/chat-deletion.js';
import { createFixtureChat } from './fixtures/chat.js';
import { completedSource } from './fixtures/illustration.js';
import type { Source } from '../core/types.js';
import type { ReaderTarget } from '../core/reader-target.js';

const fixtures: { directory: string; store: Store }[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-reading-'));
  const store = new Store(join(directory, 'app.sqlite'));
  fixtures.push({ directory, store });
  return store;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const item of fixtures.splice(0)) {
    item.store.close();
    rmSync(item.directory, { recursive: true, force: true });
  }
});
function target(source: Source): ReaderTarget {
  return {
    chatId: source.chatId,
    branchId: `main:${source.chatId}`,
    sourceId: source.id,
    representation: 'original',
    contentHash: source.hash,
    blockAnchor: source.blocks![0].anchor,
    offsetRatio: 0.3,
  };
}
function mark(store: Store, source: Source, title: string) {
  return addBookmark(store, source.chatId, {
    id: randomUUID(),
    target: target(source),
    title,
    note: 'Keep this scene',
    quote: source.text.slice(0, 30),
  });
}

test('device-local last positions use CAS, accept backwards reading, and reject another chat without hydrating prose', () => {
  const store = fixture();
  const chat = createFixtureChat(store, 'Reading');
  const first = completedSource(store, chat.id, '첫 장면');
  const second = completedSource(store, chat.id, '둘째 장면');
  const other = completedSource(store, createFixtureChat(store, 'Other').id, '다른 채팅');
  const a = randomUUID(),
    b = randomUUID();
  const projection = vi.spyOn(store, 'source').mockImplementation(() => {
    throw new Error('Must not hydrate the manuscript to store a location');
  });
  expect(readingPositions(store, chat.id, a)).toEqual({ own: null, other: null });
  const saved = saveReadingPosition(store, chat.id, {
    clientId: a,
    expectedRevision: 0,
    target: target(second),
  });
  expect(saved.revision).toBe(1);
  expect(readingPositions(store, chat.id, b).other).toEqual(saved);
  expect(() =>
    saveReadingPosition(store, chat.id, { clientId: a, expectedRevision: 0, target: target(first) })
  ).toThrow('다른 탭');
  const previous = saveReadingPosition(store, chat.id, {
    clientId: a,
    expectedRevision: 1,
    target: target(first),
  });
  expect(previous.target.sourceId).toBe(first.id);
  expect(previous.updatedAt > saved.updatedAt).toBe(true);
  expect(() =>
    saveReadingPosition(store, chat.id, {
      clientId: b,
      expectedRevision: 0,
      target: { ...target(other), chatId: chat.id, branchId: `main:${chat.id}` },
    })
  ).toThrow();
  expect(store.db.prepare('SELECT count(*) AS n FROM reading_positions').get()!.n).toBe(1);
  expect(projection).not.toHaveBeenCalled();
});

test('bookmarks preserve snapshots through edits, deduplicate an acknowledged create, and protect edits/deletion with CAS', () => {
  const store = fixture();
  const chat = createFixtureChat(store, 'Marks');
  const source = completedSource(store, chat.id, 'Original scene\n\nSecond paragraph.');
  const input = {
    id: randomUUID(),
    target: target(source),
    title: 'Favorite',
    note: 'My note',
    quote: 'Original scene',
  };
  const created = addBookmark(store, chat.id, input);
  expect(addBookmark(store, chat.id, input)).toEqual(created);
  expect(() => addBookmark(store, chat.id, { ...input, note: 'different' })).toThrow('달라졌어요');
  store.editSource(source.id, { expectedRevision: 0, text: 'Changed scene' });
  expect(listBookmarks(store, chat.id)[0].target.contentHash).toBe(source.hash);
  expect(store.source(source.id).hash).not.toBe(source.hash);
  const edited = updateBookmark(store, created.id, {
    expectedRevision: 1,
    title: 'New title',
    note: 'Revised',
  });
  expect(edited).toMatchObject({ revision: 2, title: 'New title' });
  expect(() => updateBookmark(store, created.id, { expectedRevision: 1 }, true)).toThrow('변경');
  updateBookmark(store, created.id, { expectedRevision: 2 }, true);
  expect(listBookmarks(store, chat.id)).toEqual([]);
  expect(store.source(source.id).text).toBe('Changed scene');
});

test('an earlier independent copy preserves only in-range bookmarks with new anchors and no reading positions', () => {
  const store = fixture();
  const chat = createFixtureChat(store, 'Independent');
  const first = completedSource(store, chat.id, 'First paragraph\n\nAnother paragraph');
  const second = completedSource(store, chat.id, 'Future paragraph');
  const original = mark(store, first, 'Earlier');
  mark(store, second, 'Later');
  saveReadingPosition(store, chat.id, {
    clientId: randomUUID(),
    expectedRevision: 0,
    target: target(second),
  });
  const copied = captureChatCopy(store, chat.id, undefined, first.id);
  expect(copied.state.bookmarks).toHaveLength(1);
  expect(copied.state.bookmarks![0]).toMatchObject({ entry: 0, title: 'Earlier', blockIndex: 0 });
  const clone = restoreChatCopy(store, copied, 'copy-marks');
  const markCopy = listBookmarks(store, clone.id)[0];
  expect(markCopy.id).not.toBe(original.id);
  expect(markCopy.target.chatId).toBe(clone.id);
  expect(markCopy.target.sourceId).not.toBe(first.id);
  const copiedSource = store.source(markCopy.target.sourceId);
  expect(markCopy.target.contentHash).toBe(copiedSource.hash);
  expect(markCopy.target.blockAnchor).toBe(copiedSource.blocks![0].anchor);
  expect(markCopy.target.blockAnchor).not.toBe(original.target.blockAnchor);
  expect(markCopy.target.offsetRatio).toBe(original.target.offsetRatio);
  expect(
    store.db.prepare('SELECT count(*) AS n FROM reading_positions WHERE chat_id=?').get(clone.id)!.n
  ).toBe(0);
  expect(restoreChatCopy(store, copied, 'copy-marks').id).toBe(clone.id);
  expect(listBookmarks(store, clone.id)).toHaveLength(1);
});

test('portable backup round-trip keeps bookmarks, rejects malformed locations atomically, and deleting a chat cascades only its own locations', async () => {
  const store = fixture();
  const chat = createFixtureChat(store, 'Portable');
  const source = completedSource(store, chat.id, 'Portable original');
  mark(store, source, 'Stored memory');
  saveReadingPosition(store, chat.id, {
    clientId: randomUUID(),
    expectedRevision: 0,
    target: target(source),
  });
  const backup = exportChatBackup(store, chat.id);
  const destination = fixture();
  const restored = await importChatBackup(destination, { backup, idempotencyKey: 'portable' });
  expect(listBookmarks(destination, restored.chat.id)[0]).toMatchObject({
    title: 'Stored memory',
    note: 'Keep this scene',
  });
  expect(destination.db.prepare('SELECT count(*) AS n FROM reading_positions').get()!.n).toBe(0);
  const malformed = structuredClone(backup);
  malformed.chats[0].state.bookmarks![0].entry = 999;
  const previousChats = destination.chats().length;
  await expect(
    importChatBackup(destination, { backup: malformed, idempotencyKey: 'bad' })
  ).rejects.toThrow('책갈피 장면');
  expect(destination.chats()).toHaveLength(previousChats);
  const legacy = structuredClone(backup);
  delete legacy.chats[0].state.bookmarks;
  const old = await importChatBackup(destination, { backup: legacy, idempotencyKey: 'legacy' });
  expect(listBookmarks(destination, old.chat.id)).toEqual([]);
  deleteChat(store, chat.id, {});
  expect(store.db.prepare('SELECT count(*) AS n FROM reading_positions').get()!.n).toBe(0);
  expect(store.db.prepare('SELECT count(*) AS n FROM bookmarks').get()!.n).toBe(0);
  expect(listBookmarks(destination, restored.chat.id)).toHaveLength(1);
  expect(destination.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});
