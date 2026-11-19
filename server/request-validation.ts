import { IDENTITY_PATTERN } from '../core/identity.js';

export class HttpError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

type RequestRecord = Record<string, any>;

export const record = (value: unknown): RequestRecord => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, 'Expected an object');
  return value as RequestRecord;
};
export const fields = (body: RequestRecord, keys: string[]) => {
  const unknown = Object.keys(body).filter((key) => !keys.includes(key));
  if (unknown.length)
    throw new HttpError(
      400,
      `Unknown request field: ${unknown.join(', ')}; allowed: ${keys.join(', ') || 'none'}`
    );
};
export const text = (value: unknown, name: string, max = 4000, empty = false): string => {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max)
    throw new HttpError(
      400,
      `Invalid ${name}: expected a ${empty ? '' : 'non-empty '}string${
        Number.isFinite(max) ? ` of at most ${max} characters` : ''
      }`
    );
  return value;
};
export const chatTitle = (value: unknown): string => text(value, 'chat title', Infinity);
export const number = (value: unknown, name: string, min = 1, max = 1e9): number => {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)
    throw new HttpError(
      400,
      `Invalid ${name}: expected an integer ${
        Number.isFinite(max) ? `from ${min} to ${max}` : `of at least ${min}`
      }`
    );
  return Number(value);
};

export const parse = (s: any) => (s == null ? null : JSON.parse(String(s)));
export const choice = <T extends string>(v: unknown, values: T[], name: string): T => {
  if (!values.includes(v as T))
    throw new HttpError(400, `Invalid ${name}: expected one of ${values.join(', ')}`);
  return v as T;
};
export const boolean = (v: unknown): boolean => {
  if (typeof v !== 'boolean') throw new HttpError(400, 'Invalid boolean: expected true or false');
  return v;
};
export const archiveId = (value: unknown) => {
  const id = text(value, 'archive ID', 200);
  if (!IDENTITY_PATTERN.test(id)) throw new HttpError(400, 'Invalid archive ID');
  return id;
};
export function archiveList(value: unknown, maximum = 300): any[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new HttpError(400, `Invalid archive list: expected an array of at most ${maximum} items`);
  return value;
}
/** Archives record every hash as a lowercase sha256 digest. */
export const isSha256Hex = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
/** An archive row's parsed body, checked against the row identity every archive kind shares. */
export function archiveVersionBody(row: Record<string, any>): Record<string, any> {
  const body = record(parse(row.body));
  archiveId(row.id);
  number(row.revision, 'version');
  if (body.id !== row.id || body.revision !== row.revision)
    throw new HttpError(400, 'Version identity mismatch');
  return body;
}
