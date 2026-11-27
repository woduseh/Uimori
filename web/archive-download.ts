import { readErrorWire } from '#contracts';
import { message as retainedMessage } from './i18n.js';
import { ApiError, sessionRequiredEvent } from './api.js';
import { apiErrorDiagnostic, apiErrorDisplay } from './api-errors.js';

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
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event(sessionRequiredEvent));
    const wire = readErrorWire(await response.json().catch(() => null));
    if (wire.code === undefined && wire.error === undefined)
      throw new ApiError(retainedMessage('transfer.m188'), response.status);
    const diagnostic = apiErrorDiagnostic(wire, response.status, method);
    if (diagnostic.code === null && wire.error !== undefined)
      throw new ApiError(wire.error, response.status);
    apiErrorDisplay(wire, response.status, method);
    throw new ApiError(diagnostic.message, response.status, diagnostic.code, () =>
      apiErrorDisplay(wire, response.status, method)
    );
  }
  const url = URL.createObjectURL(await response.blob()),
    link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
