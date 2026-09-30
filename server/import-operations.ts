import type { Store } from './store.js';
import { HttpError } from './request-validation.js';

export function readImportReceipt<T>(
  store: Store,
  key: string,
  digest: string,
  conflictMessage = '다른 가져오기 요청에 같은 ID가 사용됐어요.'
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
  if (key.startsWith('retry:') || key.startsWith('transcript:')) return;
  // Retry/transcript receipts preserve target identities; unrelated resource imports
  // must not evict them and turn a replay into a second chat or generation.
  store.db
    .prepare(
      `DELETE FROM import_operations
       WHERE key NOT LIKE 'retry:%' AND key NOT LIKE 'transcript:%'
         AND rowid NOT IN (
           SELECT rowid FROM import_operations
           WHERE key NOT LIKE 'retry:%' AND key NOT LIKE 'transcript:%'
           ORDER BY rowid DESC LIMIT 256
         )`
    )
    .run();
}
