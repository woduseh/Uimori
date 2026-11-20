import { readOptionalStorage, writeOptionalStorage } from './optional-storage.js';

export function readSettingsLocation(key: string, available: readonly string[], fallback: string) {
  const saved = readOptionalStorage('local', key);
  return saved && available.includes(saved) ? saved : fallback;
}

export function rememberSettingsLocation(key: string, section: string) {
  writeOptionalStorage('local', key, section);
}
