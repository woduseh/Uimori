import type { ContentRef } from './product.js';

export type BotPersonaDefault =
  | { mode: 'inherit' }
  | { mode: 'none' }
  | { mode: 'persona'; persona: ContentRef };
export type BotDefaults = { revision: number; persona: BotPersonaDefault };

/** Defaults are used only while choosing a new chat's starting persona. */
export function newChatPersona(
  bot: BotPersonaDefault,
  folder: ContentRef | null = null,
  explicit?: ContentRef | null
): ContentRef | null {
  if (explicit !== undefined) return explicit;
  return bot.mode === 'persona' ? bot.persona : bot.mode === 'none' ? null : folder;
}
