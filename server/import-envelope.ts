import { createHash } from 'node:crypto';
import { fields, HttpError, record, text } from './request-validation.js';

export const hasControl = (value: string) =>
  [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

export type ImportEnvelopeSource =
  | { name: string; base64: string; uploadId?: undefined }
  | { name: string; uploadId: string; base64?: undefined };

export type ImportEnvelopeOptions = {
  maxBytes: number;
  extensions: RegExp;
  invalid: string;
  tooLarge: string;
  minBytes?: number;
  staged?: (uploadId: string) => Buffer;
};

export type ImportEnvelope = {
  name: string;
  bytes: Buffer;
  sha256: string;
  source: ImportEnvelopeSource;
};
function fileName(value: unknown, options: ImportEnvelopeOptions): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > 255 ||
    hasControl(value) ||
    /[/\\:]/u.test(value) ||
    !options.extensions.test(value)
  )
    throw new HttpError(400, options.invalid);
  return value;
}

export function readImportEnvelope(
  value: unknown,
  options: ImportEnvelopeOptions & { staged?: undefined }
): ImportEnvelope & { source: Extract<ImportEnvelopeSource, { base64: string }> };
export function readImportEnvelope(value: unknown, options: ImportEnvelopeOptions): ImportEnvelope;
export function readImportEnvelope(value: unknown, options: ImportEnvelopeOptions): ImportEnvelope {
  const { maxBytes, invalid, tooLarge, minBytes = 1 } = options;
  const input = record(value);
  const readStaged =
    options.staged !== undefined && Object.hasOwn(input, 'uploadId') ? options.staged : undefined;
  fields(input, readStaged ? ['name', 'uploadId'] : ['name', 'base64']);
  const name = fileName(input.name, options);
  let bytes: Buffer;
  let source: ImportEnvelopeSource;
  if (readStaged) {
    const uploadId = text(input.uploadId, 'upload ID', 100);
    bytes = readStaged(uploadId);
    source = { name, uploadId };
  } else {
    const base64: unknown = input.base64;
    if (typeof base64 !== 'string' || !base64) throw new HttpError(400, invalid);
    if (base64.length > Math.ceil(maxBytes / 3) * 4) throw new HttpError(413, tooLarge);
    bytes = Buffer.from(base64, 'base64');
    if (bytes.length > maxBytes) throw new HttpError(413, tooLarge);
    if (bytes.toString('base64') !== base64) throw new HttpError(400, invalid);
    source = { name, base64 };
  }
  if (bytes.length < minBytes) throw new HttpError(400, invalid);
  return {
    name,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    source,
  };
}
