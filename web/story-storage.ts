import {
  readOptionalJson,
  removeOptionalStorage,
  writeOptionalStorage,
} from './optional-storage.js';

export function commandStorageKey(chatId: string) {
  return `command:${chatId}`;
}

export type ReadingPosition = {
  target?: string;
  source: string;
  anchor: string;
  offset: number;
  top: number;
};

function optionalCache(key: string, persistent = false): Record<string, unknown> | null {
  const value = readOptionalJson(persistent ? 'local' : 'session', key, null);
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function writeViewCache(key: `reading:${string}` | `cursor:${string}`, value: object) {
  const serialized = JSON.stringify(value);
  if (key.startsWith('reading:') && writeOptionalStorage('local', key, serialized)) {
    removeOptionalStorage('session', key);
    return;
  }
  writeOptionalStorage('session', key, serialized);
}

export function clearReadingPosition(key: `reading:${string}`) {
  removeOptionalStorage('local', key);
  removeOptionalStorage('session', key);
}

function validReadingPosition(value: Record<string, unknown> | null): ReadingPosition | null {
  return value &&
    typeof value.source === 'string' &&
    typeof value.anchor === 'string' &&
    (value.target === undefined || typeof value.target === 'string') &&
    typeof value.offset === 'number' &&
    Number.isFinite(value.offset) &&
    typeof value.top === 'number' &&
    Number.isFinite(value.top) &&
    value.top >= 0
    ? (value as ReadingPosition)
    : null;
}

export function readReadingPosition(key: string): ReadingPosition | null {
  const inSession = validReadingPosition(optionalCache(key));
  const persistent = validReadingPosition(optionalCache(key, true));
  if (!inSession) return persistent;
  if (!persistent && writeOptionalStorage('local', key, JSON.stringify(inSession)))
    removeOptionalStorage('session', key);
  return inSession;
}

export function readDraftCursor(key: string): { start: number; end: number } | null {
  const value = optionalCache(key);
  return value &&
    typeof value.start === 'number' &&
    Number.isSafeInteger(value.start) &&
    typeof value.end === 'number' &&
    Number.isSafeInteger(value.end) &&
    value.start >= 0 &&
    value.end >= value.start
    ? { start: value.start, end: value.end }
    : null;
}
