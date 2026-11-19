import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { HttpError } from './request-validation.js';
import { IMAGE_INPUT_MAX_BYTES } from '../core/image-limits.js';

export const MAX_IMAGE_INPUT_BYTES = IMAGE_INPUT_MAX_BYTES;
const MAX_PIXELS = 64 * 1024 * 1024;
const MAX_FRAMES = 500;
/** Sharp runs on libuv's four default threads; one stays free for request file I/O. */
export const IMAGE_PROCESSING_SLOTS = 3;
let active = 0;
const waiting: (() => void)[] = [];

export type ProcessedImage = {
  bytes: Buffer;
  mime: 'image/webp';
  hash: string;
  width: number;
  height: number;
};

/** All intake conversions share the same bounded memory/CPU slots. */
export async function withImageProcessing<T>(work: () => Promise<T>): Promise<T> {
  if (active >= IMAGE_PROCESSING_SLOTS) await new Promise<void>((resolve) => waiting.push(resolve));
  else active++;
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}

const WEBP_FRAME_CHUNKS = new Set(['VP8 ', 'VP8L']);

/**
 * Stored WebP keeps its original bytes, so intake checks the container instead of decoding
 * every frame: chunk sizes must fit the declared RIFF length and every frame needs image data.
 * This rejects truncated files; damage inside a frame's pixel data is stored as received.
 */
function assertWebpStructure(bytes: Buffer): void {
  const fail = () => {
    throw new Error('WEBP_STRUCTURE_INVALID');
  };
  if (
    bytes.length < 20 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WEBP'
  )
    fail();
  const end = 8 + bytes.readUInt32LE(4);
  if (end > bytes.length) fail();
  const chunks = (start: number, limit: number) => {
    const found: { id: string; offset: number; size: number }[] = [];
    for (let offset = start; offset < limit; ) {
      if (offset + 8 > limit) fail();
      const size = bytes.readUInt32LE(offset + 4);
      if (offset + 8 + size > limit) fail();
      found.push({ id: bytes.toString('ascii', offset, offset + 4), offset, size });
      // Chunks are padded to even sizes; a final odd chunk may omit its pad byte.
      offset += 8 + size + (size % 2);
    }
    return found;
  };
  const top = chunks(12, end);
  const frames = top.filter((chunk) => chunk.id === 'ANMF');
  const hasImage = (list: { id: string; size: number }[]) =>
    list.some((chunk) => WEBP_FRAME_CHUNKS.has(chunk.id) && chunk.size > 0);
  if (frames.length) {
    for (const frame of frames) {
      // An ANMF payload starts with 16 bytes of frame placement before its own chunks.
      if (frame.size < 16) fail();
      if (!hasImage(chunks(frame.offset + 24, frame.offset + 8 + frame.size))) fail();
    }
  } else if (!hasImage(top)) fail();
}

/** Intake only. Renames, reads and restores of existing WebP data never re-encode the image. */
export async function processImage(bytes: Buffer): Promise<ProcessedImage> {
  if (!bytes.length || bytes.length > MAX_IMAGE_INPUT_BYTES)
    throw new HttpError(400, '이미지는 64MiB 이하 파일을 사용해 주세요.');
  return withImageProcessing(async () => {
    try {
      const input = sharp(bytes, { animated: true, limitInputPixels: MAX_PIXELS, failOn: 'error' });
      const metadata = await input.metadata();
      const frames = metadata.pages ?? 1;
      const width = metadata.width ?? 0;
      const height = metadata.pageHeight ?? metadata.height ?? 0;
      if (
        !width ||
        !height ||
        width > 16383 ||
        height > 16383 ||
        frames > MAX_FRAMES ||
        width * height * frames > MAX_PIXELS
      )
        throw new HttpError(
          400,
          '이미지 해상도나 전체 애니메이션 프레임 크기가 처리 범위를 넘어요.'
        );
      if (!['png', 'jpeg', 'webp', 'gif', 'heif', 'avif', 'tiff'].includes(metadata.format ?? ''))
        throw new HttpError(400, '지원하지 않는 이미지 형식이에요.');
      if (metadata.format === 'webp') assertWebpStructure(bytes);
      const output =
        metadata.format === 'webp'
          ? bytes
          : await input
              .rotate()
              .webp({ quality: 90, alphaQuality: 100, effort: 4, smartSubsample: true })
              .toBuffer();
      return {
        width:
          metadata.format !== 'webp' && [5, 6, 7, 8].includes(metadata.orientation ?? 1)
            ? height
            : width,
        height:
          metadata.format !== 'webp' && [5, 6, 7, 8].includes(metadata.orientation ?? 1)
            ? width
            : height,
        bytes: output,
        mime: 'image/webp',
        hash: createHash('sha256').update(output).digest('hex'),
      };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, '이미지를 읽거나 WebP로 변환하지 못했어요.');
    }
  });
}

export async function processImageUpload(value: { base64: unknown }) {
  if (
    typeof value.base64 !== 'string' ||
    value.base64.length > Math.ceil(MAX_IMAGE_INPUT_BYTES / 3) * 4
  )
    throw new HttpError(400, '이미지 파일 크기를 확인해 주세요.');
  const image = await processImage(Buffer.from(value.base64, 'base64'));
  return { mime: image.mime, base64: image.bytes.toString('base64') };
}

export async function imageThumbnail(bytes: Buffer, width: number): Promise<Buffer> {
  return withImageProcessing(() =>
    sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: 'none' })
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 80, effort: 2 })
      .toBuffer()
  );
}

/** Transmission-only copy. Originals and their hashes remain untouched in storage. */
// https://image.novelai.net/docs/doc.json (2026-11-20): director_reference_images must be
// 1024x1536, 1536x1024 or 1472x1472 with black padding to fit.
const NOVELAI_REFERENCE_CANVASES = [
  { width: 1024, height: 1536 },
  { width: 1536, height: 1024 },
  { width: 1472, height: 1472 },
];
export async function novelAIReferenceImage(bytes: Buffer): Promise<Buffer> {
  const input = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).rotate();
  const metadata = await input.metadata();
  const swapped = (metadata.orientation ?? 1) >= 5;
  const ratio = swapped
    ? (metadata.height ?? 1) / (metadata.width ?? 1)
    : (metadata.width ?? 1) / (metadata.height ?? 1);
  const canvas = NOVELAI_REFERENCE_CANVASES.reduce((best, next) =>
    Math.abs(Math.log(next.width / next.height / ratio)) <
    Math.abs(Math.log(best.width / best.height / ratio))
      ? next
      : best
  );
  return input
    .resize({ ...canvas, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 1 } })
    .flatten({ background: { r: 0, g: 0, b: 0 } })
    .png()
    .toBuffer();
}
export async function resizeIllustrationReference(bytes: Buffer, mime: string) {
  const input = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: 'error' });
  const metadata = await input.metadata();
  const longest = Math.max(metadata.width ?? 0, metadata.height ?? 0);
  if (longest <= 1536 && (metadata.pages ?? 1) === 1 && !metadata.orientation)
    return { bytes, mime };
  return {
    bytes: await input
      .rotate()
      .resize({ width: 1536, height: 1536, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 90, alphaQuality: 100 })
      .toBuffer(),
    mime: 'image/webp',
  };
}
