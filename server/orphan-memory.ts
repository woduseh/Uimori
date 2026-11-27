import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { chatSettingsEndpoints, type OrphanMemoryCommand } from '#contracts';
import { chatSettingsOperations } from '#contracts/operations';
import { chatLoreKey, type ChatLoreOverride } from '../core/chat-overrides.js';
import type { AuthorNote } from '../core/notes.js';
import type {
  OrphanMemoryDetail,
  OrphanMemoryEntry,
  OrphanMemoryReason,
} from '../core/orphan-memory.js';
import { sourceHash } from '../core/source-history.js';
import { ChatOverridesStore } from './chat-overrides.js';
import { AppError } from './app-errors.js';
import { registerEndpoint } from './endpoint.js';
import { HttpError } from './request-validation.js';
import type { Store } from './store.js';

export class OrphanMemory {
  readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }

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

  apply(chatId: string, body: OrphanMemoryCommand) {
    const {
      kind,
      action,
      entryId,
      expectedRevision,
      expectedLoreRevision,
      expectedHeadRevision: expectedHead,
      expectedHeadHash,
      idempotencyKey: key,
    } = body;
    const command = JSON.stringify({ orphanMemory: body });
    return this.store.transaction(() => {
      this.store.writableChat(chatId);
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
        throw new AppError(409, 'REVISION_CONFLICT');
      const selected = current.entries.find(
        (entry) =>
          entry.kind === kind &&
          (entry.kind === 'note' ? entry.note.id : entry.override.id) === entryId
      );
      if (!selected) throw new AppError(409, 'REVISION_CONFLICT');
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
  registerEndpoint(
    app,
    chatSettingsEndpoints.readOrphanMemory,
    chatSettingsOperations.readOrphanMemory,
    ({ chatId }) => memory.detail(chatId)
  );
  registerEndpoint(
    app,
    chatSettingsEndpoints.applyOrphanMemory,
    chatSettingsOperations.applyOrphanMemory,
    ({ chatId, ...command }) => {
      const result = memory.apply(chatId, command);
      hooks.publish(chatId);
      return result;
    }
  );
}
