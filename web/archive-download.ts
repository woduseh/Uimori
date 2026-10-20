import { message as retainedMessage } from './i18n.js';
import { ApiError, sessionRequiredEvent } from './api.js';

/** Blob downloads never parse a large binary archive into a JSON/base64 string. */
export async function downloadArchive(path: string, name: string, body?: unknown) {
  const response = await fetch(
    `/api${path}`,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
  );
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event(sessionRequiredEvent));
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(payload?.error ?? retainedMessage('transfer.m188'), response.status);
  }
  const url = URL.createObjectURL(await response.blob()),
    link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
