import type { Settings } from './types.js';

export type AutoTranslationDefaults = { revision: number; autoTranslate: boolean };

/** Project supported saved settings; retired fields in existing DBs/backups are ignored. */
export function normalizeChatSettings(value: unknown): Settings {
  const input = value as Partial<Settings> | null;
  if (
    !input ||
    !Number.isSafeInteger(input.maxCalls) ||
    input.maxCalls! < 1 ||
    input.maxCalls! > 32
  )
    throw Object.assign(new Error('Invalid settings'), { statusCode: 400 });
  if (input.autoTranslate !== undefined && typeof input.autoTranslate !== 'boolean')
    throw Object.assign(new Error('Invalid automatic translation setting'), { statusCode: 400 });
  return {
    maxCalls: input.maxCalls!,
    ...(input.autoTranslate !== undefined ? { autoTranslate: input.autoTranslate } : {}),
  };
}
