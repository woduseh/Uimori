import type { ContentRef } from '../core/product.js';
import type { Chat } from '../core/types.js';
import { supportedLocale, type UiLocale } from '../core/ui-locale.js';
import { chatTitle, fields, HttpError, number, record, text } from './request-validation.js';
import type { Store } from './store.js';

export function createChat(
  store: Store,
  value: unknown
): { chat: Chat; autoTitleLocale: UiLocale | null } {
  const body = record(value);
  fields(body, ['title', 'botId', 'folderId', 'autoTitle', 'titleLocale', 'persona']);
  if (body.autoTitle !== undefined && typeof body.autoTitle !== 'boolean')
    throw new HttpError(400, 'Invalid automatic title choice');
  let persona: ContentRef | null | undefined;
  if (body.persona === null) persona = null;
  else if (body.persona !== undefined) {
    const ref = record(body.persona);
    fields(ref, ['id', 'revision']);
    persona = {
      id: text(ref.id, 'persona ID', 100),
      revision: number(ref.revision, 'persona revision'),
    };
  }
  const botId = body.botId === undefined ? undefined : text(body.botId, 'bot ID', 100);
  if (botId !== undefined) store.product.assertAvailable('content', botId);
  const chat = store.createChat(chatTitle(body.title), {
    ...(botId === undefined ? {} : { botId }),
    ...(body.folderId === undefined
      ? {}
      : { folderId: body.folderId === null ? null : text(body.folderId, 'folder ID', 100) }),
    ...(persona === undefined ? {} : { persona }),
  });
  return {
    chat,
    autoTitleLocale: body.autoTitle === true ? supportedLocale(body.titleLocale) : null,
  };
}
