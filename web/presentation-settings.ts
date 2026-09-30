/** Optional browser presentation only; recovery data keeps its own storage contract. */
export function readPresentationSetting(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePresentationSetting(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The current session still uses the chosen presentation.
  }
}

export function readPresentationChoice<T extends string | number>(
  key: string,
  choices: readonly T[],
  fallback: T
): T {
  const stored = readPresentationSetting(key);
  const value = typeof fallback === 'number' ? Number(stored) : stored;
  return choices.includes(value as T) ? (value as T) : fallback;
}

export function readFontSize() {
  const stored = readPresentationSetting('uimori:font-size');
  const value = stored?.trim() ? Number(stored) : 18;
  return Number.isFinite(value) ? Math.max(9, Math.min(28, value)) : 18;
}

export type ResponseDisplayMode = 'stream' | 'complete';
