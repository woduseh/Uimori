import { createHash } from 'node:crypto';
import type { HelperTask } from '../core/helper.js';
import type { Content } from '../core/product.js';
import type { Json, ProviderTool } from '../core/transport.js';
import type { Run } from '../core/types.js';
import type { UiLocale } from '../core/ui-locale.js';
import { assertChatIdleForDeletion, deleteChat } from './chat-deletion.js';
import { createChat } from './chat-creation.js';
import { recordHelperTaskResult } from './helper-task-results.js';
import type { HelperWorkspace } from './helper-workspace.js';
import { createPackageStart } from './package-start.js';
import { fields, HttpError, record, text } from './request-validation.js';
import type { Store } from './store.js';

const id: Json = { type: 'string', minLength: 1, maxLength: 100 };

export const HELPER_CHAT_LIFECYCLE_TOOLS: ProviderTool[] = [
  {
    name: 'chat.create',
    description:
      "Start a new chat with a saved bot, as the new chat screen does. The chat is created and listed but not opened: the result card lets the user open it. persona omitted uses the persona that new chats of the bot or folder start with (chat.organize read shows it), null starts without one. startId picks which of the bot's first messages is written as the opening scene: omitted uses the first message (start-0) when the bot has one, or its only opening; null writes none, so the chat starts empty. title omitted names the chat after the bot and lets the app retitle it from the story once a title model is selected. Returns the chatId, the revisions that chat operations take (headRevision is the opening scene, null when empty) and the opening run when one was queued; pass chatId to chat operations to keep working in the new chat.",
    inputSchema: {
      type: 'object',
      properties: {
        botId: { ...(id as object), description: 'The saved bot the chat is with.' },
        persona: {
          type: ['string', 'null'],
          maxLength: 100,
          description: 'Saved persona id, or null for none. Omit for the default persona.',
        },
        startId: {
          type: ['string', 'null'],
          maxLength: 100,
          description:
            'Id of one of the bot package starts (resource.read path /package/starts), or null for no opening scene.',
        },
        title: { type: 'string', minLength: 1, maxLength: 200, description: 'Chat title.' },
        folderId: {
          type: ['string', 'null'],
          maxLength: 100,
          description:
            "Folder of the bot's chats from chat.organize read; null or omitted for the top level.",
        },
      },
      required: ['botId'],
      additionalProperties: false,
    },
  },
  {
    name: 'chat.delete',
    description:
      'Permanently delete a chat, as the chat list does: its scenes, translations, notes, outline, chat-only lore, illustrations, run records and its own helper conversations go; independent copies and shared library resources stay, and usage totals stay without their text. There is no undo, so the call waits for the owner confirmation. A chat with a running or queued scene, job or helper task cannot be deleted until it ends, and the chat this helper conversation belongs to cannot be deleted from here, because the deletion would delete this conversation and the task making the call. Returns the deleted chat id and how many helper conversations went with it.',
    inputSchema: {
      type: 'object',
      properties: {
        chatId: { ...(id as object), description: 'The chat to delete, from chat.list.' },
      },
      required: ['chatId'],
      additionalProperties: false,
    },
  },
];

function bot(store: Store, botId: string) {
  store.product.assertAvailable('content', botId);
  const content = store.product.get<Content>('content', botId);
  if (content.kind !== 'bot') throw new HttpError(400, `NOT_A_BOT: ${botId} is a ${content.kind}.`);
  return content;
}

function persona(store: Store, value: unknown) {
  if (value === undefined) return {};
  if (value === null) return { persona: null };
  const personaId = text(value, 'persona ID', 100);
  store.product.assertAvailable('content', personaId);
  const content = store.product.get<Content>('content', personaId);
  if (content.kind !== 'persona')
    throw new HttpError(400, `NOT_A_PERSONA: ${personaId} is a ${content.kind}.`);
  return { persona: { id: content.id, revision: content.revision } };
}

