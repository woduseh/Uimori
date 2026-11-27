import { captureChatCopy, restoreChatCopy } from './chat-copy.js';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { chatEndpoints, type ForkChat } from '#contracts';
import { chatOperations } from '#contracts/operations';
import { HttpError } from './request-validation.js';
import type { Chat, Store } from './store.js';
import { AppError } from './app-errors.js';
import { supportedLocale, type UiLocale } from '../core/ui-locale.js';
import { registerEndpoint } from './endpoint.js';

const COPY_LABELS: Record<UiLocale, string> = { ko: '사본', en: 'copy', ja: 'コピー', zh: '副本' };
const COPY_SUFFIX_RUNS = new RegExp(
  `(?: \\((?:${Object.values(COPY_LABELS).join('|')})(?: [1-9]\\d*)?\\))+`,
  'gu'
);

function numberedCopyTitle(store: Store, title: string, locale: UiLocale): string {
  const base =
    title.replace(COPY_SUFFIX_RUNS, (run, offset) =>
      offset + run.length === title.length ? '' : run
    ) || title;
  const label = COPY_LABELS[locale];
  let last = 0;
  for (const row of store.db.prepare('SELECT title FROM chats').all()) {
    const existing = String(row.title);
    const match = existing.match(/ \(([^\s()]+) ([1-9]\d*)\)$/u);
    if (!match || match[1] !== label || existing.slice(0, match.index) !== base) continue;
    const number = Number(match[2]);
    if (Number.isSafeInteger(number)) last = Math.max(last, number);
  }
  return `${base} (${label} ${last + 1})`;
}

export function forkChat(
  store: Store,
  chatId: string,
  {
    fromRevision: sourceId,
    title,
    titleLocale,
    idempotencyKey: requestKey,
  }: Omit<ForkChat, 'chatId'>
): Chat {
  const requestedTitle = title ?? null;
  const command = createHash('sha256')
    .update(JSON.stringify({ chatId, sourceId, title: requestedTitle }))
    .digest('hex');
  return store.transaction(() => {
    const receiptKey = `transcript:copy:${requestKey}`;
    const row = store.db
      .prepare('SELECT result FROM import_operations WHERE key=?')
      .get(receiptKey);
    const saved = row
      ? (JSON.parse(String(row.result)) as { chatId: string; forkCommand?: string })
      : undefined;
    if (saved) {
      if (!saved.forkCommand || typeof saved.chatId !== 'string' || !saved.chatId.trim())
        throw new AppError(409, 'CHAT_COPY_RECEIPT_UNVERIFIED');
      if (saved.forkCommand !== command)
        throw new HttpError(409, 'Idempotency key reused with different command');
      if (!store.db.prepare('SELECT 1 FROM chats WHERE id=?').get(saved.chatId))
        throw new AppError(410, 'CHAT_COPY_REMOVED');
      return store.chat(saved.chatId);
    }
    const original = store.writableChat(chatId);
    const title =
      requestedTitle ?? numberedCopyTitle(store, original.title, supportedLocale(titleLocale));
    const copy = captureChatCopy(store, chatId, sourceId);
    const restored = restoreChatCopy(store, copy, `copy:${requestKey}`, title);
    store.db
      .prepare("UPDATE import_operations SET result=json_set(result,'$.forkCommand',?) WHERE key=?")
      .run(command, receiptKey);
    if (restored.folderId !== original.folderId)
      store.organization.move({
        chatId: restored.id,
        expectedRevision: restored.organizationRevision!,
        folderId: original.folderId ?? null,
      });
    store.event(
      restored.id,
      'chat.forked',
      JSON.stringify({ chatId, fromRevision: sourceId, title })
    );
    return store.chat(restored.id);
  });
}

export function chatForkRoutes(
  app: FastifyInstance,
  store: Store,
  publish: (chatId: string) => void
) {
  registerEndpoint(
    app,
    chatEndpoints.forkChat,
    chatOperations.forkChat,
    ({ chatId, ...change }) => {
      const chat = forkChat(store, chatId, change);
      publish(chat.id);
      return chat;
    }
  );
}
