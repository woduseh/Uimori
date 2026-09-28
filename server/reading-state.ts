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
import { fields, record, text, HttpError } from './request-validation.js';
import type { Store } from './store.js';

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
const bounded = (value: unknown, max: number, name: string, empty = false) => {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()))
    throw new HttpError(400, `${name}을 확인해 주세요.`);
  return value;
};
const client = (value: unknown) => {
  const id = text(value, 'browser ID', 100);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, '브라우저 식별자를 확인해 주세요.');
  return id;
};
/** Validate ownership using only IDs. Content hashes are snapshot hints, verified by the reader;
 * a frequent progress write must not hydrate or tokenize a multi-megabyte scene. */
export function validateReaderTarget(store: Store, chatId: string, value: unknown): ReaderTarget {
  const body = record(value);
  fields(body, [
    'chatId',
    'sourceId',
    'representation',
    'contentHash',
    'blockAnchor',
    'offsetRatio',
  ]);
  if (body.chatId !== chatId) throw new HttpError(400, '다른 채팅의 읽기 위치예요.');
  const chat = store.chat(chatId);
  const sourceId = text(body.sourceId, 'source', 120);
  const member = store.db
    .prepare(`WITH RECURSIVE chain(id) AS (SELECT ? UNION SELECT s.parent_revision FROM sources s JOIN chain c ON c.id=s.id WHERE s.parent_revision IS NOT NULL)
    SELECT 1 FROM chain c JOIN sources s ON s.id=c.id WHERE c.id=? AND s.chat_id=?`)
    .get(chat.headRevision, sourceId, chatId);
  if (!member) throw new HttpError(404, '현재 채팅에서 그 장면을 찾지 못했어요.');
  if (!['original', 'translation'].includes(String(body.representation)))
    throw new HttpError(400, '읽기 모드를 확인해 주세요.');
  if (
    body.contentHash !== undefined &&
    (typeof body.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.contentHash))
  )
    throw new HttpError(400, '본문 식별자를 확인해 주세요.');
  if (
    body.offsetRatio !== undefined &&
    (typeof body.offsetRatio !== 'number' ||
      !Number.isFinite(body.offsetRatio) ||
      body.offsetRatio < 0 ||
      body.offsetRatio > 1)
  )
    throw new HttpError(400, '읽기 위치를 확인해 주세요.');
  return {
    chatId,
    sourceId,
    representation: body.representation as ReaderTarget['representation'],
    ...(body.contentHash !== undefined ? { contentHash: String(body.contentHash) } : {}),
    ...(body.blockAnchor !== undefined
      ? { blockAnchor: bounded(body.blockAnchor, 200, '문단 위치') }
      : {}),
    ...(body.offsetRatio !== undefined ? { offsetRatio: Number(body.offsetRatio) } : {}),
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
  const id = client(clientId);
  store.chat(chatId);
  return {
    own: position(
      store.db
        .prepare('SELECT * FROM reading_positions WHERE chat_id=? AND client_id=?')
        .get(chatId, id)
    ),
    other: position(
      store.db
        .prepare(
          'SELECT * FROM reading_positions WHERE chat_id=? AND client_id!=? ORDER BY updated_at DESC,client_id LIMIT 1'
        )
        .get(chatId, id)
    ),
  };
}
export function saveReadingPosition(store: Store, chatId: string, value: unknown): ReadingPosition {
  const body = record(value);
  fields(body, ['clientId', 'expectedRevision', 'target']);
  const clientId = client(body.clientId);
  return store.transaction(() => {
    const target = validateReaderTarget(store, chatId, body.target);
    const old = readingPositions(store, chatId, clientId).own;
    if (
      !Number.isSafeInteger(body.expectedRevision) ||
      body.expectedRevision !== (old?.revision ?? 0)
    )
      throw new HttpError(
        409,
        '다른 탭에서 읽기 위치가 바뀌었어요. 오래된 위치는 저장하지 않았어요.'
      );
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
export function addBookmark(store: Store, chatId: string, value: unknown): Bookmark {
  const body = record(value);
  fields(body, ['id', 'target', 'title', 'note', 'quote']);
  const id = client(body.id);
  const title = bounded(body.title, 200, '책갈피 이름');
  const note = bounded(body.note ?? '', 4000, '메모', true);
  const quote = bounded(body.quote ?? '', 300, '인용', true);
  return store.transaction(() => {
    const target = validateReaderTarget(store, chatId, body.target);
    const old = store.db.prepare('SELECT * FROM bookmarks WHERE id=?').get(id);
    if (old) {
      if (
        old.chat_id !== chatId ||
        old.title !== title ||
        old.note !== note ||
        old.quote !== quote ||
        old.target !== JSON.stringify(target)
      )
        throw new HttpError(409, '책갈피 저장 요청이 달라졌어요.');
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
export function updateBookmark(
  store: Store,
  id: string,
  value: unknown,
  remove = false
): Bookmark | { deleted: true } {
  const body = record(value);
  fields(body, remove ? ['expectedRevision'] : ['expectedRevision', 'title', 'note']);
  return store.transaction(() => {
    const old = store.db.prepare('SELECT * FROM bookmarks WHERE id=?').get(id);
    if (!old) throw new HttpError(404, '책갈피를 찾지 못했어요.');
    if (body.expectedRevision !== old.revision)
      throw new HttpError(409, '책갈피가 변경됐어요. 최신 내용을 확인해 주세요.');
    if (remove) {
      store.db.prepare('DELETE FROM bookmarks WHERE id=?').run(id);
      return { deleted: true as const };
    }
    store.db
      .prepare('UPDATE bookmarks SET title=?,note=?,revision=revision+1,updated_at=? WHERE id=?')
      .run(
        bounded(body.title, 200, '책갈피 이름'),
        bounded(body.note, 4000, '메모', true),
        new Date().toISOString(),
        id
      );
    return bookmark(store.db.prepare('SELECT * FROM bookmarks WHERE id=?').get(id)!);
  });
}
export function captureBookmarks(
  store: Store,
  chatId: string,
  sourceIds: string[]
): PortableBookmark[] {
  // Older migrations can copy chats before this newer table has been introduced.
  if (
    !store.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='bookmarks'").get()
  )
    return [];
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
  if (!Array.isArray(values)) throw new HttpError(400, '책갈피 자료를 확인해 주세요.');
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
      throw new HttpError(400, '책갈피 장면이 없어요.');
    const source = store.source(sourceIds[Number(body.entry)]);
    if (
      body.blockIndex !== undefined &&
      (!Number.isSafeInteger(body.blockIndex) || Number(body.blockIndex) < 0)
    )
      throw new HttpError(400, '책갈피 문단을 확인해 주세요.');
    if (
      body.offsetRatio !== undefined &&
      (typeof body.offsetRatio !== 'number' ||
        !Number.isFinite(body.offsetRatio) ||
        body.offsetRatio < 0 ||
        body.offsetRatio > 1)
    )
      throw new HttpError(400, '읽기 위치를 확인해 주세요.');
    let anchor: string | undefined;
    // Original text retained exactly can preserve its paragraph after new source IDs are assigned.
    if (
      body.representation === 'original' &&
      body.contentHash === source.hash &&
      body.blockIndex !== undefined
    )
      anchor = source.blocks?.[Number(body.blockIndex)]?.anchor;
    // Translation targets keep the snapshot hash; when no stable copied paragraph exists, resume at the scene.
    addBookmark(store, chatId, {
      id: randomUUID(),
      target: {
        chatId,
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
  }
}
export function readingStateRoutes(app: FastifyInstance, store: Store) {
  app.get<{ Params: { id: string }; Querystring: { clientId: string } }>(
    '/api/chats/:id/reading-position',
    (request) => {
      fields(record(request.query), ['clientId']);
      return readingPositions(store, request.params.id, request.query.clientId);
    }
  );
  app.put<{ Params: { id: string } }>('/api/chats/:id/reading-position', (request) =>
    saveReadingPosition(store, request.params.id, request.body)
  );
  app.get<{ Params: { id: string } }>('/api/chats/:id/bookmarks', (request) => {
    fields(record(request.query), []);
    return listBookmarks(store, request.params.id);
  });
  app.post<{ Params: { id: string } }>('/api/chats/:id/bookmarks', (request) =>
    addBookmark(store, request.params.id, request.body)
  );
  app.patch<{ Params: { id: string } }>('/api/bookmarks/:id', (request) =>
    updateBookmark(store, request.params.id, request.body)
  );
  app.delete<{ Params: { id: string } }>('/api/bookmarks/:id', (request) =>
    updateBookmark(store, request.params.id, request.body, true)
  );
}
