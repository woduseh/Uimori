import type { Store } from './store.js';
import type { Content } from '../core/product.js';
import {
  readTranslationGuide,
  validateTranslationGuide,
  type BotTranslationGuide,
} from '../core/translation-guide.js';

/** Capture once at translation admission. Never combine persona/module/chat-local guides. */
export function currentBotTranslationGuide(
  store: Store,
  chatId: string
): BotTranslationGuide | null {
  const botId = store.chat(chatId).botId;
  const bot = store.product.get<Content>('content', botId);
  const native = bot.package.nativeRisu;
  const document = Object.keys(native.card).length ? native.card : (native.module ?? {});
  const guide = validateTranslationGuide(readTranslationGuide(document));
  if (!guide.instructions.trim() && !guide.terms.length) return null;
  return { botId: bot.id, botTitle: bot.title, botRevision: bot.revision, ...guide };
}
