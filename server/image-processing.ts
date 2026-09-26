import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { HttpError } from './request-validation.js';
import { IMAGE_INPUT_MAX_BYTES } from '../core/image-limits.js';

export const MAX_IMAGE_INPUT_BYTES = IMAGE_INPUT_MAX_BYTES;
const MAX_PIXELS = 64 * 1024 * 1024;
const MAX_FRAMES = 500;
const MAX_CONCURRENT_IMAGES = 2;
let active = 0;
const waiting: (() => void)[] = [];

export type ProcessedImage = { bytes: Buffer; mime: 'image/webp'; hash: string };

/** Intake only. Renames, reads and restores of existing WebP data never re-encode the image. */
export async function processImage(bytes: Buffer): Promise<ProcessedImage> {
  if (!bytes.length || bytes.length > MAX_IMAGE_INPUT_BYTES)
    throw new HttpError(400, '이미지는 64MiB 이하 파일을 사용해 주세요.');
  if (active >= MAX_CONCURRENT_IMAGES) await new Promise<void>((resolve) => waiting.push(resolve));
  else active++;
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
      throw new HttpError(400, '이미지 해상도나 전체 애니메이션 프레임 크기가 처리 범위를 넘어요.');
    if (!['png', 'jpeg', 'webp', 'gif', 'heif', 'avif', 'tiff'].includes(metadata.format ?? ''))
      throw new HttpError(400, '지원하지 않는 이미지 형식이에요.');
    const output =
      metadata.format === 'webp'
        ? bytes
        : await input
            .rotate()
            .webp({ quality: 90, alphaQuality: 100, effort: 4, smartSubsample: true })
            .toBuffer();
    return {
      bytes: output,
      mime: 'image/webp',
      hash: createHash('sha256').update(output).digest('hex'),
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, '이미지를 읽거나 WebP로 변환하지 못했어요.');
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
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
