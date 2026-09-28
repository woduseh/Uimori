export type RecoveryBuffer<T> = {
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
      reject(new Error('복구 저장소를 열지 못했어요.'));
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
    transaction.onabort = () => reject(transaction.error ?? new Error('복구 저장이 중단됐어요.'));
  });
}

/** Atomic legacy migration: an existing buffer from another tab takes precedence. */
export async function writeRecoveryIfAbsent<T>(
  key: string,
  value: RecoveryBuffer<T>
): Promise<RecoveryBuffer<T>> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('buffers', 'readwrite');
    const buffers = transaction.objectStore('buffers');
    const request = buffers.get(key);
    let result = value;
    request.onsuccess = () => {
      if (request.result !== undefined) result = request.result;
      else buffers.put(value, key);
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('복구 저장이 중단됐어요.'));
  });
}

/** Exact-value cleanup never deletes a newer buffer written by another tab. */
export async function deleteRecoveryIfModel<T>(
  key: string,
  expected: T
): Promise<RecoveryBuffer<T> | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('buffers', 'readwrite');
    const buffers = transaction.objectStore('buffers');
    const request = buffers.get(key);
    let remaining: RecoveryBuffer<T> | undefined;
    request.onsuccess = () => {
      const found = request.result as RecoveryBuffer<T> | undefined;
      if (found?.model === expected) buffers.delete(key);
      else remaining = found;
    };
    transaction.oncomplete = () => resolve(remaining);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('복구 정리가 중단됐어요.'));
  });
}
