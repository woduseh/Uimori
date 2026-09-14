import { RISU_IMPORT_MAX_BYTES } from '../core/risu-import.js';
import { apiBinary } from './api.js';

/** Stages a file the request body cannot carry, and keeps the small path unchanged. */
export async function readLargeImportSource(
  file: File
): Promise<{ name: string; base64: string } | { name: string; uploadId: string }> {
  if (file.size <= RISU_IMPORT_MAX_BYTES) return readImportSource(file);
  const staged = await apiBinary<{ uploadId: string }>('/uploads', file);
  return { name: file.name, uploadId: staged.uploadId };
}

/** Read a chosen file once; the caller owns size limits, review, cancellation and adoption. */
export function readImportSource(file: File): Promise<{ name: string; base64: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('파일을 읽지 못했어요. 다시 선택해 주세요.'));
    reader.onabort = () => reject(new Error('파일 읽기가 취소됐어요.'));
    reader.onload = () => {
      const data = reader.result;
      if (typeof data !== 'string' || !data.includes(',')) {
        reject(new Error('파일 내용을 읽지 못했어요.'));
        return;
      }
      resolve({ name: file.name, base64: data.slice(data.indexOf(',') + 1) });
    };
    reader.readAsDataURL(file);
  });
}
