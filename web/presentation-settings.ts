import {
  readOptionalStorage,
  removeOptionalStorage,
  writeOptionalStorage,
} from './optional-storage.js';

export function readPresentationSetting(key: string): string | null {
  return readOptionalStorage('local', key);
}

let reportWriteFailure: (() => void) | undefined;

export function watchPresentationWriteFailure(listener: () => void) {
  reportWriteFailure = listener;
  return () => {
    if (reportWriteFailure === listener) reportWriteFailure = undefined;
  };
}

export function writePresentationSetting(key: string, value: string) {
  if (!writeOptionalStorage('local', key, value)) reportWriteFailure?.();
}

const RETIRED_STORAGE_PREFIXES = ['uimori:editor-buffer:', 'uimori:helper-sidebar-width'];

export function removeRetiredStorage() {
  try {
    for (const key of Object.keys(localStorage))
      if (RETIRED_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix)))
        localStorage.removeItem(key);
  } catch {}
}

export function removePresentationSetting(key: string) {
  removeOptionalStorage('local', key);
}

export function readPresentationChoice<T extends string | number>(
  key: string,
  choices: readonly T[],
  fallback: T
): T {
  const stored = readPresentationSetting(key);
  if (!stored?.trim()) return fallback;
  const value = typeof fallback === 'number' ? Number(stored) : stored;
  return choices.includes(value as T) ? (value as T) : fallback;
}

export function readFontSize() {
  const stored = readPresentationSetting('uimori:font-size');
  const value = stored?.trim() ? Number(stored) : 18;
  return Number.isFinite(value) ? Math.max(9, Math.min(28, value)) : 18;
}

export type ResponseDisplayMode = 'stream' | 'complete';
