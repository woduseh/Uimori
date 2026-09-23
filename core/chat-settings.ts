import type { Settings } from './types.js';

/** Project supported saved settings; retired fields in existing DBs/backups are ignored. */
export function normalizeChatSettings(value: unknown): Settings {
  const input = value as Partial<Settings> | null;
  if (
    !input ||
    typeof input.status !== 'boolean' ||
    !Number.isSafeInteger(input.maxCalls) ||
    input.maxCalls! < 1 ||
    input.maxCalls! > 32
  )
    throw Object.assign(new Error('Invalid settings'), { statusCode: 400 });
  return { status: input.status, maxCalls: input.maxCalls! };
}
