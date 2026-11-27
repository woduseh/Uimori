import { t } from './i18n.js';
import { UiError, uiMessage } from './ui-message.js';
import { RISU_ASSET_MAX } from '../core/risu-limits.js';
import { PACKAGE_IMAGE_MIMES, type PackageImage } from '../core/package-images.js';
import { libraryEndpoints } from '#contracts';
import { callEndpoint } from './api.js';

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
    throw new UiError(uiMessage('library.aPngJpegWebpAvifOrGif'));
  signal.throwIfAborted();
  const bytes = new Uint8Array(await file.arrayBuffer());
  signal.throwIfAborted();
  let binary = '';
  for (let start = 0; start < bytes.length; start += 32_768)
    binary += String.fromCharCode(...bytes.subarray(start, start + 32_768));
  const result = await callEndpoint(
    libraryEndpoints.uploadPackageImage,
    { base64: btoa(binary) },
    signal
  );
  signal.throwIfAborted();
  if (!/^[a-f0-9]{64}$/u.test(result.hash) || result.mime !== 'image/webp')
    throw new UiError(uiMessage('library.couldNotValidateTheImageResponse'));
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
