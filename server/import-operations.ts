import type { Store } from './store.js';
import { HttpError } from './request-validation.js';
import { AppError } from './app-errors.js';

const retainedPrefixes = [
  'retry:',
  'transcript:',
  'resource:',
  'chat:',
  'risu-result:',
  'risu-preset:',
] as const;
export type RetainedReceiptKey = `${(typeof retainedPrefixes)[number]}${string}`;
const boundedReceipt = retainedPrefixes.map(() => 'key NOT LIKE ?').join(' AND ');
const retainedPatterns = retainedPrefixes.map((prefix) => `${prefix}%`);

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

export function savedOrDraftChanged<T>(
  receiptKey: RetainedReceiptKey,
  saved: (receiptKey: RetainedReceiptKey) => T | undefined
): T {
  const prior = saved(receiptKey);
  if (prior !== undefined) return prior;
  throw new AppError(409, 'RISU_IMPORT_DRAFT_CHANGED');
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
