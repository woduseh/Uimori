import { message } from './i18n.js';
import { RISU_IMPORT_MAX_BYTES } from '../core/risu-import.js';
import { apiBinary } from './api.js';

export async function readLargeImportSource(
  file: File,
  signal?: AbortSignal
): Promise<{ name: string; base64: string } | { name: string; uploadId: string }> {
  if (file.size <= RISU_IMPORT_MAX_BYTES) return readImportSource(file, signal);
  const staged = await apiBinary<{ uploadId: string }>('/uploads', file, signal);
  return { name: file.name, uploadId: staged.uploadId };
}

export function readImportSource(
  file: File,
  signal?: AbortSignal
): Promise<{ name: string; base64: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    if (signal?.aborted) {
      reject(new DOMException(message('transfer.m189'), 'AbortError'));
      return;
    }
    const abort = () => reader.abort();
    signal?.addEventListener('abort', abort, { once: true });
    reader.onloadend = () => signal?.removeEventListener('abort', abort);
    reader.onerror = () => reject(new Error(message('transfer.m190')));
    reader.onabort = () => reject(new Error(message('transfer.m189')));
    reader.onload = () => {
      const data = reader.result;
      if (typeof data !== 'string' || !data.includes(',')) {
        reject(new Error(message('transfer.m191')));
        return;
      }
      resolve({ name: file.name, base64: data.slice(data.indexOf(',') + 1) });
    };
    reader.readAsDataURL(file);
  });
}
