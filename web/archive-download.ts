import { uiMessage } from './ui-message.js';
import { throwApiError } from './api.js';

export async function downloadArchive(path: string, name: string, body?: unknown) {
  const method = body === undefined ? 'GET' : 'POST';
  const response = await fetch(
    `/api${path}`,
    body === undefined
      ? {}
      : {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
  );
  if (!response.ok) await throwApiError(response, { emptyMessage: uiMessage('transfer.m188') });
  const url = URL.createObjectURL(await response.blob()),
    link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
