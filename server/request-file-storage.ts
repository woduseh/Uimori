import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { HttpError } from './request-validation.js';

export type StoredRequestFile = { hash: string; bytes: Buffer };

/** File bytes are content addressed. Names and MIME types belong to their owning message. */
export function initRequestFilesSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS attachment_blobs (
    hash TEXT PRIMARY KEY,bytes BLOB NOT NULL
  );
  CREATE TABLE IF NOT EXISTS helper_message_attachments (
    message_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES helper_conversations(id) ON DELETE CASCADE,
    images TEXT NOT NULL DEFAULT '[]',files TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX IF NOT EXISTS helper_message_attachments_conversation
    ON helper_message_attachments(conversation_id);`);
}

export function storeRequestFileBlob(db: DatabaseSync, file: StoredRequestFile): void {
  if (createHash('sha256').update(file.bytes).digest('hex') !== file.hash)
    throw new HttpError(400, 'REQUEST_FILE_CHANGED');
  db.prepare(
    'INSERT INTO attachment_blobs(hash,bytes) VALUES(?,?) ON CONFLICT(hash) DO NOTHING'
  ).run(file.hash, file.bytes);
}

export function readRequestFileBlob(db: DatabaseSync, hash: string): StoredRequestFile {
  if (!/^[a-f0-9]{64}$/u.test(hash)) throw new HttpError(404, 'REQUEST_FILE_MISSING');
  const row = db.prepare('SELECT bytes FROM attachment_blobs WHERE hash=?').get(hash);
  if (!row) throw new HttpError(404, 'REQUEST_FILE_MISSING');
  const bytes = Buffer.from(row.bytes as Uint8Array);
  if (createHash('sha256').update(bytes).digest('hex') !== hash)
    throw new HttpError(409, 'REQUEST_FILE_CHANGED');
  return { hash, bytes };
}
