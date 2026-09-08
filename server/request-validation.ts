export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

type RequestRecord = Record<string, any>;

export const record = (value: unknown): RequestRecord => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, 'Expected an object');
  return value as RequestRecord;
};
export const fields = (body: RequestRecord, keys: string[]) => {
  if (Object.keys(body).some((key) => !keys.includes(key)))
    throw new HttpError(400, 'Unknown request field');
};
export const text = (value: unknown, name: string, max = 4000, empty = false): string => {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max)
    throw new HttpError(400, `Invalid ${name}`);
  return value;
};
export const number = (value: unknown, name: string, min = 1, max = 1e9): number => {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)
    throw new HttpError(400, `Invalid ${name}`);
  return Number(value);
};
