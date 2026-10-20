import { legacyMessage } from './i18n.js';
import { RISU_IMPORT_MAX_BYTES } from '../core/risu-import.js';
import { apiBinary } from './api.js';

/** Stages a file the request body cannot carry, and keeps the small path unchanged. */
export async function readLargeImportSource(
  file: File,
  signal?: AbortSignal
): Promise<{ name: string; base64: string } | { name: string; uploadId: string }> {
  if (file.size <= RISU_IMPORT_MAX_BYTES) return readImportSource(file, signal);
  const staged = await apiBinary<{ uploadId: string }>('/uploads', file, signal);
  return { name: file.name, uploadId: staged.uploadId };
}

/** Read a chosen file once; the caller owns size limits, review, cancellation and adoption. */
export function readImportSource(
  file: File,
  signal?: AbortSignal
): Promise<{ name: string; base64: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    if (signal?.aborted) {
      reject(new DOMException(legacyMessage('transfer.m189'), 'AbortError'));
      return;
    }
    const abort = () => reader.abort();
    signal?.addEventListener('abort', abort, { once: true });
    reader.onloadend = () => signal?.removeEventListener('abort', abort);
    reader.onerror = () => reject(new Error(legacyMessage('transfer.m190')));
    reader.onabort = () => reject(new Error(legacyMessage('transfer.m189')));
    reader.onload = () => {
      const data = reader.result;
      if (typeof data !== 'string' || !data.includes(',')) {
        reject(new Error(legacyMessage('transfer.m191')));
        return;
      }
      resolve({ name: file.name, base64: data.slice(data.indexOf(',') + 1) });
    };
    reader.readAsDataURL(file);
  });
}