function openingId(content: Content, value: unknown) {
  const starts = content.package?.starts ?? [];
  if (value === null) return null;
  if (value !== undefined) {
    const startId = text(value, 'start ID', 100);
    if (!starts.some((start) => start.id === startId))
      throw new HttpError(400, `PACKAGE_START_NOT_FOUND: the bot has no start ${startId}.`);
    return startId;
  }
  if (starts.some((start) => start.id === 'start-0')) return 'start-0';
  return starts.length === 1 ? starts[0]!.id : null;
}

export function createHelperChat(
  store: Store,
  workspace: HelperWorkspace,
  task: Pick<HelperTask, 'id' | 'conversationId'>,
  receiptId: string,
  value: unknown
): { result: Record<string, unknown>; run: Run | null; autoTitleLocale: UiLocale | null } {
  const args = record(value);
  fields(args, ['botId', 'persona', 'startId', 'title', 'folderId']);
  const owner = bot(store, text(args.botId, 'bot ID', 100));
  const startId = openingId(owner, args.startId);
  const { chat, autoTitleLocale } = createChat(store, {
    title: args.title ?? owner.title,
    autoTitle: args.title === undefined,
    botId: owner.id,
    ...(args.folderId === undefined ? {} : { folderId: args.folderId }),
    ...persona(store, args.persona),
  });
  const run = startId
    ? createPackageStart(store, chat.id, {
        packageId: owner.id,
        packageRevision: owner.revision,
        startId,
        expectedSettingsRevision: chat.settingsRevision,
        expectedProfileRevision: store.product.profile(chat.id).revision,
        idempotencyKey: `helper:${createHash('sha256').update(receiptId).digest('hex')}`,
      }).run
    : null;
  const created = store.chat(chat.id);
  const profile = store.product.profile(chat.id);
  recordHelperTaskResult(workspace, task, {
    receiptId,
    operation: 'chat.create',
    requestedTargets: 1,
    targets: [
      { kind: 'chat', id: created.id, title: created.title, revision: created.titleRevision ?? 0 },
    ],
  });
  return {
    result: {
      chatId: created.id,
      title: created.title,
      botId: owner.id,
      folderId: created.folderId ?? null,
      startId,
      headRevision: created.headRevision,
      titleRevision: created.titleRevision,
      settingsRevision: created.settingsRevision,
      profileRevision: profile.revision,
      ...(run ? { openingRun: { id: run.id, status: run.status } } : {}),
    },
    run,
    autoTitleLocale,
  };
}

export function deleteHelperChat(
  store: Store,
  workspace: HelperWorkspace,
  task: Pick<HelperTask, 'id' | 'conversationId' | 'snapshot'>,
  receiptId: string,
  value: unknown
) {
  const args = record(value);
  fields(args, ['chatId']);
  const chatId = text(args.chatId, 'chat ID', 100);
  const scope = task.snapshot.scope;
  if (scope.kind === 'chat' && scope.chatId === chatId)
    throw new HttpError(
      409,
      'CURRENT_CHAT_DELETION: deleting this chat would also delete this helper conversation and the task making the call. Tell the owner to delete it from the chat list, or from a helper conversation in the library.'
    );
  const chat = store.chat(chatId);
  assertChatIdleForDeletion(store, chatId);
  const conversations = Number(
    store.db.prepare('SELECT COUNT(*) AS n FROM helper_conversations WHERE chat_id=?').get(chatId)
      ?.n ?? 0
  );
  deleteChat(store, chatId, {});
  recordHelperTaskResult(workspace, task, {
    receiptId,
    operation: 'chat.delete',
    requestedTargets: 1,
    targets: [{ kind: 'chat', id: chatId, title: chat.title, revision: chat.titleRevision ?? 0 }],
  });
  return { deleted: true, chatId, title: chat.title, deletedHelperConversations: conversations };
}
