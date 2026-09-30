import type { Json } from './transport.js';

/** Redact diagnostic copies only; wire bytes and resumable inputs stay unchanged. */
export function redactDiagnosticJson(value: Json, secret?: string): Json {
  if (typeof value === 'string') return secret ? value.split(secret).join('[REDACTED]') : value;
  if (Array.isArray(value)) return value.map((item) => redactDiagnosticJson(item, secret));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(authorization|x-api-key|api[_-]?key|credential|secret|password|access[_-]?token)$/i.test(
          key
        )
          ? '[REDACTED]'
          : redactDiagnosticJson(item, secret),
      ])
    );
  return value;
}
