import type { DatabaseSync } from 'node:sqlite';
import type { PackageImage } from '../core/package-images.js';
import { HttpError } from './request-validation.js';

/** Reference checks do not need image bytes. Upload/import still validates those bytes. */
export function assertPackageImageReferences(db: DatabaseSync, images: readonly PackageImage[]) {
  if (!images.length) return;
  const read = db.prepare('SELECT hash,mime FROM image_blobs WHERE hash=?');
  const checked = new Map<string, { hash: string; mime: string }>();
  for (const image of images) {
    let blob = checked.get(image.blobHash);
    if (!blob) {
      blob = read.get(image.blobHash) as { hash: string; mime: string } | undefined;
      if (!blob) throw new HttpError(404, 'package-image revision not found');
      checked.set(image.blobHash, blob);
    }
    // Check each reference: two aliases may claim different MIME types for the same hash.
    if (blob.hash !== image.blobHash || blob.mime !== image.mime)
      throw new HttpError(400, 'Package image reference mismatch');
  }
}
