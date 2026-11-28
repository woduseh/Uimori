import type { Store } from './store.js';
import { HttpError } from './request-validation.js';

export function readImportReceipt<T>(
  store: Store,
  key: string,
  digest: string,
  conflictMessage = 'Idempotency key reused with different command'
): T | undefined {
  const prior = store.db
    .prepare('SELECT digest,result FROM import_operations WHERE key=?')
    .get(key);
  if (!prior) return undefined;
  if (prior.digest !== digest) throw new HttpError(409, conflictMessage);
  return JSON.parse(String(prior.result)) as T;
}

export function saveImportReceipt(store: Store, key: string, digest: string, result: unknown) {
  store.db
    .prepare('INSERT INTO import_operations VALUES(?,?,?)')
    .run(key, digest, JSON.stringify(result));
}
