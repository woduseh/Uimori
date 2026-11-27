import { tryParseJson } from './json.js';
import { UiError, uiMessage } from './ui-message.js';

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
  for (const getStorage of [session, local]) {
    try {
      const storage = getStorage();
      const raw = storage.getItem(key);
      if (raw === null) continue;
      const value = tryParseJson(raw, null);
      if (valid(value)) return { request: value, storage, raw, recovered: true };
    } catch {}
  }
  const request = create();
  const raw = JSON.stringify(request);
  if (typeof raw !== 'string') throw new UiError(uiMessage('helpers.m209'));
  for (const getStorage of [local, session]) {
    try {
      const storage = getStorage();
      storage.setItem(key, raw);
      return { request, storage, raw, recovered: false };
    } catch {}
  }
  throw new UiError(uiMessage('helpers.m209'));
}

export function clearPendingHelperRequest(
  key: string,
  pending: Pick<PendingHelperRequest<unknown>, 'storage' | 'raw'> | undefined
) {
  try {
    if (pending && pending.storage.getItem(key) === pending.raw) pending.storage.removeItem(key);
  } catch {}
}
