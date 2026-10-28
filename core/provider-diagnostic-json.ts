import type { Json } from './transport.js';

/** Redact diagnostic copies only; wire bytes and resumable inputs stay unchanged. */
export function redactDiagnosticJson(value: Json, secret?: string): Json {
  if (typeof value === 'string') {
    if (/^data:[^;]+;base64,/u.test(value)) return '[attachment payload withheld]';
    return secret ? value.split(secret).join('[REDACTED]') : value;
  }
  if (Array.isArray(value)) return value.map((item) => redactDiagnosticJson(item, secret));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(authorization|x-api-key|api[_-]?key|credential|secret|password|access[_-]?token)$/i.test(
          key
        )
          ? '[REDACTED]'
          : key === 'data' &&
              (value.type === 'base64' ||
                typeof value.mimeType === 'string' ||
                (value.type === 'text' && value.media_type === 'text/plain'))
            ? typeof item === 'string' &&
              (item.startsWith('uimori-image://') || item.startsWith('uimori-file://'))
              ? item
              : '[image payload withheld]'
            : key === 'file_data' && typeof item === 'string' && !item.startsWith('uimori-file://')
              ? '[attachment payload withheld]'
              : redactDiagnosticJson(item, secret),
      ])
    );
  return value;
}
