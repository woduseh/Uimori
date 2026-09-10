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

export const parse = (s: any) => (s == null ? null : JSON.parse(String(s)));
export const choice = <T extends string>(v: unknown, values: T[], name: string): T => {
  if (!values.includes(v as T)) throw new HttpError(400, `Invalid ${name}`);
  return v as T;
};
export const boolean = (v: unknown): boolean => {
  if (typeof v !== 'boolean') throw new HttpError(400, 'Invalid boolean');
  return v;
};
export const archiveId = (value: unknown) => {
  const id = text(value, 'archive ID', 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) throw new HttpError(400, 'Invalid archive ID');
  return id;
};
export function archiveList(value: unknown, maximum = 300): any[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new HttpError(400, 'Invalid archive list');
  return value;
}
/** An archive row's parsed body, checked against the row identity every archive kind shares. */
export function archiveVersionBody(row: Record<string, any>): Record<string, any> {
  const body = record(parse(row.body));
  archiveId(row.id);
  number(row.revision, 'version');
  if (body.id !== row.id || body.revision !== row.revision)
    throw new HttpError(400, 'Version identity mismatch');
  return body;
}
