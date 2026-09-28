import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

// Standalone worker: validation and hashing do not block model streaming or cancellation.
const { path, maxSchema } = workerData as { path: string; maxSchema: number };
const db = new DatabaseSync(path, { readOnly: true });
let schema: number;
try {
  if (
    db
      .prepare('PRAGMA quick_check')
      .all()
      .some((row) => row.quick_check !== 'ok')
  )
    throw new Error('BACKUP_INTEGRITY_FAILED');
  if (db.prepare('PRAGMA foreign_key_check').all().length)
    throw new Error('BACKUP_RELATIONS_INVALID');
  schema = Number(db.prepare('PRAGMA user_version').get()!.user_version);
  if (
    schema < 1 ||
    schema > maxSchema ||
    db.prepare("SELECT value FROM app_metadata WHERE key='format'").get()?.value !==
      'uimori-personal-v1'
  )
    throw new Error('BACKUP_FORMAT_INVALID');
} finally {
  db.close();
}
const hash = createHash('sha256');
for await (const chunk of createReadStream(path)) hash.update(chunk);
parentPort!.postMessage({ schema, bytes: (await stat(path)).size, sha256: hash.digest('hex') });
