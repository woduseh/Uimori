import type { Store } from './store.js';
import { HttpError } from './request-validation.js';

// These receipts carry durable target identity; general resource imports remain bounded.
const retainedPrefixes = ['retry:', 'transcript:', 'resource:', 'chat:', 'risu-result:'] as const;
const boundedReceipt = retainedPrefixes.map(() => 'key NOT LIKE ?').join(' AND ');
const retainedPatterns = retainedPrefixes.map((prefix) => `${prefix}%`);

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
  if (retainedPrefixes.some((prefix) => key.startsWith(prefix))) return;
  store.db
    .prepare(
      `DELETE FROM import_operations
       WHERE ${boundedReceipt}
         AND rowid NOT IN (
           SELECT rowid FROM import_operations
           WHERE ${boundedReceipt}
           ORDER BY rowid DESC LIMIT 256
         )`
    )
    .run(...retainedPatterns, ...retainedPatterns);
}
