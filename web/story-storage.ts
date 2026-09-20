export function commandStorageKey(chatId: string, branchId: string) {
  return `command:${chatId}${branchId && branchId !== `main:${chatId}` ? `:${branchId}` : ''}`;
}

export type ReadingPosition = {
  target?: string;
  source: string;
  anchor: string;
  offset: number;
  top: number;
};

/** Disposable view caches never prevent opening the saved conversation. */
function optionalCache(key: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) || 'null');
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
export function readReadingPosition(key: string): ReadingPosition | null {
  const value = optionalCache(key);
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
