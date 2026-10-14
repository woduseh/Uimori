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

/** Optional view caches never prevent opening the saved conversation. */
function optionalCache(key: string, persistent = false): Record<string, unknown> | null {
  try {
    const storage = persistent ? localStorage : sessionStorage;
    const value: unknown = JSON.parse(storage.getItem(key) || 'null');
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function writeViewCache(key: `reading:${string}` | `cursor:${string}`, value: object) {
  const serialized = JSON.stringify(value);
  if (key.startsWith('reading:')) {
    try {
      localStorage.setItem(key, serialized);
      try {
        sessionStorage.removeItem(key);
      } catch {
        // A leftover legacy position cannot override the persistent one.
      }
      return;
    } catch {
      // Persistent storage may be blocked or full; fall back to this tab.
      try {
        localStorage.removeItem(key);
      } catch {
        // A stale position is only optional cache data.
      }
    }
  }
  try {
    sessionStorage.setItem(key, serialized);
  } catch {
    // Optional reading and cursor caches must not block navigation.
  }
}

export function clearReadingPosition(key: `reading:${string}`) {
  for (const persistent of [true, false]) {
    try {
      (persistent ? localStorage : sessionStorage).removeItem(key);
    } catch {
      // Cache invalidation must not block navigation.
    }
  }
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
  const saved = validReadingPosition(optionalCache(key, true));
  if (saved) return saved;
  // Older clients used sessionStorage. Migrate an existing tab's position once.
  const legacy = validReadingPosition(optionalCache(key));
  if (legacy) {
    try {
      localStorage.setItem(key, JSON.stringify(legacy));
      sessionStorage.removeItem(key);
    } catch {
      // The tab-local position still works if migration is unavailable.
    }
  }
  return legacy;
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
