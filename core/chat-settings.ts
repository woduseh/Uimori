import { isStoryUiStyleSetting, type StoryUiStyleSetting } from './story-ui-style.js';
import type { Settings } from './types.js';

export type AutoTranslationDefaults = { revision: number; autoTranslate: boolean };

export const MAX_MAIN_MODEL_CALLS = 128;

export type ChatGenerationDefaults = {
  revision: number;
  maxCalls: number;
  storyUi: boolean;
  storyUiStyle: StoryUiStyleSetting;
};

export const DEFAULT_CHAT_GENERATION_DEFAULTS: Readonly<ChatGenerationDefaults> = {
  revision: 0,
  maxCalls: 8,
  storyUi: false,
  storyUiStyle: 'auto',
};

/** Project supported saved settings; retired fields in existing DBs/backups are ignored. */
export function normalizeChatSettings(value: unknown): Settings {
  const input = value as Partial<Settings> | null;
  if (
    !input ||
    !Number.isSafeInteger(input.maxCalls) ||
    input.maxCalls! < 1 ||
    input.maxCalls! > MAX_MAIN_MODEL_CALLS
  )
    throw Object.assign(new Error('Invalid settings'), { statusCode: 400 });
  if (input.autoTranslate !== undefined && typeof input.autoTranslate !== 'boolean')
    throw Object.assign(new Error('Invalid automatic translation setting'), { statusCode: 400 });
  if (input.storyUi !== undefined && typeof input.storyUi !== 'boolean')
    throw Object.assign(new Error('Invalid story UI setting'), { statusCode: 400 });
  if (input.storyUiStyle !== undefined && !isStoryUiStyleSetting(input.storyUiStyle))
    throw Object.assign(new Error('Invalid story UI style'), { statusCode: 400 });
  return {
    maxCalls: input.maxCalls!,
    ...(input.autoTranslate !== undefined ? { autoTranslate: input.autoTranslate } : {}),
    ...(input.storyUi !== undefined ? { storyUi: input.storyUi } : {}),
    ...(input.storyUiStyle !== undefined ? { storyUiStyle: input.storyUiStyle } : {}),
  };
}
