export type BrowserStorageArea = 'local' | 'session';

function browserStorage(area: BrowserStorageArea): Storage {
  return area === 'local' ? localStorage : sessionStorage;
}

export function readOptionalStorage(area: BrowserStorageArea, key: string): string | null {
  try {
    return browserStorage(area).getItem(key);
  } catch {
    return null;
  }
}

export function readOptionalJson(area: BrowserStorageArea, key: string, fallback: unknown) {
  try {
    const stored = browserStorage(area).getItem(key);
    return stored === null ? fallback : (JSON.parse(stored) as unknown);
  } catch {
    return fallback;
  }
}

export function writeOptionalStorage(area: BrowserStorageArea, key: string, value: string) {
  try {
    browserStorage(area).setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeOptionalStorage(area: BrowserStorageArea, key: string) {
  try {
    browserStorage(area).removeItem(key);
  } catch {}
}
