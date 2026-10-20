import { message as uiMessage } from './i18n.js';
export type RecoveryBuffer<T> = {
  /** Unique per write; optional for buffers saved by older app versions. */
  token?: string;
  revision: number | null;
  model: T;
  rawFields: Record<string, string>;
};
let database: Promise<IDBDatabase> | undefined;

/** One latest unsaved buffer per editor on this device. No journal, versions, or network sync. */
function open(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('uimori-editor-recovery', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('buffers');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
    request.onblocked = () => {
      database = undefined;
      reject(new Error(uiMessage('shared.recoveryOpenFailure')));
    };
  });
  return database;
}

export async function readRecovery<T>(key: string): Promise<RecoveryBuffer<T> | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db.transaction('buffers').objectStore('buffers').get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function writeRecovery<T>(key: string, value?: RecoveryBuffer<T>): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('buffers', 'readwrite');
    const buffers = transaction.objectStore('buffers');
    if (value === undefined) buffers.delete(key);
    else buffers.put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      reject(transaction.error ?? new Error(uiMessage('shared.recoveryAborted')));
  });
}

/** Copy a cloned tab's buffers once, before that tab starts editing independently. */
export async function copyRecoveryPrefix(fromPrefix: string, toPrefix: string): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('buffers', 'readwrite');
    const buffers = transaction.objectStore('buffers');
    const request = buffers.openCursor(IDBKeyRange.bound(fromPrefix, `${fromPrefix}\uffff`));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      buffers.put(cursor.value, `${toPrefix}${String(cursor.key).slice(fromPrefix.length)}`);
      cursor.continue();
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      reject(transaction.error ?? new Error(uiMessage('shared.clonedDraftAborted')));
  });
}

async function deleteRecoveryIf<T>(
  key: string,
  matches: (value: RecoveryBuffer<T>) => boolean
): Promise<RecoveryBuffer<T> | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('buffers', 'readwrite');
    const buffers = transaction.objectStore('buffers');
    const request = buffers.get(key);
    let remaining: RecoveryBuffer<T> | undefined;
    request.onsuccess = () => {
      const found = request.result as RecoveryBuffer<T> | undefined;
      if (found && matches(found)) buffers.delete(key);
      else remaining = found;
    };
    transaction.oncomplete = () => resolve(remaining);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      reject(transaction.error ?? new Error(uiMessage('shared.recoveryCleanupAborted')));
  });
}

/** Cleanup only the resource buffer this session read or successfully wrote. */
export function deleteRecoveryIfToken(key: string, token: string | undefined) {
  return deleteRecoveryIf(key, (found) => found.token === token);
}

/** Exact-value cleanup is used only for the helper's primitive text buffers. */
export function deleteRecoveryIfModel<T>(key: string, expected: T) {
  return deleteRecoveryIf<T>(key, (found) => found.model === expected);
}
