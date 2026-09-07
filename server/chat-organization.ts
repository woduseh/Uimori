import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { defaultProfile, type Content, type ContentRef, type ChatFolder } from '../core/product.js';
import { HttpError, type Store } from './store.js';
import { fields, number, record, text } from './product-store.js';

export const organizationTables = ['chat_folders', 'chat_organization'];
export type { ChatFolder } from '../core/product.js';
export type ChatOrganization = {
  botId: string;
  folderId: string | null;
  organizationRevision: number;
  sortPosition: number;
};
type Row = Record<string, any>;

/** Organization never rewrites execution inputs or story content. */
export class ChatOrganizationStore {
  constructor(readonly store: Store) {}
  init() {
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS chat_folders(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,title TEXT NOT NULL,default_persona TEXT,revision INTEGER NOT NULL CHECK(revision>0));
      CREATE TABLE IF NOT EXISTS chat_organization(chat_id TEXT PRIMARY KEY REFERENCES chats(id),bot_id TEXT NOT NULL,folder_id TEXT REFERENCES chat_folders(id),revision INTEGER NOT NULL CHECK(revision>0),sort_position INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS chat_folders_bot ON chat_folders(bot_id);
      CREATE INDEX IF NOT EXISTS chat_organization_folder ON chat_organization(folder_id);`);
  }
  bot(botId: string) {
    const bot = this.store.product.get<Content>('content', botId);
    if (bot.kind !== 'bot' && !bot.package)
      throw new HttpError(400, 'Organization owner must be a bot or package');
    return bot;
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
  /** Rank normalization changes no relative order or CAS revision of existing siblings. */
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
    if (!row) throw new HttpError(404, 'Folder not found for bot');
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
  private persona(value: unknown): ContentRef | null {
    if (value === null) return null;
    const b = record(value);
    fields(b, ['id', 'revision']);
    const ref = {
      id: text(b.id, 'persona ID', 100),
      revision: number(b.revision, 'persona revision'),
    };
    const content = this.store.product.get<Content>('content', ref.id, ref.revision);
    if (content.kind !== 'persona' && !content.package)
      throw new HttpError(400, 'Folder default must be a persona or package');
    return ref;
  }
  createFolder(botId: string, value: unknown): ChatFolder {
    this.bot(botId);
    const b = record(value);
    fields(b, ['title', 'defaultPersona']);
    const title = text(b.title, 'folder title', 200);
    const persona = b.defaultPersona === undefined ? null : this.persona(b.defaultPersona);
    const id = randomUUID();
    this.store.db
      .prepare('INSERT INTO chat_folders VALUES(?,?,?,?,1)')
      .run(id, botId, title, persona === null ? null : JSON.stringify(persona));
    return this.folder(botId, id);
  }
  updateFolder(botId: string, id: string, value: unknown): ChatFolder {
    const b = record(value);
    fields(b, ['expectedRevision', 'title', 'defaultPersona']);
    const expected = number(b.expectedRevision, 'folder revision');
    return this.store.transaction(() => {
      const prior = this.folder(botId, id);
      if (prior.revision !== expected) throw new HttpError(409, 'Folder revision conflict');
      const title = b.title === undefined ? prior.title : text(b.title, 'folder title', 200);
      const persona =
        b.defaultPersona === undefined ? prior.defaultPersona : this.persona(b.defaultPersona);
      this.store.db
        .prepare('UPDATE chat_folders SET title=?,default_persona=?,revision=revision+1 WHERE id=?')
        .run(title, persona === null ? null : JSON.stringify(persona), id);
      return this.folder(botId, id);
    });
  }
  deleteFolder(botId: string, id: string, value: unknown) {
    const b = record(value);
    fields(b, ['expectedRevision']);
    const expected = number(b.expectedRevision, 'folder revision');
    return this.store.transaction(() => {
      const folder = this.folder(botId, id);
      if (folder.revision !== expected) throw new HttpError(409, 'Folder revision conflict');
      const moved = this.orderedIds(botId, id);
      const unfiled = this.orderedIds(botId, null);
      this.store.db
        .prepare(
          'UPDATE chat_organization SET folder_id=NULL,revision=revision+1 WHERE folder_id=?'
        )
        .run(id);
      this.setPositions([...unfiled, ...moved]);
      this.store.db.prepare('DELETE FROM chat_folders WHERE id=?').run(id);
      for (const chatId of moved) this.store.event(chatId, 'organization.updated', chatId);
      return { deleted: true, movedChatIds: moved };
    });
  }
  /** Called inside the chat creation transaction. */
  create(chatId: string, selection: { botId?: string; folderId?: string | null } = {}) {
    if (selection.botId === undefined) throw new HttpError(400, 'A chat requires an owning bot');
    const botId = text(selection.botId, 'bot ID', 100);
    const bot = this.bot(botId);
    const folderId = selection.folderId ?? null;
    const folder = folderId === null ? null : this.folder(botId, folderId);
    this.store.db
      .prepare('INSERT INTO chat_organization VALUES(?,?,?,1,?)')
      .run(chatId, botId, folderId, this.firstPosition(botId, folderId));
    if (bot || folder?.defaultPersona) {
      const profile = defaultProfile(chatId);
      const persona = folder?.defaultPersona
        ? this.store.product.get<Content>(
            'content',
            folder.defaultPersona.id,
            folder.defaultPersona.revision
          )
        : null;
      profile.attachments = [
        ...(bot && !bot.package ? [{ id: bot.id, revision: bot.revision }] : []),
        ...(persona && !persona.package ? [{ id: persona.id, revision: persona.revision }] : []),
      ];
      const packageAttachments = [
        ...(bot?.package ? [{ id: bot.id, revision: bot.revision, role: 'bot' as const }] : []),
        ...(persona?.package
          ? [{ id: persona.id, revision: persona.revision, role: 'persona' as const }]
          : []),
      ];
      if (packageAttachments.length) profile.packageAttachments = packageAttachments;
      this.store.db
        .prepare('INSERT INTO profiles VALUES(?,?)')
        .run(chatId, JSON.stringify(profile));
    }
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
  move(chatId: string, value: unknown) {
    const b = record(value);
    fields(b, ['expectedRevision', 'folderId', 'beforeChatId']);
    const expected = number(b.expectedRevision, 'organization revision');
    const folderId = b.folderId === null ? null : text(b.folderId, 'folder ID', 100);
    const beforeChatId =
      b.beforeChatId == null ? null : text(b.beforeChatId, 'before chat ID', 100);
    return this.store.transaction(() => {
      this.store.chat(chatId);
      const prior = this.metadata(chatId);
      if (!prior || prior.organizationRevision !== expected)
        throw new HttpError(409, 'Organization revision conflict');
      if (folderId !== null) this.folder(prior.botId, folderId);
      const siblings = this.orderedIds(prior.botId, folderId).filter((id) => id !== chatId);
      const index = beforeChatId === null ? siblings.length : siblings.indexOf(beforeChatId);
      if (index < 0)
        throw new HttpError(409, 'Order anchor is not another chat in the destination folder');
      siblings.splice(index, 0, chatId);
      this.store.db
        .prepare('UPDATE chat_organization SET folder_id=?,revision=revision+1 WHERE chat_id=?')
        .run(folderId, chatId);
      this.setPositions(siblings);
      this.store.event(chatId, 'organization.updated', chatId);
      return this.store.chat(chatId);
    });
  }
  assertBotAttachments(
    chatId: string,
    attachments: ContentRef[],
    packageAttachments?: Array<ContentRef & { role: 'bot' | 'persona' | 'module' }>
  ) {
    const owner = this.metadata(chatId);
    if (!owner) throw new HttpError(409, 'Chat organization is missing');
    const bots = new Set([
      ...attachments
        .map((ref) => this.store.product.get<Content>('content', ref.id, ref.revision))
        .filter((content) => content.kind === 'bot')
        .map((content) => content.id),
      ...(packageAttachments ?? []).filter((ref) => ref.role === 'bot').map((ref) => ref.id),
    ]);
    if (bots.size !== 1 || !bots.has(owner.botId))
      throw new HttpError(409, 'A chat cannot replace or remove its owning bot');
  }
  validateArchive() {
    if (
      this.store.db
        .prepare(
          'SELECT 1 FROM chats c LEFT JOIN chat_organization o ON o.chat_id=c.id WHERE o.chat_id IS NULL LIMIT 1'
        )
        .get()
    )
      throw new HttpError(400, 'Missing chat organization');
    for (const row of this.store.db.prepare('SELECT * FROM chat_folders').all() as Row[]) {
      this.bot(row.bot_id);
      text(row.title, 'folder title', 200);
      number(row.revision, 'folder revision');
      if (row.default_persona !== null) this.persona(JSON.parse(row.default_persona));
    }
    for (const row of this.store.db.prepare('SELECT * FROM chat_organization').all() as Row[]) {
      this.bot(row.bot_id);
      number(row.revision, 'organization revision');
      if (!Number.isSafeInteger(row.sort_position))
        throw new HttpError(400, 'Invalid chat sort position');
      if (row.folder_id !== null) this.folder(row.bot_id, row.folder_id);
      const profile = this.store.product.profile(row.chat_id);
      this.assertBotAttachments(row.chat_id, profile.attachments, profile.packageAttachments);
    }
  }
}

export function chatOrganizationRoutes(
  app: FastifyInstance,
  store: Store,
  publish: (chatId: string) => void
) {
  const org = store.organization;
  app.get<{ Params: { botId: string } }>('/api/bots/:botId/folders', async (request) =>
    org.folders(request.params.botId)
  );
  app.post<{ Params: { botId: string } }>('/api/bots/:botId/folders', async (request) =>
    org.createFolder(request.params.botId, request.body)
  );
  app.patch<{ Params: { botId: string; folderId: string } }>(
    '/api/bots/:botId/folders/:folderId',
    async (request) => org.updateFolder(request.params.botId, request.params.folderId, request.body)
  );
  app.delete<{ Params: { botId: string; folderId: string } }>(
    '/api/bots/:botId/folders/:folderId',
    async (request) => {
      const result = org.deleteFolder(request.params.botId, request.params.folderId, request.body);
      result.movedChatIds.forEach(publish);
      return result;
    }
  );
  app.patch<{ Params: { id: string } }>('/api/chats/:id/organization', async (request) => {
    const chat = org.move(request.params.id, request.body);
    publish(chat.id);
    return chat;
  });
}
