import { createHash } from 'node:crypto';
import sharp from 'sharp';
import {
  REQUEST_IMAGE_MAX_COUNT,
  type RequestImage,
  type RequestImageUpload,
  type ResolvedRequestImage,
} from '../core/request-images.js';
import { IMAGE_INPUT_MAX_BYTES } from '../core/image-limits.js';
import { readImage, storeImage, type StoredImage } from './image-storage.js';
import { withImageProcessing } from './image-processing.js';
import { fields, HttpError, record, text } from './request-validation.js';
import type { Store } from './store.js';
import { deleteUpload, readUpload } from './uploads.js';

const HASH = /^[a-f0-9]{64}$/u;
const MAX_PIXELS = 64 * 1024 * 1024;
const MAX_INPUT_BYTES = 2 * 1024 * 1024;

export function requestImageUploads(value: unknown): RequestImageUpload[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > REQUEST_IMAGE_MAX_COUNT)
    throw new HttpError(400, 'REQUEST_IMAGE_COUNT_INVALID');
  return value.map((raw) => {
    const image = record(raw);
    fields(image, ['uploadId', 'sha256', 'name']);
    if (!/^[a-f0-9]{32}$/u.test(image.uploadId) || !HASH.test(image.sha256))
      throw new HttpError(400, 'REQUEST_IMAGE_UPLOAD_INVALID');
    return {
      uploadId: image.uploadId as string,
      sha256: image.sha256 as string,
      name: text(image.name, 'image name', 300),
    };
  });
}

export type PreparedRequestImages = { images: RequestImage[]; blobs: StoredImage[] };

/** Conversion happens before admission. No draft or unowned image is written to SQLite. */
export async function prepareRequestImages(
  store: Pick<Store, 'path'>,
  uploads: readonly RequestImageUpload[]
): Promise<PreparedRequestImages> {
  const images: RequestImage[] = [],
    blobs = new Map<string, StoredImage>();
  for (const upload of uploads) {
    const bytes = readUpload(store.path, upload.uploadId, IMAGE_INPUT_MAX_BYTES);
    if (createHash('sha256').update(bytes).digest('hex') !== upload.sha256)
      throw new HttpError(409, 'REQUEST_IMAGE_CHANGED');
    await withImageProcessing(async () => {
      try {
        const source = sharp(bytes, {
          animated: true,
          limitInputPixels: MAX_PIXELS,
          failOn: 'error',
        });
        const meta = await source.metadata();
        if ((meta.pages ?? 1) !== 1) throw new HttpError(400, 'REQUEST_IMAGE_ANIMATED');
        if (!['png', 'jpeg', 'webp', 'heif', 'avif', 'tiff'].includes(meta.format ?? ''))
          throw new HttpError(400, 'REQUEST_IMAGE_FORMAT_INVALID');
        if (!meta.width || !meta.height || meta.width > 16383 || meta.height > 16383)
          throw new HttpError(400, 'REQUEST_IMAGE_DIMENSIONS_INVALID');
        // The authored copy preserves decoded pixels; provider limits never alter this copy.
        const stored = await source
          .rotate()
          .webp({ lossless: true, effort: 4 })
          .toBuffer({ resolveWithObject: true });
        const hash = createHash('sha256').update(stored.data).digest('hex');
        if (stored.data.length > IMAGE_INPUT_MAX_BYTES)
          throw new HttpError(400, 'REQUEST_IMAGE_TOO_LARGE');
        blobs.set(hash, { hash, mime: 'image/webp', bytes: stored.data });
        let input = stored;
        if (
          Math.max(stored.info.width, stored.info.height) > 2048 ||
          stored.data.length > MAX_INPUT_BYTES
        )
          input = await sharp(stored.data)
            .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 90, alphaQuality: 100 })
            .toBuffer({ resolveWithObject: true });
        // Keep a firm transport bound even for high-entropy or highly transparent inputs.
        while (input.data.length > MAX_INPUT_BYTES) {
          const edge = Math.max(
            1,
            Math.floor(Math.max(input.info.width, input.info.height) * 0.75)
          );
          input = await sharp(stored.data)
            .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 85, alphaQuality: 90 })
            .toBuffer({ resolveWithObject: true });
        }
        const inputHash = createHash('sha256').update(input.data).digest('hex');
        blobs.set(inputHash, { hash: inputHash, mime: 'image/webp', bytes: input.data });
        images.push({
          hash,
          mime: 'image/webp',
          name: upload.name,
          width: stored.info.width,
          height: stored.info.height,
          input: { hash: inputHash, width: input.info.width, height: input.info.height },
        });
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, 'REQUEST_IMAGE_INVALID');
      }
    });
  }
  return { images, blobs: [...blobs.values()] };
}

/** Must join the same transaction that reserves the owning run. */
export function storeRequestImages(
  store: Pick<Store, 'db'>,
  prepared: PreparedRequestImages
): void {
  for (const blob of prepared.blobs) storeImage(store.db, blob);
}

/** Cleanup cannot turn an accepted request into a rejected one. Staging also has expiry cleanup. */
export function releaseRequestImageUploads(
  store: Pick<Store, 'path'>,
  uploads: readonly RequestImageUpload[]
): void {
  for (const upload of uploads) {
    try {
      deleteUpload(store.path, upload.uploadId);
    } catch {
      /* A later staging prune retries. */
    }
  }
}

export function readRequestImage(
  store: Pick<Store, 'db'>,
  image: RequestImage
): ResolvedRequestImage {
  const blob = readImage(store.db, image.input.hash);
  return {
    mime: 'image/webp',
    base64: blob.bytes.toString('base64'),
    width: image.input.width,
    height: image.input.height,
  };
}

export function assertRequestImages(
  store: Pick<Store, 'db'>,
  images: readonly RequestImage[]
): void {
  const exists = store.db.prepare("SELECT 1 FROM image_blobs WHERE hash=? AND mime='image/webp'");
  for (const image of images)
    for (const hash of [image.hash, image.input.hash])
      if (!exists.get(hash)) throw new HttpError(400, 'REQUEST_IMAGE_MISSING');
}
