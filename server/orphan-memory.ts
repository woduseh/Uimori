import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { chatLoreKey, type ChatLoreOverride } from '../core/chat-overrides.js';
import type { AuthorNote } from '../core/notes.js';
import type {
  OrphanMemoryDetail,
  OrphanMemoryEntry,
  OrphanMemoryReason,
} from '../core/orphan-memory.js';
import { sourceHash } from '../core/source-history.js';
import { ChatOverridesStore } from './chat-overrides.js';
import { choice, fields, HttpError, number, record, text } from './request-validation.js';
import type { Store } from './store.js';

/** Lost anchors are review candidates, never permission to erase authored memory. */
export class OrphanMemory {
  constructor(readonly store: Store) {}

  detail(chatId: string): OrphanMemoryDetail {
    const chat = this.store.chat(chatId);
    const history = new Map(
      this.store
        .history(chat.headRevision)
        .map((item) => [item.revision, item.contentHash ?? sourceHash(item.text)])
    );
    const reason = (revision: string | null, hash: string | null): OrphanMemoryReason | null => {
      if (revision === null) return null;
      if (history.has(revision)) return history.get(revision) === hash ? null : 'source-changed';
      return this.store.db
        .prepare('SELECT id FROM sources WHERE id=? AND chat_id=?')
        .get(revision, chatId)
        ? 'outside-history'
        : 'missing-source';
    };
    const rows = this.store.db
      .prepare('SELECT entry,replaces_id FROM author_notes WHERE chat_id=? ORDER BY rowid')
      .all(chatId);
    const replaced = new Set(rows.map((row) => row.replaces_id).filter(Boolean));
    const entries: OrphanMemoryEntry[] = [];
    for (const row of rows) {
      const note = JSON.parse(String(row.entry)) as AuthorNote;
      if (note.retired || replaced.has(note.id)) continue;
      const why = reason(note.atRevision, note.atHash);
      if (why) entries.push({ kind: 'note', note, reason: why });
    }
    const latestLore = new Map<string, ChatLoreOverride>();
    for (const row of this.store.db
      .prepare('SELECT body FROM chat_lore_overrides WHERE chat_id=? ORDER BY revision')
      .all(chatId)) {
      const override = JSON.parse(String(row.body)) as ChatLoreOverride;
      latestLore.set(chatLoreKey(override.selector), override);
    }
    for (const override of latestLore.values()) {
      if (override.retired) continue;
      const why = reason(override.atSource, override.atHash);
      if (why) entries.push({ kind: 'lore', override, reason: why });
    }
    return {
      headRevision: chat.headRevision,
      headHash: chat.headRevision ? history.get(chat.headRevision)! : null,
      revision: this.store.story.notes.revision(chatId),
      loreRevision: new ChatOverridesStore(this.store).revision(chatId),
      entries,
    };
  }

  apply(chatId: string, value: unknown) {
    const body = record(value);
    fields(body, [
      'kind',
      'entryId',
      'action',
      'expectedRevision',
      'expectedLoreRevision',
      'expectedHeadRevision',
      'expectedHeadHash',
      'idempotencyKey',
    ]);
    const kind = choice(body.kind, ['note', 'lore'], 'memory kind');
    const action = choice(body.action, ['reanchor', 'retire'], 'memory action');
    const entryId = text(body.entryId, 'memory ID', 100);
    const expectedRevision = number(body.expectedRevision, 'notes revision', 0);
    const expectedLoreRevision = number(body.expectedLoreRevision, 'lore revision', 0);
    const expectedHead =
      body.expectedHeadRevision === null
        ? null
        : text(body.expectedHeadRevision, 'source revision', 100);
    const expectedHeadHash =
      body.expectedHeadHash === null ? null : text(body.expectedHeadHash, 'source hash', 64);
    const key = text(body.idempotencyKey, 'request key', 120);
    const command = JSON.stringify({ orphanMemory: body });
    return this.store.transaction(() => {
      this.store.chat(chatId);
      const prior = this.store.db
        .prepare(
          'SELECT command,result FROM author_note_commands WHERE chat_id=? AND request_key=?'
        )
        .get(chatId, key);
      if (prior) {
        if (prior.command !== command) throw new HttpError(409, 'Note request key reused');
        return JSON.parse(String(prior.result));
      }
      const current = this.detail(chatId);
      if (
        current.revision !== expectedRevision ||
        current.loreRevision !== expectedLoreRevision ||
        current.headRevision !== expectedHead ||
        current.headHash !== expectedHeadHash
      )
        throw new HttpError(409, 'Memory changed. Refresh and review the item again.');
      const selected = current.entries.find(
        (entry) =>
          entry.kind === kind &&
          (entry.kind === 'note' ? entry.note.id : entry.override.id) === entryId
      );
      if (!selected)
        throw new HttpError(409, 'Memory item is no longer orphaned. Refresh and review again.');
      const atHash = current.headHash;
      const id = randomUUID();
      if (selected.kind === 'note') {
        const note: AuthorNote = {
          ...selected.note,
          id,
          atRevision: action === 'retire' ? selected.note.atRevision : current.headRevision,
          atHash: action === 'retire' ? selected.note.atHash : atHash,
          ...(action === 'retire' ? { retired: true } : {}),
        };
        this.store.db
          .prepare('INSERT INTO author_notes VALUES(?,?,?,NULL,?)')
          .run(id, chatId, JSON.stringify(note), selected.note.id);
        this.store.db
          .prepare(
            'INSERT INTO author_note_heads VALUES(?,?) ON CONFLICT(chat_id) DO UPDATE SET revision=excluded.revision'
          )
          .run(chatId, expectedRevision + 1);
      } else {
        const override: ChatLoreOverride = {
          ...selected.override,
          id,
          revision: expectedLoreRevision + 1,
          // Retiring lost history must not mask a surviving override for this selector.
          atSource: action === 'retire' ? selected.override.atSource : current.headRevision,
          atHash: action === 'retire' ? selected.override.atHash : atHash,
          retired: action === 'retire',
          createdAt: new Date().toISOString(),
        };
        this.store.db
          .prepare('INSERT INTO chat_lore_overrides VALUES(?,?,?,?)')
          .run(id, chatId, override.revision, JSON.stringify(override));
        this.store.db
          .prepare(
            'INSERT INTO chat_override_heads VALUES(?,?) ON CONFLICT(chat_id) DO UPDATE SET revision=excluded.revision'
          )
          .run(chatId, override.revision);
      }
      const result = {
        entryId: id,
        revision: expectedRevision + (kind === 'note' ? 1 : 0),
        loreRevision: expectedLoreRevision + (kind === 'lore' ? 1 : 0),
      };
      this.store.db
        .prepare('INSERT INTO author_note_commands VALUES(?,?,?,?)')
        .run(chatId, key, command, JSON.stringify(result));
      this.store.event(
        chatId,
        kind === 'note' ? 'context.notes.updated' : 'chat.lore.override',
        id
      );
      return result;
    });
  }
}

export function orphanMemoryRoutes(
  app: FastifyInstance,
  store: Store,
  hooks: { publish: (chatId: string) => void }
) {
  const memory = new OrphanMemory(store);
  app.get<{ Params: { id: string } }>('/api/chats/:id/orphan-memory', async (request) =>
    memory.detail(request.params.id)
  );
  app.post<{ Params: { id: string } }>('/api/chats/:id/orphan-memory', async (request) => {
    const result = memory.apply(request.params.id, request.body);
    hooks.publish(request.params.id);
    return result;
  });
}
