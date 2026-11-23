import { isStoryUiStyleSetting, type StoryUiStyleSetting } from './story-ui-style.js';
import type { Settings } from './types.js';

export type AutoTranslationDefaults = { revision: number; autoTranslate: boolean };

export const MAX_MAIN_MODEL_CALLS = 128;
export const MAX_AUTO_REFUSAL_RETRIES = 5;

export type ChatGenerationDefaults = {
  revision: number;
  maxCalls: number;
  storyUi: boolean;
  storyUiStyle: StoryUiStyleSetting;
  autoRefusalRetryEnabled: boolean;
  autoRefusalMaxRetries: number;
};

export const DEFAULT_CHAT_GENERATION_DEFAULTS: Readonly<ChatGenerationDefaults> = {
  revision: 0,
  maxCalls: 8,
  storyUi: false,
  storyUiStyle: 'auto',
  autoRefusalRetryEnabled: true,
  autoRefusalMaxRetries: 2,
};

export function isAutoRefusalRetryCount(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_AUTO_REFUSAL_RETRIES
  );
}

export function autoRefusalRetryLimit(
  settings: Settings,
  defaults: Pick<ChatGenerationDefaults, 'autoRefusalRetryEnabled' | 'autoRefusalMaxRetries'>
): number {
  return (settings.autoRefusalRetryEnabled ?? defaults.autoRefusalRetryEnabled)
    ? (settings.autoRefusalMaxRetries ?? defaults.autoRefusalMaxRetries)
    : 0;
}

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
  if (
    input.autoRefusalRetryEnabled !== undefined &&
    typeof input.autoRefusalRetryEnabled !== 'boolean'
  )
    throw Object.assign(new Error('Invalid automatic refusal retry setting'), { statusCode: 400 });
  if (
    input.autoRefusalMaxRetries !== undefined &&
    !isAutoRefusalRetryCount(input.autoRefusalMaxRetries)
  )
    throw Object.assign(new Error('Invalid automatic refusal retry limit'), { statusCode: 400 });
  return {
    maxCalls: input.maxCalls!,
    ...(input.autoTranslate !== undefined ? { autoTranslate: input.autoTranslate } : {}),
    ...(input.storyUi !== undefined ? { storyUi: input.storyUi } : {}),
    ...(input.storyUiStyle !== undefined ? { storyUiStyle: input.storyUiStyle } : {}),
    ...(input.autoRefusalRetryEnabled !== undefined
      ? { autoRefusalRetryEnabled: input.autoRefusalRetryEnabled }
      : {}),
    ...(input.autoRefusalMaxRetries !== undefined
      ? { autoRefusalMaxRetries: input.autoRefusalMaxRetries }
      : {}),
  };
}
