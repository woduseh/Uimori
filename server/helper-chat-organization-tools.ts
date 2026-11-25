import type { HelperTask } from '../core/helper.js';
import type { Content, ContentRef } from '../core/product.js';
import type { Json, ProviderTool } from '../core/transport.js';
import { recordHelperTaskResult } from './helper-task-results.js';
import type { HelperWorkspace } from './helper-workspace.js';
import { fields, HttpError, number, record, text } from './request-validation.js';
import type { Store } from './store.js';

const id: Json = { type: 'string', minLength: 1, maxLength: 100 };
const CHAT_LIST_MAX = 200;

export const HELPER_CHAT_ORGANIZATION_TOOLS: ProviderTool[] = [
  {
    name: 'chat.organize',
    description:
      'Organize the chats of one bot into folders and choose the persona that new chats of that bot start with. action=read returns the bot default persona with its revision, the folders with their revisions and default personas, and each chat of the bot with its folderId, organizationRevision and whether it is pinned. create-folder takes title and an optional defaultPersona. update-folder takes folderId, expectedRevision, and title or defaultPersona. delete-folder takes folderId and expectedRevision; its chats move to the top level and no chat is deleted. move takes chatId, expectedRevision (the organizationRevision of that chat) and folderId, null for the top level, and optionally beforeChatId to place it before another chat of that folder. pin takes chatId and pinned. set-default-persona takes expectedRevision (the defaults revision) and persona: inherit follows the app, none starts without a persona, or a saved persona id. A folder default persona wins over the bot default for chats created in that folder; existing chats keep their persona.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'read',
            'create-folder',
            'update-folder',
            'delete-folder',
            'move',
            'pin',
            'set-default-persona',
          ],
          description: 'What to do.',
        },
        pinned: {
          type: 'boolean',
          description: 'pin: true pins the chat to the top of the chat list, false unpins it.',
        },
        botId: { ...(id as object), description: 'The bot whose chats are organized.' },
        folderId: {
          type: ['string', 'null'],
          maxLength: 100,
          description: 'Folder id from action=read; null in move means the top level.',
        },
        chatId: { ...(id as object), description: 'move and pin: the chat to move or pin.' },
        beforeChatId: { ...(id as object), description: 'move: place the chat before this one.' },
        expectedRevision: {
          type: 'integer',
          minimum: 1,
          description: 'Revision of the folder, the chat organization or the bot defaults.',
        },
        title: { type: 'string', minLength: 1, maxLength: 200, description: 'Folder name.' },
        defaultPersona: {
          type: ['string', 'null'],
          maxLength: 100,
          description: 'Folder default persona id, or null for none.',
        },
        persona: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
          description: 'set-default-persona: inherit, none, or a saved persona id.',
        },
      },
      required: ['action', 'botId'],
      additionalProperties: false,
    },
  },
];

function personaRef(store: Store, value: unknown): ContentRef {
  const personaId = text(value, 'persona ID', 100);
  store.product.assertAvailable('content', personaId);
  const persona = store.product.get<Content>('content', personaId);
  if (persona.kind !== 'persona')
    throw new HttpError(400, `NOT_A_PERSONA: ${personaId} is a ${persona.kind}.`);
  return { id: persona.id, revision: persona.revision };
}

function personaView(store: Store, ref: ContentRef | null) {
  if (!ref) return null;
  let title: string | null = null;
  try {
    title = store.product.get<Content>('content', ref.id).title;
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
  }
  return { id: ref.id, title };
}

export function readHelperChatOrganization(store: Store, value: unknown) {
  const args = record(value);
  fields(args, ['action', 'botId']);
  const botId = text(args.botId, 'bot ID', 100);
  const organization = store.organization;
  const bot = organization.bot(botId);
  const defaults = organization.defaults(botId);
  const chatIds = (
    store.db
      .prepare(
        'SELECT chat_id FROM chat_organization WHERE bot_id=? ORDER BY folder_id IS NOT NULL,folder_id,sort_position,chat_id'
      )
      .all(botId) as { chat_id: string }[]
  ).map((row) => row.chat_id);
  return {
    botId,
    botTitle: bot.title,
    defaults: {
      revision: defaults.revision,
      persona:
        defaults.persona.mode === 'persona'
          ? { mode: 'persona', ...personaView(store, defaults.persona.persona) }
          : { mode: defaults.persona.mode },
    },
    folders: organization.folders(botId).map((folder) => ({
      id: folder.id,
      title: folder.title,
      revision: folder.revision,
      defaultPersona: personaView(store, folder.defaultPersona),
    })),
    chats: chatIds.slice(0, CHAT_LIST_MAX).map((chatId) => {
      const metadata = organization.metadata(chatId)!;
      const chat = store.chat(chatId);
      return {
        id: chatId,
        title: chat.title,
        folderId: metadata.folderId,
        organizationRevision: metadata.organizationRevision,
        pinned: !!chat.pinnedAt,
      };
    }),
    totalChats: chatIds.length,
  };
}

