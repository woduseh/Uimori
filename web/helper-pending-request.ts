import { message as uiMessage } from './i18n.js';

export function pendingHelperRequest<T>(
  key: string,
  create: () => T,
  valid: (value: unknown) => value is T
): { request: T; storage: Storage } {
  const local = () => localStorage;
  const session = () => sessionStorage;
  // A tab's pending fallback remains authoritative even if local storage later recovers.
  for (const getStorage of [session, local]) {
    try {
      const storage = getStorage();
      const value: unknown = JSON.parse(storage.getItem(key) ?? 'null');
      if (valid(value)) return { request: value, storage };
    } catch {
      // Try the other storage.
    }
  }
  const request = create();
  for (const getStorage of [local, session]) {
    try {
      const storage = getStorage();
      storage.setItem(key, JSON.stringify(request));
      return { request, storage };
    } catch {
      // Do not send without retaining the exact request for a retry.
    }
  }
  throw new Error(uiMessage('helpers.m209'));
}

export function clearPendingHelperRequest(key: string, pending: { storage: Storage } | undefined) {
  try {
    pending?.storage.removeItem(key);
  } catch {
    // Cleanup failure does not undo an acknowledged operation.
  }
}
