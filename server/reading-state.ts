import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import type {
  Bookmark,
  ReadingPosition,
  ReadingPositions,
  PortableBookmark,
} from '../core/reading-state.js';
import type { ReaderTarget } from '../core/reader-target.js';
import { personalWorkspaceEndpoints } from '#contracts';
import {
  type AddBookmark,
  personalWorkspaceOperations,
  type ReaderTargetInput,
  type SaveReadingPosition,
  type UpdateBookmark,
} from '#contracts/operations';
import { fields, record, HttpError } from './request-validation.js';
import type { Store } from './store.js';
import { AppError, assertRevision } from './app-errors.js';
import { registerEndpoint } from './endpoint.js';

export function initReadingState(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reading_positions(
      client_id TEXT NOT NULL,chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      target TEXT NOT NULL,revision INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(client_id,chat_id));
    CREATE INDEX IF NOT EXISTS reading_position_recent ON reading_positions(chat_id,updated_at DESC);
    CREATE TABLE IF NOT EXISTS bookmarks(
      id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      target TEXT NOT NULL,title TEXT NOT NULL,note TEXT NOT NULL,quote TEXT NOT NULL,revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS bookmarks_chat ON bookmarks(chat_id,created_at,id);
  `);
}
function resolveReaderTarget(
  store: Store,
  chatId: string,
  target: ReaderTargetInput
): ReaderTarget {
  const chat = store.chat(chatId);
  const member = store.db
    .prepare(`WITH RECURSIVE chain(id) AS (SELECT ? UNION SELECT s.parent_revision FROM sources s JOIN chain c ON c.id=s.id WHERE s.parent_revision IS NOT NULL)
    SELECT 1 FROM chain c JOIN sources s ON s.id=c.id WHERE c.id=? AND s.chat_id=?`)
    .get(chat.headRevision, target.sourceId, chatId);
  if (!member) throw new AppError(404, 'READING_SCENE_NOT_FOUND');
  return {
    chatId,
    sourceId: target.sourceId,
    representation: target.representation,
    ...(target.contentHash !== undefined ? { contentHash: target.contentHash } : {}),
    ...(target.blockAnchor !== undefined ? { blockAnchor: target.blockAnchor } : {}),
    ...(target.offsetRatio !== undefined ? { offsetRatio: target.offsetRatio } : {}),
  };
}
function position(row: Record<string, unknown> | undefined): ReadingPosition | null {
  return row
    ? {
        clientId: String(row.client_id),
        revision: Number(row.revision),
        updatedAt: String(row.updated_at),
        target: JSON.parse(String(row.target)),
      }
    : null;
}
export function readingPositions(store: Store, chatId: string, clientId: string): ReadingPositions {
  store.chat(chatId);
  return {
    own: position(
      store.db
        .prepare('SELECT * FROM reading_positions WHERE chat_id=? AND client_id=?')
        .get(chatId, clientId)
    ),
    other: position(
      store.db
        .prepare(
          'SELECT * FROM reading_positions WHERE chat_id=? AND client_id!=? ORDER BY updated_at DESC,client_id LIMIT 1'
        )
        .get(chatId, clientId)
    ),
  };
}
export function saveReadingPosition(
  store: Store,
  chatId: string,
  { clientId, expectedRevision, target: requested }: Omit<SaveReadingPosition, 'chatId'>
): ReadingPosition {
  return store.transaction(() => {
    if (!store.db.prepare('SELECT 1 FROM chats WHERE id=?').get(chatId))
      throw new AppError(409, 'REVISION_CONFLICT');
    const old = readingPositions(store, chatId, clientId).own;
    assertRevision(old?.revision ?? 0, expectedRevision);
    const target = resolveReaderTarget(store, chatId, requested);
    const now = new Date(
      Math.max(Date.now(), (old ? Date.parse(old.updatedAt) : 0) + 1)
    ).toISOString();
    const revision = (old?.revision ?? 0) + 1;
    store.db
      .prepare(`INSERT INTO reading_positions(client_id,chat_id,source_id,target,revision,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(client_id,chat_id) DO UPDATE SET source_id=excluded.source_id,target=excluded.target,revision=excluded.revision,updated_at=excluded.updated_at`)
      .run(clientId, chatId, target.sourceId, JSON.stringify(target), revision, now);
    return { clientId, revision, updatedAt: now, target };
  });
}
function bookmark(row: Record<string, unknown>): Bookmark {
  return {
    id: String(row.id),
    revision: Number(row.revision),
    target: JSON.parse(String(row.target)),
    title: String(row.title),
    note: String(row.note),
    quote: String(row.quote),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
export function listBookmarks(store: Store, chatId: string): Bookmark[] {
  store.chat(chatId);
  return store.db
    .prepare('SELECT * FROM bookmarks WHERE chat_id=? ORDER BY created_at,id')
    .all(chatId)
    .map(bookmark);
}
export function addBookmark(
  store: Store,
  chatId: string,
  { id, target: requested, title, note, quote }: Omit<AddBookmark, 'chatId'>
): Bookmark {
  return store.transaction(() => {
    if (!store.db.prepare('SELECT 1 FROM chats WHERE id=?').get(chatId))
      throw new AppError(409, 'REVISION_CONFLICT');
    const target = resolveReaderTarget(store, chatId, requested);
    const old = store.db.prepare('SELECT * FROM bookmarks WHERE id=?').get(id);
    if (old) {
      if (
        old.chat_id !== chatId ||
        old.title !== title ||
        old.note !== note ||
        old.quote !== quote ||
        old.target !== JSON.stringify(target)
      )
        throw new HttpError(409, 'Bookmark ID reused with different content');
      return bookmark(old);
    }
    const now = new Date().toISOString();
    store.db
      .prepare(
        'INSERT INTO bookmarks(id,chat_id,source_id,target,title,note,quote,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,?,?)'
      )
      .run(id, chatId, target.sourceId, JSON.stringify(target), title, note, quote, now, now);
    return bookmark(store.db.prepare('SELECT * FROM bookmarks WHERE id=?').get(id)!);
  });
}
function currentBookmark(store: Store, id: string, expectedRevision: number) {
  const old = store.db.prepare('SELECT revision FROM bookmarks WHERE id=?').get(id);
  if (!old) throw new AppError(409, 'REVISION_CONFLICT');
  assertRevision(Number(old.revision), expectedRevision);
}
export function updateBookmark(
  store: Store,
  { id, expectedRevision, title, note }: UpdateBookmark
): Bookmark {
  return store.transaction(() => {
    currentBookmark(store, id, expectedRevision);
    store.db
      .prepare('UPDATE bookmarks SET title=?,note=?,revision=revision+1,updated_at=? WHERE id=?')
      .run(title, note, new Date().toISOString(), id);
    return bookmark(store.db.prepare('SELECT * FROM bookmarks WHERE id=?').get(id)!);
  });
}
export function deleteBookmark(
  store: Store,
  { id, expectedRevision }: { id: string; expectedRevision: number }
): { deleted: true } {
  return store.transaction(() => {
    currentBookmark(store, id, expectedRevision);
    store.db.prepare('DELETE FROM bookmarks WHERE id=?').run(id);
    return { deleted: true as const };
  });
}
export function captureBookmarks(
  store: Store,
  chatId: string,
  sourceIds: string[]
): PortableBookmark[] {
  const indexes = new Map(sourceIds.map((id, index) => [id, index]));
  return listBookmarks(store, chatId).flatMap((item) => {
    const entry = indexes.get(item.target.sourceId);
    if (entry === undefined) return [];
    const source =
      item.target.representation === 'original' && item.target.blockAnchor
        ? store.source(item.target.sourceId)
        : null;
    const blockIndex =
      source && source.hash === item.target.contentHash
        ? (source.blocks?.findIndex((block) => block.anchor === item.target.blockAnchor) ?? -1)
        : -1;
    return [
      {
        entry,
        representation: item.target.representation,
        title: item.title,
        note: item.note,
        quote: item.quote,
        ...(item.target.contentHash ? { contentHash: item.target.contentHash } : {}),
        ...(blockIndex >= 0 ? { blockIndex, offsetRatio: item.target.offsetRatio } : {}),
      },
    ];
  });
}
export function restoreBookmarks(
  store: Store,
  chatId: string,
  sourceIds: string[],
  values: unknown
) {
  if (values === undefined) return;
  if (!Array.isArray(values)) throw new AppError(400, 'CHAT_BACKUP_INVALID');
  for (const value of values) {
    const body = record(value);
    fields(body, [
      'entry',
      'representation',
      'contentHash',
      'blockIndex',
      'offsetRatio',
      'title',
      'note',
      'quote',
    ]);
    if (
      !Number.isInteger(body.entry) ||
      Number(body.entry) < 0 ||
      Number(body.entry) >= sourceIds.length
    )
      throw new AppError(400, 'CHAT_BACKUP_INVALID');
    const source = store.source(sourceIds[Number(body.entry)]);
    if (
      body.blockIndex !== undefined &&
      (!Number.isSafeInteger(body.blockIndex) || Number(body.blockIndex) < 0)
    )
      throw new AppError(400, 'CHAT_BACKUP_INVALID');
    if (
      body.offsetRatio !== undefined &&
      (typeof body.offsetRatio !== 'number' ||
        !Number.isFinite(body.offsetRatio) ||
        body.offsetRatio < 0 ||
        body.offsetRatio > 1)
    )
      throw new AppError(400, 'CHAT_BACKUP_INVALID');
    let anchor: string | undefined;
    if (
      body.representation === 'original' &&
      body.contentHash === source.hash &&
      body.blockIndex !== undefined
    )
      anchor = source.blocks?.[Number(body.blockIndex)]?.anchor;
    const parsed = personalWorkspaceOperations.addBookmark.input.safeParse({
      chatId,
      id: randomUUID(),
      target: {
        sourceId: source.id,
        representation: body.representation,
        ...(body.contentHash ? { contentHash: body.contentHash } : {}),
        ...(anchor
          ? {
              blockAnchor: anchor,
              ...(body.offsetRatio !== undefined ? { offsetRatio: body.offsetRatio } : {}),
            }
          : {}),
      },
      title: body.title,
      note: body.note,
      quote: body.quote,
    });
    if (!parsed.success) throw new AppError(400, 'CHAT_BACKUP_INVALID');
    addBookmark(store, chatId, parsed.data);
  }
}
export function readingStateRoutes(app: FastifyInstance, store: Store) {
  const endpoints = personalWorkspaceEndpoints;
  const operations = personalWorkspaceOperations;
  registerEndpoint(app, endpoints.readReadingPositions, operations.readReadingPositions, (input) =>
    readingPositions(store, input.chatId, input.clientId)
  );
  registerEndpoint(
    app,
    endpoints.saveReadingPosition,
    operations.saveReadingPosition,
    ({ chatId, ...input }) => saveReadingPosition(store, chatId, input)
  );
  registerEndpoint(app, endpoints.listBookmarks, operations.listBookmarks, (input) =>
    listBookmarks(store, input.chatId)
  );
  registerEndpoint(app, endpoints.addBookmark, operations.addBookmark, ({ chatId, ...input }) =>
    addBookmark(store, chatId, input)
  );
  registerEndpoint(app, endpoints.updateBookmark, operations.updateBookmark, (input) =>
    updateBookmark(store, input)
  );
  registerEndpoint(app, endpoints.deleteBookmark, operations.deleteBookmark, (input) =>
    deleteBookmark(store, input)
  );
}
