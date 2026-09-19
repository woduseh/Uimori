import { createHash } from 'node:crypto';

/** Key order does not change a JSON command's idempotency identity. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key]))
      .join(',') +
    '}'
  );
}
export const jsonPayloadHash = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');
