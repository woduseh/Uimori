import { PACKAGE_IMAGE_MIMES, type PackageImage } from '../core/package-images.js';
import { sessionRequiredEvent } from './api.js';

export const maxPackageImages = 2000;

/** Shared authoring upload: server validates immutable image bytes; callers own draft attachment. */
export async function uploadPackageImage(
  file: File,
  signal: AbortSignal,
  allowedUse: PackageImage['allowedUse']
): Promise<PackageImage> {
  if (
    !PACKAGE_IMAGE_MIMES.includes(file.type as PackageImage['mime']) ||
    file.size > 2_000_000 ||
    file.size === 0
  )
    throw new Error('2MB 이하 PNG, JPEG 또는 WebP가 필요해요.');
  signal.throwIfAborted();
  const bytes = new Uint8Array(await file.arrayBuffer());
  signal.throwIfAborted();
  let binary = '';
  for (let start = 0; start < bytes.length; start += 32_768)
    binary += String.fromCharCode(...bytes.subarray(start, start + 32_768));
  const response = await fetch('/api/package-image-blobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mime: file.type, base64: btoa(binary) }),
    signal,
  });
  signal.throwIfAborted();
  if (response.status === 401) window.dispatchEvent(new Event(sessionRequiredEvent));
  if (!response.ok) throw new Error(`이미지를 업로드하지 못했어요. (${response.status})`);
  const result: { hash: string; mime: PackageImage['mime'] } = await response.json();
  signal.throwIfAborted();
  if (!/^[a-f0-9]{64}$/u.test(result.hash) || result.mime !== file.type)
    throw new Error('이미지 응답을 확인할 수 없어요.');
  return {
    id: crypto.randomUUID(),
    title:
      file.name
        .replace(/\.[^.]+$/u, '')
        .trim()
        .slice(0, 200) || '이미지',
    description: '',
    blobHash: result.hash,
    mime: result.mime,
    allowedUse,
  };
}
