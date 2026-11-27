import {
  type CreateLibraryFolder,
  type DeleteLibraryFolder,
  libraryEndpoints,
  type LibraryCategory,
  type LibraryFolder,
  type LibraryOrganization,
  type LibraryPlacement,
  type MoveLibraryItems,
  type UpdateLibraryFolder,
} from '#contracts';
import { libraryOperations } from '#contracts/operations';
import { HttpError } from './request-validation.js';
import { AppError, assertRevision } from './app-errors.js';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Content } from '../core/product.js';
import type { Store } from './store.js';
import { queueImageCleanup } from './unused-data.js';
import { registerEndpoint } from './endpoint.js';

export function initLibraryFolderCovers(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS library_folder_covers(
    folder_id TEXT PRIMARY KEY REFERENCES library_folders(id) ON DELETE CASCADE,
    hash TEXT NOT NULL
  )`);
}

export class LibraryOrganizationStore {
  readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }
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
          'SELECT f.id,f.category,f.title,f.sort_position AS sortPosition,c.hash AS coverImageHash FROM library_folders f LEFT JOIN library_folder_covers c ON c.folder_id=f.id ORDER BY f.category,f.sort_position,f.id'
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
  private edit(expected: number, action: () => void) {
    return this.store.transaction(() => {
      assertRevision(this.snapshot().revision, expected);
      action();
      this.bump();
      return this.snapshot();
    });
  }
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
  private folder(id: string, expectedCategory?: LibraryCategory) {
    const folder = this.snapshot().folders.find((item) => item.id === id);
    if (!folder) throw new AppError(409, 'REVISION_CONFLICT');
    if (expectedCategory !== undefined && expectedCategory !== folder.category)
      throw new HttpError(409, 'Folder is outside this category');
    return folder;
  }
  createFolder({ expectedRevision, category: kind, title }: CreateLibraryFolder) {
    return this.edit(expectedRevision, () => {
      const count = this.snapshot().folders.filter((folder) => folder.category === kind).length;
      this.store.db
        .prepare('INSERT INTO library_folders VALUES(?,?,?,?)')
        .run(randomUUID(), kind, title, count);
    });
  }
  private clearCover(id: string) {
    const previous = this.store.db
      .prepare('SELECT hash FROM library_folder_covers WHERE folder_id=?')
      .get(id);
    if (!previous) return;
    this.store.db.prepare('DELETE FROM library_folder_covers WHERE folder_id=?').run(id);
    queueImageCleanup(this.store.db, [String(previous.hash)]);
  }
  private setCover(id: string, hash: string | null) {
    this.clearCover(id);
    if (hash === null) return;
    if (!this.store.db.prepare('SELECT 1 FROM image_blobs WHERE hash=?').get(hash))
      throw new AppError(400, 'IMAGE_NOT_FOUND');
    this.store.db.prepare('INSERT INTO library_folder_covers VALUES(?,?)').run(id, hash);
  }
  updateFolder(input: UpdateLibraryFolder, expectedCategory?: LibraryCategory) {
    const { id, title, coverImageHash, beforeFolderId: anchor } = input;
    return this.edit(input.expectedRevision, () => {
      const folder = this.folder(id, expectedCategory);
      if (title !== undefined)
        this.store.db.prepare('UPDATE library_folders SET title=? WHERE id=?').run(title, id);
      if (coverImageHash !== undefined) this.setCover(id, coverImageHash);
      if (anchor !== undefined) {
        if (anchor !== null && this.folder(anchor).category !== folder.category)
          throw new HttpError(409, 'Folder order anchor is outside this category');
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
  deleteFolder({ id, expectedRevision }: DeleteLibraryFolder, expectedCategory?: LibraryCategory) {
    return this.edit(expectedRevision, () => {
      const folder = this.folder(id, expectedCategory);
      this.clearCover(id);
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
  move({ expectedRevision, items, category: destination, folderId }: MoveLibraryItems) {
    return this.edit(expectedRevision, () => {
      if (folderId !== null && this.folder(folderId).category !== destination)
        throw new HttpError(400, 'Destination folder belongs to another category');
      for (const item of items)
        if (!this.store.product.isLive(item.kind, item.id))
          throw new AppError(409, 'REVISION_CONFLICT');
      const move = this.store.db.prepare(
        'UPDATE library_placements SET category=?,folder_id=? WHERE kind=? AND id=?'
      );
      for (const item of items) move.run(destination, folderId, item.kind, item.id);
    });
  }
}

export function libraryOrganizationRoutes(app: FastifyInstance, store: Store) {
  const org = store.libraryOrganization;
  const endpoints = libraryEndpoints,
    operations = libraryOperations;
  registerEndpoint(app, endpoints.readOrganization, operations.readOrganization, () =>
    org.snapshot()
  );
  registerEndpoint(app, endpoints.createFolder, operations.createFolder, (input) =>
    org.createFolder(input)
  );
  registerEndpoint(app, endpoints.updateFolder, operations.updateFolder, (input) =>
    org.updateFolder(input)
  );
  registerEndpoint(app, endpoints.deleteFolder, operations.deleteFolder, (input) =>
    org.deleteFolder(input)
  );
  registerEndpoint(app, endpoints.moveItems, operations.moveItems, (input) => org.move(input));
}
