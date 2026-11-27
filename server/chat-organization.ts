import { HttpError, text } from './request-validation.js';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  chatEndpoints,
  type CreateChatFolder,
  type DeleteChatFolder,
  type MoveChat,
  type PersonaChoice,
  type PinChat,
  type UpdateBotDefaults,
  type UpdateChatFolder,
} from '#contracts';
import { chatOperations } from '#contracts/operations';
import { defaultProfile, type Content, type ContentRef, type ChatFolder } from '../core/product.js';
import type { Store } from './store.js';
import { loreContextDefaults } from './lore-context-defaults.js';
import { newChatPersona, type BotDefaults } from '../core/bot-defaults.js';
import { AppError } from './app-errors.js';
import { registerEndpoint } from './endpoint.js';

export type { ChatFolder } from '../core/product.js';
export type ChatOrganization = {
  botId: string;
  folderId: string | null;
  organizationRevision: number;
  sortPosition: number;
};
type Row = Record<string, any>;
export const CHAT_PIN_PREFIX = 'chat-pin:';

export class ChatOrganizationStore {
  readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }
  init() {
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS chat_folders(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,title TEXT NOT NULL,default_persona TEXT,revision INTEGER NOT NULL CHECK(revision>0));
      CREATE TABLE IF NOT EXISTS chat_organization(chat_id TEXT PRIMARY KEY REFERENCES chats(id),bot_id TEXT NOT NULL,folder_id TEXT REFERENCES chat_folders(id),revision INTEGER NOT NULL CHECK(revision>0),sort_position INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS chat_folders_bot ON chat_folders(bot_id);
      CREATE INDEX IF NOT EXISTS chat_organization_folder ON chat_organization(folder_id);`);
  }
  bot(botId: string, access: 'read' | 'write' = 'read') {
    if (!this.store.db.prepare("SELECT 1 FROM versions WHERE kind='content' AND id=?").get(botId))
      throw access === 'write'
        ? new AppError(409, 'REVISION_CONFLICT')
        : new AppError(404, 'LIBRARY_ITEM_DELETED');
    const bot = this.store.product.stored<Content>('content', botId);
    if (bot.kind !== 'bot' && !bot.package)
      throw new HttpError(400, 'Organization owner must be a bot or package');
    return bot;
  }
  defaults(botId: string, access: 'read' | 'write' = 'read'): BotDefaults {
    this.bot(botId, access);
    const row = this.store.db
      .prepare('SELECT value FROM app_metadata WHERE key=?')
      .get(`bot-defaults:${botId}`);
    return row ? JSON.parse(String(row.value)) : { revision: 1, persona: { mode: 'inherit' } };
  }
  updateDefaults({ botId, expectedRevision, persona: selection }: UpdateBotDefaults): BotDefaults {
    return this.store.transaction(() => {
      const prior = this.defaults(botId, 'write');
      if (prior.revision !== expectedRevision) throw new AppError(409, 'REVISION_CONFLICT');
      const next: BotDefaults = {
        revision: prior.revision + 1,
        persona:
          selection.mode === 'persona'
            ? { mode: 'persona', persona: this.persona(selection.persona) }
            : selection,
      };
      this.store.db
        .prepare(
          'INSERT INTO app_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
        )
        .run(`bot-defaults:${botId}`, JSON.stringify(next));
      return next;
    });
  }
  metadata(chatId: string): ChatOrganization | undefined {
    const row = this.store.db
      .prepare('SELECT * FROM chat_organization WHERE chat_id=?')
      .get(chatId) as Row | undefined;
    return row
      ? {
          botId: row.bot_id,
          folderId: row.folder_id,
          organizationRevision: row.revision,
          sortPosition: row.sort_position,
        }
      : undefined;
  }
  private orderedIds(botId: string, folderId: string | null): string[] {
    return (
      this.store.db
        .prepare(
          'SELECT chat_id FROM chat_organization WHERE bot_id=? AND folder_id IS ? ORDER BY sort_position,chat_id'
        )
        .all(botId, folderId) as Row[]
    ).map((row) => String(row.chat_id));
  }
  private firstPosition(botId: string, folderId: string | null): number {
    const row = this.store.db
      .prepare(
        'SELECT MIN(sort_position) AS first FROM chat_organization WHERE bot_id=? AND folder_id IS ?'
      )
      .get(botId, folderId) as Row;
    return row.first === null ? 0 : row.first - 1;
  }
  private setPositions(ids: string[]) {
    const update = this.store.db.prepare(
      'UPDATE chat_organization SET sort_position=? WHERE chat_id=?'
    );
    ids.forEach((id, index) => {
      update.run(index, id);
    });
  }
  private mapFolder(row: Row): ChatFolder {
    return {
      id: row.id,
      botId: row.bot_id,
      title: row.title,
      defaultPersona: row.default_persona === null ? null : JSON.parse(row.default_persona),
      revision: row.revision,
    };
  }
  folder(botId: string, id: string): ChatFolder {
    const row = this.store.db
      .prepare('SELECT * FROM chat_folders WHERE id=? AND bot_id=?')
      .get(id, botId) as Row | undefined;
    if (!row) throw new AppError(409, 'REVISION_CONFLICT');
    return this.mapFolder(row);
  }
  folders(botId: string): ChatFolder[] {
    this.bot(botId);
    return (
      this.store.db
        .prepare('SELECT * FROM chat_folders WHERE bot_id=? ORDER BY title,id')
        .all(botId) as Row[]
    ).map((row) => this.mapFolder(row));
  }
  private persona({ id }: PersonaChoice): ContentRef {
    const content = this.store.product.available<Content>('content', id);
    if (content.kind !== 'persona' && !content.package)
      throw new HttpError(400, 'Folder default must be a persona or package');
    return { id, revision: content.revision };
  }
  private optionalPersona(ref: PersonaChoice | null): ContentRef | null {
    return ref === null ? null : this.persona(ref);
  }
  createFolder({ botId, title, defaultPersona = null }: CreateChatFolder): ChatFolder {
    this.bot(botId, 'write');
    const persona = this.optionalPersona(defaultPersona);
    const id = randomUUID();
    this.store.db
      .prepare('INSERT INTO chat_folders VALUES(?,?,?,?,1)')
      .run(id, botId, title, persona === null ? null : JSON.stringify(persona));
    return this.folder(botId, id);
  }
  updateFolder({
    botId,
    folderId,
    expectedRevision,
    title,
    defaultPersona,
  }: UpdateChatFolder): ChatFolder {
    return this.store.transaction(() => {
      const prior = this.folder(botId, folderId);
      if (prior.revision !== expectedRevision) throw new AppError(409, 'REVISION_CONFLICT');
      const persona =
        defaultPersona === undefined ? prior.defaultPersona : this.optionalPersona(defaultPersona);
      this.store.db
        .prepare('UPDATE chat_folders SET title=?,default_persona=?,revision=revision+1 WHERE id=?')
        .run(title ?? prior.title, persona === null ? null : JSON.stringify(persona), folderId);
      return this.folder(botId, folderId);
    });
  }
  deleteFolder({ botId, folderId, expectedRevision }: DeleteChatFolder) {
    return this.store.transaction(() => {
      const folder = this.folder(botId, folderId);
      if (folder.revision !== expectedRevision) throw new AppError(409, 'REVISION_CONFLICT');
      const moved = this.orderedIds(botId, folderId);
      const unfiled = this.orderedIds(botId, null);
      this.store.db
        .prepare(
          'UPDATE chat_organization SET folder_id=NULL,revision=revision+1 WHERE folder_id=?'
        )
        .run(folderId);
      this.setPositions([...unfiled, ...moved]);
      this.store.db.prepare('DELETE FROM chat_folders WHERE id=?').run(folderId);
      for (const chatId of moved) this.store.event(chatId, 'organization.updated', chatId);
      return { deleted: true as const, movedChatIds: moved };
    });
  }
  create(
    chatId: string,
    selection: { botId?: string; folderId?: string | null; persona?: ContentRef | null } = {}
  ) {
    if (selection.botId === undefined) throw new HttpError(400, 'A chat requires an owning bot');
    const botId = text(selection.botId, 'bot ID', 100);
    const bot = this.bot(botId);
    const folderId = selection.folderId ?? null;
    const folder = folderId === null ? null : this.folder(botId, folderId);
    this.store.db
      .prepare('INSERT INTO chat_organization VALUES(?,?,?,1,?)')
      .run(chatId, botId, folderId, this.firstPosition(botId, folderId));
    const { revision: _revision, ...loreContext } = loreContextDefaults(this.store);
    const profile = { ...defaultProfile(chatId), loreContext };
    const personaRef = newChatPersona(
      this.defaults(botId).persona,
      folder?.defaultPersona,
      selection.persona === undefined ? undefined : this.optionalPersona(selection.persona)
    );
    if (personaRef && this.store.product.isHidden('content', personaRef.id))
      throw new AppError(409, 'CHAT_DEFAULT_PERSONA_DELETED');
    const persona = personaRef
      ? this.store.product.stored<Content>('content', personaRef.id)
      : null;
    const packageAttachments = [
      ...(bot?.package ? [{ id: bot.id, revision: bot.revision, role: 'bot' as const }] : []),
      ...(persona?.package
        ? [{ id: persona.id, revision: persona.revision, role: 'persona' as const }]
        : []),
    ];
    if (packageAttachments.length) profile.packageAttachments = packageAttachments;
    this.store.db
      .prepare('INSERT INTO profiles VALUES(?,?)')
      .run(
        chatId,
        JSON.stringify(
          Object.fromEntries(Object.entries(profile).filter(([key]) => key !== 'routes'))
        )
      );
  }
  copy(originalId: string, newId: string) {
    const original = this.metadata(originalId);
    if (!original) throw new HttpError(409, 'Chat organization is missing');
    this.store.db
      .prepare('INSERT INTO chat_organization VALUES(?,?,?,1,?)')
      .run(
        newId,
        original.botId,
        original.folderId,
        this.firstPosition(original.botId, original.folderId)
      );
  }
  move({ chatId, expectedRevision, folderId, beforeChatId = null }: MoveChat) {
    return this.store.transaction(() => {
      this.store.writableChat(chatId);
      const prior = this.metadata(chatId);
      if (!prior || prior.organizationRevision !== expectedRevision)
        throw new AppError(409, 'REVISION_CONFLICT');
      if (folderId !== null) this.folder(prior.botId, folderId);
      const siblings = this.orderedIds(prior.botId, folderId).filter((id) => id !== chatId);
      const index = beforeChatId === null ? siblings.length : siblings.indexOf(beforeChatId);
      if (index < 0) throw new AppError(409, 'REVISION_CONFLICT');
      siblings.splice(index, 0, chatId);
      this.store.db
        .prepare('UPDATE chat_organization SET folder_id=?,revision=revision+1 WHERE chat_id=?')
        .run(folderId, chatId);
      this.setPositions(siblings);
      this.store.event(chatId, 'organization.updated', chatId);
      return this.store.chat(chatId);
    });
  }
  pin({ chatId, pinned }: PinChat) {
    return this.store.transaction(() => {
      const prior = this.store.writableChat(chatId);
      if (!!prior.pinnedAt === pinned) return prior;
      if (pinned)
        this.store.db
          .prepare('INSERT INTO app_metadata(key,value) VALUES(?,?)')
          .run(CHAT_PIN_PREFIX + chatId, new Date().toISOString());
      else
        this.store.db.prepare('DELETE FROM app_metadata WHERE key=?').run(CHAT_PIN_PREFIX + chatId);
      this.store.event(chatId, 'organization.updated', chatId);
      return this.store.chat(chatId);
    });
  }
  assertBotAttachments(
    chatId: string,
    packageAttachments?: Array<ContentRef & { role: 'bot' | 'persona' | 'module' }>
  ) {
    const owner = this.metadata(chatId);
    if (!owner) throw new HttpError(409, 'Chat organization is missing');
    const bots = new Set([
      ...(packageAttachments ?? []).filter((ref) => ref.role === 'bot').map((ref) => ref.id),
    ]);
    if (bots.size !== 1 || !bots.has(owner.botId))
      throw new HttpError(409, 'A chat cannot replace or remove its owning bot');
  }
}

export function chatOrganizationRoutes(
  app: FastifyInstance,
  store: Store,
  publish: (chatId: string) => void
) {
  const org = store.organization;
  const endpoints = chatEndpoints,
    operations = chatOperations;
  registerEndpoint(app, endpoints.readBotDefaults, operations.readBotDefaults, ({ botId }) =>
    org.defaults(botId)
  );
  registerEndpoint(app, endpoints.updateBotDefaults, operations.updateBotDefaults, (input) =>
    org.updateDefaults(input)
  );
  registerEndpoint(app, endpoints.listFolders, operations.listFolders, ({ botId }) =>
    org.folders(botId)
  );
  registerEndpoint(app, endpoints.createFolder, operations.createFolder, (input) =>
    org.createFolder(input)
  );
  registerEndpoint(app, endpoints.updateFolder, operations.updateFolder, (input) =>
    org.updateFolder(input)
  );
  registerEndpoint(app, endpoints.deleteFolder, operations.deleteFolder, (input) => {
    const result = org.deleteFolder(input);
    result.movedChatIds.forEach(publish);
    return result;
  });
  registerEndpoint(app, endpoints.pinChat, operations.pinChat, (input) => {
    const chat = org.pin(input);
    publish(chat.id);
    return chat;
  });
  registerEndpoint(app, endpoints.moveChat, operations.moveChat, (input) => {
    const chat = org.move(input);
    publish(chat.id);
    return chat;
  });
}
