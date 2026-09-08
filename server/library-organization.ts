import { HttpError, fields, number, record, text } from './request-validation.js';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Content } from '../core/product.js';
import type {
  LibraryCategory,
  LibraryFolder,
  LibraryItemKey,
  LibraryOrganization,
  LibraryPlacement,
} from '../core/library-organization.js';
import { libraryItemKey } from '../core/library-organization.js';
import type { Store } from './store.js';

export const libraryOrganizationTables = [
  'library_organization_state',
  'library_folders',
  'library_placements',
];
const categories = ['bot', 'persona', 'module', 'prompts'];
function category(value: unknown): LibraryCategory {
  if (typeof value !== 'string' || !categories.includes(value))
    throw new HttpError(400, 'Invalid library category');
  return value as LibraryCategory;
}
function itemKey(value: unknown): LibraryItemKey {
  const item = record(value);
  fields(item, ['kind', 'id']);
  if (!['content', 'prompt-preset'].includes(item.kind))
    throw new HttpError(400, 'Invalid library item kind');
  return { kind: item.kind, id: text(item.id, 'library item ID', 100) };
}

/** Current organization is independent of immutable content revisions and execution roles. */
export class LibraryOrganizationStore {
  constructor(readonly store: Store) {}
  init() {
    this.store.db.exec(`
      CREATE TABLE library_organization_state(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL CHECK(revision>0));
      INSERT INTO library_organization_state VALUES(1,1);
      CREATE TABLE library_folders(id TEXT PRIMARY KEY,category TEXT NOT NULL CHECK(category IN ('bot','persona','module','prompts')),title TEXT NOT NULL,sort_position INTEGER NOT NULL CHECK(sort_position>=0));
      CREATE TABLE library_placements(kind TEXT NOT NULL CHECK(kind IN ('content','prompt-preset')),id TEXT NOT NULL,category TEXT NOT NULL CHECK(category IN ('bot','persona','module','prompts')),folder_id TEXT REFERENCES library_folders(id),PRIMARY KEY(kind,id));
      CREATE INDEX library_placements_folder ON library_placements(folder_id);
    `);
  }
  snapshot(): LibraryOrganization {
    const state = this.store.db
      .prepare('SELECT revision FROM library_organization_state WHERE id=1')
      .get() as { revision: number } | undefined;
    if (!state) throw new HttpError(400, 'Missing library organization state');
    return {
      revision: state.revision,
      folders: this.store.db
        .prepare(
          'SELECT id,category,title,sort_position AS sortPosition FROM library_folders ORDER BY category,sort_position,id'
        )
        .all() as LibraryFolder[],
      items: this.store.db
        .prepare(
          'SELECT kind,id,category,folder_id AS folderId FROM library_placements ORDER BY kind,id'
        )
        .all() as LibraryPlacement[],
    };
  }
  private bump() {
    this.store.db.exec('UPDATE library_organization_state SET revision=revision+1 WHERE id=1');
  }
  private edit(expected: unknown, action: () => void) {
    const revision = number(expected, 'library organization revision');
    return this.store.transaction(() => {
      if (this.snapshot().revision !== revision)
        throw new HttpError(409, '서재 정리가 변경됐어요. 새로고침한 뒤 다시 시도해 주세요.');
      action();
      this.bump();
      return this.snapshot();
    });
  }
  /** Caller holds the content save/delete transaction. */
  register(kind: string, id: string, contentKind?: Content['kind']) {
    if (kind !== 'content' && kind !== 'prompt-preset') return;
    this.store.db
      .prepare('INSERT INTO library_placements VALUES(?,?,?,NULL)')
      .run(kind, id, kind === 'prompt-preset' ? 'prompts' : contentKind!);
    this.bump();
  }
  remove(kind: string, id: string) {
    if (kind !== 'content' && kind !== 'prompt-preset') return;
    this.store.db.prepare('DELETE FROM library_placements WHERE kind=? AND id=?').run(kind, id);
    this.bump();
  }
  private folder(id: string) {
    const folder = this.snapshot().folders.find((item) => item.id === id);
    if (!folder) throw new HttpError(404, 'Library folder not found');
    return folder;
  }
  createFolder(value: unknown) {
    const b = record(value);
    fields(b, ['expectedRevision', 'category', 'title']);
    const kind = category(b.category),
      title = text(b.title, 'folder title', 200).trim();
    return this.edit(b.expectedRevision, () => {
      const count = this.snapshot().folders.filter((folder) => folder.category === kind).length;
      this.store.db
        .prepare('INSERT INTO library_folders VALUES(?,?,?,?)')
        .run(randomUUID(), kind, title, count);
    });
  }
  updateFolder(id: string, value: unknown) {
    const b = record(value);
    fields(b, ['expectedRevision', 'title', 'beforeFolderId']);
    if (b.title === undefined && b.beforeFolderId === undefined)
      throw new HttpError(400, 'Folder update is empty');
    return this.edit(b.expectedRevision, () => {
      const folder = this.folder(id);
      if (b.title !== undefined)
        this.store.db
          .prepare('UPDATE library_folders SET title=? WHERE id=?')
          .run(text(b.title, 'folder title', 200).trim(), id);
      if (b.beforeFolderId !== undefined) {
        const anchor =
          b.beforeFolderId === null ? null : text(b.beforeFolderId, 'folder anchor', 100);
        const siblings = this.snapshot()
          .folders.filter((item) => item.category === folder.category && item.id !== id)
          .map((item) => item.id);
        const index = anchor === null ? siblings.length : siblings.indexOf(anchor);
        if (index < 0) throw new HttpError(409, 'Folder order anchor is outside this category');
        siblings.splice(index, 0, id);
        this.order(siblings);
      }
    });
  }
  private order(ids: string[]) {
    const update = this.store.db.prepare('UPDATE library_folders SET sort_position=? WHERE id=?');
    ids.forEach((id, index) => {
      update.run(index, id);
    });
  }
  deleteFolder(id: string, value: unknown) {
    const b = record(value);
    fields(b, ['expectedRevision']);
    return this.edit(b.expectedRevision, () => {
      const folder = this.folder(id);
      this.store.db
        .prepare('UPDATE library_placements SET folder_id=NULL WHERE folder_id=?')
        .run(id);
      this.store.db.prepare('DELETE FROM library_folders WHERE id=?').run(id);
      this.order(
        this.snapshot()
          .folders.filter((item) => item.category === folder.category)
          .map((item) => item.id)
      );
    });
  }
  move(value: unknown) {
    const b = record(value);
    fields(b, ['expectedRevision', 'items', 'category', 'folderId']);
    if (!Array.isArray(b.items) || !b.items.length || b.items.length > 1000)
      throw new HttpError(400, 'Select 1 to 1000 library items');
    const items = b.items.map(itemKey),
      destination = category(b.category);
    const folderId = b.folderId === null ? null : text(b.folderId, 'library folder ID', 100);
    if (new Set(items.map(libraryItemKey)).size !== items.length)
      throw new HttpError(400, 'Duplicate library item');
    return this.edit(b.expectedRevision, () => {
      if (folderId !== null && this.folder(folderId).category !== destination)
        throw new HttpError(400, 'Destination folder belongs to another category');
      for (const item of items) {
        if ((item.kind === 'prompt-preset') !== (destination === 'prompts'))
          throw new HttpError(400, 'Prompt presets and content use separate categories');
        this.store.product.get(item.kind, item.id);
      }
      const move = this.store.db.prepare(
        'UPDATE library_placements SET category=?,folder_id=? WHERE kind=? AND id=?'
      );
      for (const item of items) move.run(destination, folderId, item.kind, item.id);
    });
  }
  validateArchive() {
    const snapshot = this.snapshot();
    number(snapshot.revision, 'library organization revision');
    for (const folder of snapshot.folders) {
      text(folder.id, 'library folder ID', 100);
      text(folder.title, 'library folder title', 200);
      category(folder.category);
      number(folder.sortPosition, 'library folder order', 0);
    }
    for (const kind of categories) {
      const orders = snapshot.folders
        .filter((folder) => folder.category === kind)
        .map((folder) => folder.sortPosition);
      if (orders.some((position, index) => position !== index))
        throw new HttpError(400, 'Invalid library folder order');
    }
    const stored = new Set(snapshot.items.map(libraryItemKey));
    for (const item of snapshot.items) {
      itemKey({ kind: item.kind, id: item.id });
      category(item.category);
      this.store.product.get(item.kind, item.id);
      if (
        (item.kind === 'prompt-preset') !== (item.category === 'prompts') ||
        (item.folderId !== null && this.folder(item.folderId).category !== item.category)
      )
        throw new HttpError(400, 'Invalid library placement category');
    }
    for (const kind of ['content', 'prompt-preset'] as const)
      for (const item of this.store.product.all(kind))
        if (!stored.has(libraryItemKey({ kind, id: item.id })))
          throw new HttpError(400, 'Missing library placement');
  }
}

export function libraryOrganizationRoutes(app: FastifyInstance, store: Store) {
  const org = store.libraryOrganization;
  app.get('/api/library/organization', async () => org.snapshot());
  app.post('/api/library/folders', async (request) => org.createFolder(request.body));
  app.patch<{ Params: { id: string } }>('/api/library/folders/:id', async (request) =>
    org.updateFolder(request.params.id, request.body)
  );
  app.delete<{ Params: { id: string } }>('/api/library/folders/:id', async (request) =>
    org.deleteFolder(request.params.id, request.body)
  );
  app.post('/api/library/organization/move', async (request) => org.move(request.body));
}
