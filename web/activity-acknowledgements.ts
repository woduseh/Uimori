import { tryParseJson } from './json.js';
import { storageKeys } from './storage-keys.js';

const maximumIdentityLength = 1024;
const retainedConfirmedIdentities = 100;
const scopePrefix = (scope: string) => storageKeys.activityAcknowledgement(scope, '');
const validIdentity = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximumIdentityLength;

export function isAcknowledgementStorageKey(scope: string, key: string | null) {
  return key === null || key.startsWith(scopePrefix(scope));
}

export function readAcknowledgements(scope: string): string[] {
  const keys = new Set<string>();
  try {
    const storage = localStorage;
    const scoped = scopePrefix(scope);
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (!key?.startsWith(scoped) || storage.getItem(key) !== '1') continue;
      const identity = key.slice(scoped.length);
      if (validIdentity(identity)) keys.add(identity);
    }
  } catch {}
  return [...keys];
}

export function saveAcknowledgements(scope: string, identities: string[]): boolean {
  try {
    if (scope.length > 256) return false;
    const storage = localStorage;
    for (const identity of new Set(identities)) {
      if (!validIdentity(identity)) return false;
      const key = storageKeys.activityAcknowledgement(scope, identity);
      if (storage.getItem(key) === '1') continue;
      storage.setItem(key, '1');
    }
    return true;
  } catch {
    return false;
  }
}

function startedAt(identity: string): number {
  const value = tryParseJson(identity, null);
  const started = Array.isArray(value) ? Date.parse(String(value.at(-1))) : Number.NaN;
  return Number.isFinite(started) ? started : Number.POSITIVE_INFINITY;
}

export function forgetConfirmedAcknowledgements(scope: string, confirmed: readonly string[]) {
  const onServer = new Set(confirmed);
  const local = readAcknowledgements(scope).toSorted((a, b) => startedAt(b) - startedAt(a));
  try {
    for (const identity of local.slice(retainedConfirmedIdentities))
      if (onServer.has(identity))
        localStorage.removeItem(storageKeys.activityAcknowledgement(scope, identity));
  } catch {}
}
