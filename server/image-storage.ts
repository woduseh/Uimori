import type { DatabaseSync } from 'node:sqlite';
import type { PackageImage } from '../core/package-images.js';
import { AppError } from './app-errors.js';

export type StoredImage = { hash: string; mime: PackageImage['mime']; bytes: Buffer };
export type EncodedImage = {
  id: string;
  revision: 1;
  hash: string;
  mime: PackageImage['mime'];
  base64: string;
};

export function storeImage(db: DatabaseSync, image: StoredImage): void {
  db.prepare(
    'INSERT INTO image_blobs(hash,mime,bytes) VALUES(?,?,?) ON CONFLICT(hash) DO NOTHING'
  ).run(image.hash, image.mime, image.bytes);
}

export function readImage(db: DatabaseSync, hash: string): StoredImage {
  const row = db.prepare('SELECT hash,mime,bytes FROM image_blobs WHERE hash=?').get(hash);
  if (!row) throw new AppError(404, 'IMAGE_NOT_FOUND');
  return {
    hash: String(row.hash),
    mime: row.mime as StoredImage['mime'],
    bytes: Buffer.from(row.bytes as Uint8Array),
  };
}

export function encodedImage(db: DatabaseSync, hash: string): EncodedImage {
  const image = readImage(db, hash);
  return { id: hash, revision: 1, hash, mime: image.mime, base64: image.bytes.toString('base64') };
}
