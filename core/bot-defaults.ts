import type { ContentRef } from './product.js';

export type BotPersonaDefault =
  | { mode: 'inherit' }
  | { mode: 'none' }
  | { mode: 'persona'; persona: ContentRef };
export type BotDefaults = { revision: number; persona: BotPersonaDefault };

export function newChatPersona(
  bot: BotPersonaDefault,
  folder: ContentRef | null = null,
  explicit?: ContentRef | null
): ContentRef | null {
  if (explicit !== undefined) return explicit;
  if (folder !== null) return folder;
  return bot.mode === 'persona' ? bot.persona : null;
}
