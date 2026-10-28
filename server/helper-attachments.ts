import type { DatabaseSync } from 'node:sqlite';
import type { RequestImage } from '../core/request-images.js';
import type { RequestFile } from '../core/request-files.js';
import { imageDataHashes, pruneUnusedData } from './unused-data.js';

export type HelperAttachments = { images?: RequestImage[]; files?: RequestFile[] };

/** Normal and copied seed messages share one authored attachment owner. */
export function helperMessageAttachments(db: DatabaseSync, messageId: string): HelperAttachments {
  const row = db
    .prepare('SELECT images,files FROM helper_message_attachments WHERE message_id=?')
    .get(messageId);
  if (!row) return {};
  const images = JSON.parse(String(row.images)) as RequestImage[];
  const files = JSON.parse(String(row.files)) as RequestFile[];
  return { ...(images.length ? { images } : {}), ...(files.length ? { files } : {}) };
}

export function saveHelperMessageAttachments(
  db: DatabaseSync,
  conversationId: string,
  messageId: string,
  attachments: HelperAttachments
): void {
  if (!attachments.images?.length && !attachments.files?.length) return;
  db.prepare(
    'INSERT INTO helper_message_attachments(message_id,conversation_id,images,files) VALUES(?,?,?,?)'
  ).run(
    messageId,
    conversationId,
    JSON.stringify(attachments.images ?? []),
    JSON.stringify(attachments.files ?? [])
  );
}

/** Execution evidence alone cannot keep deleted authored files alive. */
export function pruneUnusedHelperFiles(db: DatabaseSync): void {
  // Blobs and owners commit together. Unfinished snapshots below retain every
  // admitted reference, including those held by another active conversation.
  const retained = new Set<string>();
  for (const row of db.prepare('SELECT files FROM helper_message_attachments').iterate())
    for (const file of JSON.parse(String(row.files)) as RequestFile[]) retained.add(file.hash);
  for (const row of db
    .prepare(`SELECT t.snapshot FROM helper_tasks t WHERE t.status!='completed'
    AND NOT EXISTS (SELECT 1 FROM helper_messages m JOIN helper_message_changes c ON c.message_id=m.id
      WHERE m.task_id=t.id AND c.deleted=1)`)
    .iterate()) {
    const snapshot = JSON.parse(String(row.snapshot)) as {
      files?: RequestFile[];
      history?: HelperAttachments[];
    };
    for (const file of [
      ...(snapshot.files ?? []),
      ...(snapshot.history ?? []).flatMap((message) => message.files ?? []),
    ])
      retained.add(file.hash);
  }
  const remove = db.prepare('DELETE FROM attachment_blobs WHERE hash=?');
  for (const row of db.prepare('SELECT hash FROM attachment_blobs').all())
    if (!retained.has(String(row.hash))) remove.run(String(row.hash));
}

export function removeHelperMessageAttachments(db: DatabaseSync, messageIds: string[]): void {
  const candidates = new Set<string>();
  const remove = db.prepare('DELETE FROM helper_message_attachments WHERE message_id=?');
  for (const messageId of messageIds) {
    for (const hash of imageDataHashes(helperMessageAttachments(db, messageId).images))
      candidates.add(hash);
    remove.run(messageId);
  }
  pruneUnusedData(db, candidates);
  pruneUnusedHelperFiles(db);
}
