import { createHash } from 'node:crypto';

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
function stripUndefined(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stripUndefined);
  const cleaned: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined)
      Object.defineProperty(cleaned, key, {
        value: stripUndefined(item),
        enumerable: true,
        configurable: true,
        writable: true,
      });
  }
  return cleaned;
}

export const jsonPayloadHash = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');

export const canonicalPayloadHash = (value: unknown): string =>
  jsonPayloadHash(stripUndefined(value));
