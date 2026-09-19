import { HttpError, fields, text, record } from './request-validation.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Store, Source, Run } from './store.js';
import type { StorySnapshot, StoryDetail, SceneCommand } from '../core/story.js';
import type { RunSnapshot } from '../core/types.js';
import { StoryNotes } from './story-notes.js';

type Row = Record<string, any>;
export const lineageHash = (history: RunSnapshot['history']) =>
  createHash('sha256')
    .update(
      JSON.stringify(
        history.map((item) => [item.revision, createHash('sha256').update(item.text).digest('hex')])
      )
    )
    .digest('hex');
export const storyTables = [
  'author_notes',
  'author_note_heads',
  'author_note_commands',
  'scene_commands',
];
/** User notes and explicit scene commands; authored card variables belong to the Risu runtime. */
export class StoryStore {
  readonly notes: StoryNotes;
  constructor(readonly store: Store) {
    this.notes = new StoryNotes(store);
  }
  get db() {
    return this.store.db;
  }
  initFresh() {
    this.db.exec(
      `CREATE TABLE scene_commands(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),branch_id TEXT NOT NULL REFERENCES branches(id),request_key TEXT NOT NULL,label TEXT NOT NULL,request TEXT NOT NULL,status TEXT NOT NULL,run_id TEXT REFERENCES runs(id),source_revision TEXT REFERENCES sources(id),UNIQUE(chat_id,request_key));`
    );
    this.notes.initFresh();
  }
  prepare(snapshot: RunSnapshot): StorySnapshot | undefined {
    this.store.product.branch(snapshot.chatId, snapshot.branchId);
    const scope = { chatId: snapshot.chatId, history: snapshot.history },
      notes = this.notes.entries(scope);
    return notes.length
      ? {
          lineageHash: lineageHash(snapshot.history),
          canonHash: this.notes.canonHash(scope),
          notes,
        }
      : undefined;
  }
  prepareRunInTransaction(snapshot: RunSnapshot): RunSnapshot {
    const story = this.prepare(snapshot);
    return story ? { ...snapshot, story } : snapshot;
  }
  reserveSourceInTransaction(source: Source, run: Run) {
    this.finishCommandInTransaction(run.id, 'consumed', source.id);
  }
  detail(chatId: string, branchId?: string): StoryDetail {
    const branch = this.store.product.branch(chatId, branchId),
      scope = this.notes.scope(chatId, branch.headRevision);
    return {
      notes: this.notes.entries(scope),
      notesRevision: this.notes.revision(chatId),
      commands: this.commands(chatId, branch.id),
    };
  }
  commands(chatId: string, branchId: string): SceneCommand[] {
    return (
      this.db
        .prepare('SELECT id FROM scene_commands WHERE chat_id=? AND branch_id=? ORDER BY rowid')
        .all(chatId, branchId) as Row[]
    ).map((row) => this.command(row.id));
  }
  command(id: string): SceneCommand {
    const row = this.db.prepare('SELECT * FROM scene_commands WHERE id=?').get(id) as
      | Row
      | undefined;
    if (!row) throw new HttpError(404, 'Scene command not found');
    return {
      id: row.id,
      chatId: row.chat_id,
      branchId: row.branch_id,
      label: row.label,
      request: row.request,
      status: row.status,
      runId: row.run_id,
      sourceRevision: row.source_revision,
    };
  }
  createCommand(chatId: string, value: unknown): SceneCommand {
    const body = record(value);
    fields(body, ['label', 'request', 'branchId', 'idempotencyKey']);
    const key = text(body.idempotencyKey, 'command key', 120);
    const label = text(body.label, 'command label', 120);
    const request = text(body.request, 'scene request', 4000);
    const branch = this.store.product.branch(
      chatId,
      body.branchId === undefined ? undefined : text(body.branchId, 'branch', 100)
    );
    return this.store.transaction(() => {
      const prior = this.db
        .prepare('SELECT id FROM scene_commands WHERE chat_id=? AND request_key=?')
        .get(chatId, key) as Row | undefined;
      if (prior) {
        const saved = this.command(prior.id);
        if (saved.label !== label || saved.request !== request || saved.branchId !== branch.id)
          throw new HttpError(409, 'Command key reused');
        return saved;
      }
      const id = randomUUID();
      this.db
        .prepare("INSERT INTO scene_commands VALUES(?,?,?,?,?,?,'pending',NULL,NULL)")
        .run(id, chatId, branch.id, key, label, request);
      this.store.event(chatId, 'scene.command.created', id);
      return this.command(id);
    });
  }
  bindCommandInTransaction(commandId: string, runId: string) {
    const command = this.command(commandId);
    const run = this.store.run(runId);
    if (
      command.chatId !== run.chatId ||
      command.branchId !== run.snapshot.branchId ||
      command.request !== run.request ||
      command.status === 'consumed' ||
      (command.status === 'cancelled' && !command.runId) ||
      (command.runId && ['queued', 'running'].includes(this.store.run(command.runId).status))
    )
      throw new HttpError(409, 'Scene command is unavailable');
    this.db
      .prepare("UPDATE scene_commands SET run_id=?,status='pending' WHERE id=?")
      .run(runId, commandId);
  }
  finishCommandInTransaction(
    runId: string,
    status: 'consumed' | 'failed' | 'cancelled',
    sourceId?: string
  ) {
    this.db
      .prepare(
        "UPDATE scene_commands SET status=?,source_revision=? WHERE run_id=? AND status='pending'"
      )
      .run(status, sourceId ?? null, runId);
  }
  cancelCommand(id: string): SceneCommand {
    const command = this.command(id);
    if (command.runId && ['queued', 'running'].includes(this.store.run(command.runId).status))
      throw new HttpError(409, '진행 중인 원문 생성을 먼저 취소해 주세요.');
    if (command.status !== 'consumed')
      this.db.prepare("UPDATE scene_commands SET status='cancelled' WHERE id=?").run(id);
    return this.command(id);
  }
}
