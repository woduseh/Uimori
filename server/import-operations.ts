import type { Store } from './store.js';
import { HttpError } from './request-validation.js';

export function readImportReceipt<T>(store: Store, key: string, digest: string): T | undefined {
  const prior = store.db
    .prepare('SELECT digest,result FROM import_operations WHERE key=?')
    .get(key);
  if (!prior) return undefined;
  if (prior.digest !== digest)
    throw new HttpError(409, '다른 가져오기 요청에 같은 ID가 사용됐어요.');
  return JSON.parse(String(prior.result)) as T;
}

export function saveImportReceipt(store: Store, key: string, digest: string, result: unknown) {
  store.db
    .prepare('INSERT INTO import_operations VALUES(?,?,?)')
    .run(key, digest, JSON.stringify(result));
  store.db
    .prepare(
      'DELETE FROM import_operations WHERE rowid NOT IN (SELECT rowid FROM import_operations ORDER BY rowid DESC LIMIT 256)'
    )
    .run();
}
