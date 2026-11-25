import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import {
  readOptionalStorage,
  removeOptionalStorage,
  writeOptionalStorage,
} from './optional-storage.js';
import { storageKeys } from './storage-keys.js';
import { useStableHandler } from './useStableHandler.js';

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

export function usePresentationSetting<T>(
  key: string,
  read: () => T,
  {
    serialize = String,
    follow = true,
    receive = (apply) => apply(),
  }: {
    serialize?: (value: T) => string;
    follow?: boolean;
    receive?: (apply: () => void) => void;
  } = {}
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState(read);
  const stored = useStableHandler(() => serialize(read()));
  const encode = useStableHandler(serialize);
  const accept = useStableHandler(() => receive(() => setValue(read())));
  useEffect(() => {
    const next = encode(value);
    if (next !== stored()) writePresentationSetting(key, next);
  }, [key, value, encode, stored]);
  useEffect(() => {
    if (!follow) return;
    const changed = (event: StorageEvent) => {
      if (event.key !== key && event.key !== null) return;
      try {
        if (event.storageArea === localStorage) accept();
      } catch {}
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [key, follow, accept]);
  return [value, setValue];
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
  const stored = readPresentationSetting(storageKeys.fontSize);
  const value = stored?.trim() ? Number(stored) : 18;
  return Number.isFinite(value) ? Math.max(9, Math.min(28, value)) : 18;
}

export type ResponseDisplayMode = 'stream' | 'complete';