export function applyHelperChatOrganization(
  store: Store,
  workspace: HelperWorkspace,
  task: Pick<HelperTask, 'id' | 'conversationId'>,
  receiptId: string,
  value: unknown
): { changedChatIds: string[] } & Record<string, unknown> {
  const args = record(value);
  const botId = text(args.botId, 'bot ID', 100);
  const organization = store.organization;
  const bot = organization.bot(botId);
  const report = (revision: number) =>
    recordHelperTaskResult(workspace, task, {
      receiptId,
      operation: 'chat.organize',
      requestedTargets: 1,
      targets: [{ kind: 'content', id: botId, title: bot.title, revision }],
    });
  const defaultPersona = () =>
    args.defaultPersona === undefined
      ? {}
      : {
          defaultPersona:
            args.defaultPersona === null ? null : personaRef(store, args.defaultPersona),
        };
  switch (args.action) {
    case 'create-folder': {
      fields(args, ['action', 'botId', 'title', 'defaultPersona']);
      const folder = organization.createFolder(botId, { title: args.title, ...defaultPersona() });
      report(folder.revision);
      return { changedChatIds: [], folder };
    }
    case 'update-folder': {
      fields(args, ['action', 'botId', 'folderId', 'expectedRevision', 'title', 'defaultPersona']);
      const folder = organization.updateFolder(botId, text(args.folderId, 'folder ID', 100), {
        expectedRevision: args.expectedRevision,
        ...(args.title === undefined ? {} : { title: args.title }),
        ...defaultPersona(),
      });
      report(folder.revision);
      return { changedChatIds: [], folder };
    }
    case 'delete-folder': {
      fields(args, ['action', 'botId', 'folderId', 'expectedRevision']);
      const folderId = text(args.folderId, 'folder ID', 100);
      const result = organization.deleteFolder(botId, folderId, {
        expectedRevision: args.expectedRevision,
      });
      report(number(args.expectedRevision, 'folder revision'));
      return {
        changedChatIds: result.movedChatIds,
        deleted: folderId,
        movedChatIds: result.movedChatIds,
      };
    }
    case 'move': {
      fields(args, ['action', 'botId', 'chatId', 'expectedRevision', 'folderId', 'beforeChatId']);
      const chatId = text(args.chatId, 'chat ID', 100);
      if (organization.metadata(chatId)?.botId !== botId)
        throw new HttpError(409, 'CHAT_OF_ANOTHER_BOT: The chat belongs to another bot.');
      organization.move(chatId, {
        expectedRevision: args.expectedRevision,
        folderId: args.folderId === undefined ? null : args.folderId,
        ...(args.beforeChatId === undefined ? {} : { beforeChatId: args.beforeChatId }),
      });
      const moved = organization.metadata(chatId)!;
      recordHelperTaskResult(workspace, task, {
        receiptId,
        operation: 'chat.organize',
        requestedTargets: 1,
        targets: [
          {
            kind: 'chat',
            id: chatId,
            title: store.chat(chatId).title,
            revision: moved.organizationRevision,
          },
        ],
      });
      return {
        changedChatIds: [chatId],
        chatId,
        folderId: moved.folderId,
        organizationRevision: moved.organizationRevision,
      };
    }
    case 'pin': {
      fields(args, ['action', 'botId', 'chatId', 'pinned']);
      const chatId = text(args.chatId, 'chat ID', 100);
      if (organization.metadata(chatId)?.botId !== botId)
        throw new HttpError(409, 'CHAT_OF_ANOTHER_BOT: The chat belongs to another bot.');
      const before = !!store.chat(chatId).pinnedAt;
      const chat = organization.pin(chatId, { pinned: args.pinned });
      recordHelperTaskResult(workspace, task, {
        receiptId,
        operation: 'chat.organize',
        requestedTargets: 1,
        targets:
          before === !!chat.pinnedAt
            ? []
            : [{ kind: 'chat', id: chatId, title: chat.title, revision: chat.titleRevision ?? 0 }],
      });
      return { changedChatIds: [chatId], chatId, pinned: !!chat.pinnedAt };
    }
    case 'set-default-persona': {
      fields(args, ['action', 'botId', 'expectedRevision', 'persona']);
      const persona = text(args.persona, 'persona', 100);
      const defaults = organization.updateDefaults(botId, {
        expectedRevision: args.expectedRevision,
        persona:
          persona === 'inherit' || persona === 'none'
            ? { mode: persona }
            : { mode: 'persona', persona: personaRef(store, persona) },
      });
      report(defaults.revision);
      return { changedChatIds: [], defaults };
    }
  }
  throw new HttpError(400, 'INVALID_CHAT_ORGANIZE_ACTION');
}
