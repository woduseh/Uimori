/** Browser-local notification metadata, never a change to the underlying job. */
const prefix = 'uimori:activity-acknowledged:v1:';
const maximumIdentityLength = 1024;
const scopePrefix = (scope: string) => `${prefix}${JSON.stringify(scope)}:`;
const legacyKey = (scope: string) => `activity-acknowledged:${scope}`;
const validIdentity = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximumIdentityLength;

export function acknowledgementStorageKey(scope: string, identity: string) {
  return `${scopePrefix(scope)}${identity}`;
}

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
  } catch {
    // Available legacy confirmations can still protect the current view.
  }
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(legacyKey(scope)) ?? '[]');
    if (Array.isArray(saved)) for (const key of saved) if (validIdentity(key)) keys.add(key);
  } catch {
    // Optional legacy storage must not prevent reading durable confirmations.
  }
  return [...keys];
}

/** Independent event keys avoid lost confirmations when two tabs write concurrently. */
export function saveAcknowledgements(scope: string, identities: string[]): boolean {
  try {
    if (scope.length > 256) return false;
    const storage = localStorage;
    for (const identity of new Set(identities)) {
      if (!validIdentity(identity)) return false;
      const key = acknowledgementStorageKey(scope, identity);
      if (storage.getItem(key) === '1') continue;
      storage.setItem(key, '1');
    }
    return true;
  } catch {
    return false;
  }
}

export function migrateAcknowledgements(scope: string): boolean {
  const keys = readAcknowledgements(scope);
  if (!keys.length) return true;
  if (!saveAcknowledgements(scope, keys)) return false;
  try {
    sessionStorage.removeItem(legacyKey(scope));
  } catch {
    // The persistent copy is already saved; retaining the legacy copy is harmless.
  }
  return true;
}
