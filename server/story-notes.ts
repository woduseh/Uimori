import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateAuthorNote, visibleAuthorNotes, type AuthorNote } from '../core/notes.js';
import { sourceHash, type SourceScope } from '../core/source-history.js';
import { fields, HttpError, number, record, text } from './request-validation.js';
import type { Store } from './store.js';

type Row = Record<string, any>;
export class StoryNotes {
  constructor(readonly store: Store) {}
  get db() {
    return this.store.db;
  }
  initFresh() {
    this.db.exec(`
      CREATE TABLE author_notes(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),entry TEXT NOT NULL,retired_at TEXT,replaces_id TEXT REFERENCES author_notes(id));
      CREATE TABLE author_note_heads(chat_id TEXT PRIMARY KEY REFERENCES chats(id),revision INTEGER NOT NULL);
      CREATE TABLE author_note_commands(chat_id TEXT NOT NULL REFERENCES chats(id),request_key TEXT NOT NULL,command TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(chat_id,request_key));
    `);
  }
  scope(chatId: string, headRevision: string | null): SourceScope {
    this.store.chat(chatId);
    const history = this.store.history(headRevision);
    if (history.some((item) => this.store.source(item.revision).chatId !== chatId))
      throw new HttpError(400, 'Note source outside chat');
    return { chatId, history };
  }
  private verifyScope(scope: SourceScope) {
    const actual = this.scope(scope.chatId, scope.history.at(-1)?.revision ?? null);
    const normalized = (s: SourceScope) =>
      s.history.map((item) => [
        item.revision,
        item.contentHash ?? sourceHash(item.text),
        item.text,
      ]);
    if (!isDeepStrictEqual(normalized(actual), normalized(scope)))
      throw new HttpError(409, 'Note source ancestry changed');
  }
  revision(chatId: string): number {
    this.store.chat(chatId);
    return Number(
      (
        this.db.prepare('SELECT revision FROM author_note_heads WHERE chat_id=?').get(chatId) as
          | Row
          | undefined
      )?.revision ?? 0
    );
  }
  entries(scope: SourceScope): AuthorNote[] {
    this.verifyScope(scope);
    const rows = this.db
      .prepare('SELECT entry,replaces_id FROM author_notes WHERE chat_id=? ORDER BY rowid')
      .all(scope.chatId) as Row[];
    const visible = visibleAuthorNotes(
      scope,
      rows.map((row) => JSON.parse(row.entry))
    );
    const ids = new Set(visible.map((note) => note.id));
    const replaced = new Set(
      rows
        .filter((row) => row.replaces_id && ids.has(JSON.parse(row.entry).id))
        .map((row) => row.replaces_id)
    );
    return visible.filter((note) => !note.retired && !replaced.has(note.id));
  }
  canonHash(scope: SourceScope): string {
    return sourceHash(JSON.stringify(this.entries(scope).sort((a, b) => a.id.localeCompare(b.id))));
  }
  /** A replacement/retirement is anchored at the current branch, preserving sibling visibility. */
  write(chatId: string, value: unknown): { note: AuthorNote; revision: number } {
    const body = record(value);
    fields(body, [
      'text',
      'author',
      'branchId',
      'expectedRevision',
      'idempotencyKey',
      'replacesId',
      'retired',
      'expectedHeadRevision',
    ]);
    const expectedRevision = number(body.expectedRevision, 'notes revision', 0);
    const key = text(body.idempotencyKey, 'request key', 120);
    if (body.retired !== undefined && body.retired !== true)
      throw new HttpError(400, 'Invalid note retirement');
    const content = body.retired ? '' : text(body.text, 'note text', 32000);
    const author = text(body.author, 'note author', 200);
    const replacesId =
      body.replacesId === undefined ? undefined : text(body.replacesId, 'note ID', 100);
    if (body.retired && !replacesId) throw new HttpError(400, 'Retirement requires a note');
    const command = JSON.stringify(body);
    return this.store.transaction(() => {
      const prior = this.db
        .prepare(
          'SELECT command,result FROM author_note_commands WHERE chat_id=? AND request_key=?'
        )
        .get(chatId, key) as Row | undefined;
      if (prior) {
        if (prior.command !== command) throw new HttpError(409, 'Note request key reused');
        return JSON.parse(prior.result);
      }
      if (this.revision(chatId) !== expectedRevision)
        throw new HttpError(409, '메모가 변경됐어요. 새로고침한 뒤 다시 적용해 주세요.');
      const branch = this.store.product.branch(chatId, body.branchId);
      if (body.expectedHeadRevision !== branch.headRevision)
        throw new HttpError(409, '메모를 붙일 원문이 변경됐어요. 최신 원문을 확인해 주세요.');
      const scope = this.scope(chatId, branch.headRevision);
      if (replacesId && !this.entries(scope).some((note) => note.id === replacesId))
        throw new HttpError(409, 'Note no longer available in this branch');
      const anchor = scope.history.at(-1);
      const note = validateAuthorNote(
        {
          id: randomUUID(),
          chatId,
          atRevision: anchor?.revision ?? null,
          atHash: anchor ? sourceHash(anchor.text) : null,
          kind: 'author-note',
          text: content,
          declaration: { author, text: content },
          ...(body.retired ? { retired: true } : {}),
        },
        scope
      );
      if (replacesId)
        this.db
          .prepare('UPDATE author_notes SET retired_at=? WHERE id=? AND chat_id=?')
          .run(new Date().toISOString(), replacesId, chatId);
      this.db
        .prepare('INSERT INTO author_notes VALUES(?,?,?,NULL,?)')
        .run(note.id, chatId, JSON.stringify(note), replacesId ?? null);
      const result = { note, revision: expectedRevision + 1 };
      this.db
        .prepare(
          'INSERT INTO author_note_heads VALUES(?,?) ON CONFLICT(chat_id) DO UPDATE SET revision=excluded.revision'
        )
        .run(chatId, result.revision);
      this.db
        .prepare('INSERT INTO author_note_commands VALUES(?,?,?,?)')
        .run(chatId, key, command, JSON.stringify(result));
      this.store.event(chatId, 'context.notes.updated', note.id);
      return result;
    });
  }
}
