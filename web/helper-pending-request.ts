import { message as uiMessage } from './i18n.js';

export type PendingHelperRequest<T> = {
  request: T;
  storage: Storage;
  raw: string;
  recovered: boolean;
};

export function pendingHelperRequest<T>(
  key: string,
  create: () => T,
  valid: (value: unknown) => value is T
): PendingHelperRequest<T> {
  const local = () => localStorage;
  const session = () => sessionStorage;
  // A tab's pending fallback remains authoritative even if local storage later recovers.
  for (const getStorage of [session, local]) {
    try {
      const storage = getStorage();
      const raw = storage.getItem(key);
      if (raw === null) continue;
      const value: unknown = JSON.parse(raw);
      if (valid(value)) return { request: value, storage, raw, recovered: true };
    } catch {
      // Try the other storage.
    }
  }
  const request = create();
  const raw = JSON.stringify(request);
  if (typeof raw !== 'string') throw new Error(uiMessage('helpers.m209'));
  for (const getStorage of [local, session]) {
    try {
      const storage = getStorage();
      storage.setItem(key, raw);
      return { request, storage, raw, recovered: false };
    } catch {
      // Do not send without retaining the exact request for a retry.
    }
  }
  throw new Error(uiMessage('helpers.m209'));
}

export function clearPendingHelperRequest(
  key: string,
  pending: Pick<PendingHelperRequest<unknown>, 'storage' | 'raw'> | undefined
) {
  try {
    if (pending && pending.storage.getItem(key) === pending.raw) pending.storage.removeItem(key);
  } catch {
    // Cleanup failure does not undo an acknowledged operation.
  }
}
