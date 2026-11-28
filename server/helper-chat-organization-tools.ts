import type { HelperTask } from '../core/helper.js';
import type { Content, ContentRef } from '../core/product.js';
import type { Json, ProviderTool } from '../core/transport.js';
import { recordHelperTaskResult } from './helper-task-results.js';
import type { HelperWorkspace } from './helper-workspace.js';
import { chatOperations } from '#contracts/operations';
import { AppError, HelperToolError } from './app-errors.js';
import { parseInput } from './endpoint.js';
import { fields, HttpError, record, text } from './request-validation.js';
import type { Store } from './store.js';
import type { SynchronousResult } from './synchronous-transaction.js';

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

function named<T>(target: string | null, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (target && error instanceof AppError && error.code === 'LIBRARY_ITEM_DELETED')
      throw new HelperToolError(404, 'LIBRARY_ITEM_DELETED', `${target} no longer exists.`);
    throw error;
  }
}

function withPersona<T>(
  store: Store,
  id: string | null,
  save: () => SynchronousResult<T>
): SynchronousResult<T> {
  return store.transaction(() => {
    const saved = named(id === null ? null : `persona ${id}`, save);
    const kind = id === null ? 'persona' : store.product.stored<Content>('content', id).kind;
    if (kind !== 'persona') throw new HelperToolError(400, 'NOT_A_PERSONA', `${id} is a ${kind}.`);
    return saved;
  });
}

function personaView(store: Store, ref: ContentRef | null) {
  if (!ref) return null;
  let title: string | null = null;
  try {
    title = store.product.stored<Content>('content', ref.id).title;
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
  }
  return { id: ref.id, title };
}

function ownedChat(store: Store, botId: string, chatId: string) {
  const owner = store.organization.metadata(chatId)?.botId;
  if (owner === undefined) throw new AppError(409, 'REVISION_CONFLICT');
  if (owner !== botId)
    throw new HelperToolError(409, 'CHAT_OF_ANOTHER_BOT', 'The chat belongs to another bot.');
}

export function readHelperChatOrganization(store: Store, value: unknown) {
  const args = record(value);
  fields(args, ['action', 'botId']);
  const botId = text(args.botId, 'bot ID', 100);
  const organization = store.organization;
  const bot = named(`bot ${botId}`, () => organization.bot(botId));
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
  const bot = named(`bot ${botId}`, () => organization.bot(botId));
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
            args.defaultPersona === null
              ? null
              : { id: text(args.defaultPersona, 'persona ID', 100) },
        };
  const folderPersona = (input: { defaultPersona?: { id: string } | null }) =>
    input.defaultPersona?.id ?? null;
  const title = args.title === undefined ? {} : { title: args.title };
  switch (args.action) {
    case 'create-folder': {
      fields(args, ['action', 'botId', 'title', 'defaultPersona']);
      const input = parseInput(chatOperations.createFolder.input, {
        botId,
        ...title,
        ...defaultPersona(),
      });
      const folder = withPersona(store, folderPersona(input), () =>
        organization.createFolder(input)
      );
      report(folder.revision);
      return { changedChatIds: [], folder };
    }
    case 'update-folder': {
      fields(args, ['action', 'botId', 'folderId', 'expectedRevision', 'title', 'defaultPersona']);
      const input = parseInput(chatOperations.updateFolder.input, {
        botId,
        folderId: args.folderId,
        expectedRevision: args.expectedRevision,
        ...title,
        ...defaultPersona(),
      });
      const folder = withPersona(store, folderPersona(input), () =>
        organization.updateFolder(input)
      );
      report(folder.revision);
      return { changedChatIds: [], folder };
    }
    case 'delete-folder': {
      fields(args, ['action', 'botId', 'folderId', 'expectedRevision']);
      const input = parseInput(chatOperations.deleteFolder.input, {
        botId,
        folderId: args.folderId,
        expectedRevision: args.expectedRevision,
      });
      const result = organization.deleteFolder(input);
      report(input.expectedRevision);
      return {
        changedChatIds: result.movedChatIds,
        deleted: input.folderId,
        movedChatIds: result.movedChatIds,
      };
    }
    case 'move': {
      fields(args, ['action', 'botId', 'chatId', 'expectedRevision', 'folderId', 'beforeChatId']);
      const input = parseInput(chatOperations.moveChat.input, {
        chatId: args.chatId,
        expectedRevision: args.expectedRevision,
        folderId: args.folderId === undefined ? null : args.folderId,
        ...(args.beforeChatId === undefined ? {} : { beforeChatId: args.beforeChatId }),
      });
      const { chatId } = input;
      ownedChat(store, botId, chatId);
      organization.move(input);
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
      const input = parseInput(chatOperations.pinChat.input, {
        chatId: args.chatId,
        pinned: args.pinned,
      });
      const { chatId } = input;
      ownedChat(store, botId, chatId);
      const before = !!store.chat(chatId).pinnedAt;
      const chat = organization.pin(input);
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
      const choice = text(args.persona, 'persona', 100);
      const input = parseInput(chatOperations.updateBotDefaults.input, {
        botId,
        expectedRevision: args.expectedRevision,
        persona:
          choice === 'inherit' || choice === 'none'
            ? { mode: choice }
            : { mode: 'persona', persona: { id: choice } },
      });
      const defaults = withPersona(
        store,
        input.persona.mode === 'persona' ? input.persona.persona.id : null,
        () => organization.updateDefaults(input)
      );
      report(defaults.revision);
      return { changedChatIds: [], defaults };
    }
  }
  throw new HelperToolError(400, 'INVALID_CHAT_ORGANIZE_ACTION');
}
