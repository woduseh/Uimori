import { message, t } from './i18n.js';
import { RISU_ASSET_MAX } from '../core/risu-limits.js';
import { PACKAGE_IMAGE_MIMES, type PackageImage } from '../core/package-images.js';
import { api } from './api.js';

export const maxPackageImages = RISU_ASSET_MAX;

export async function uploadPackageImage(
  file: File,
  signal: AbortSignal,
  allowedUse: PackageImage['allowedUse']
): Promise<PackageImage> {
  if (
    !PACKAGE_IMAGE_MIMES.includes(file.type as PackageImage['mime']) ||
    file.size > 64 * 1024 * 1024 ||
    file.size === 0
  )
    throw new Error(message('library.aPngJpegWebpAvifOrGif'));
  signal.throwIfAborted();
  const bytes = new Uint8Array(await file.arrayBuffer());
  signal.throwIfAborted();
  let binary = '';
  for (let start = 0; start < bytes.length; start += 32_768)
    binary += String.fromCharCode(...bytes.subarray(start, start + 32_768));
  const result = await api<{ hash: string; mime: PackageImage['mime'] }>(
    '/package-image-blobs',
    { mime: file.type, base64: btoa(binary) },
    'POST',
    signal
  );
  signal.throwIfAborted();
  if (!/^[a-f0-9]{64}$/u.test(result.hash) || result.mime !== 'image/webp')
    throw new Error(message('library.couldNotValidateTheImageResponse'));
  return {
    id: crypto.randomUUID(),
    title:
      file.name
        .replace(/\.[^.]+$/u, '')
        .trim()
        .slice(0, 200) || t('visuals.image'),
    description: '',
    blobHash: result.hash,
    mime: result.mime,
    allowedUse,
  };
}
