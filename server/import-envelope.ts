import { createHash } from 'node:crypto';
import { fields, HttpError, record, text } from './request-validation.js';

/** C0 and DEL characters, written without a regex so the file stays free of literal controls. */
export const hasControl = (value: string) =>
  [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

/** The inline form carries the file itself; the staged form names a file the app already stored. */
export type ImportEnvelopeSource =
  | { name: string; base64: string; uploadId?: undefined }
  | { name: string; uploadId: string; base64?: undefined };

export type ImportEnvelopeOptions = {
  /** Largest payload this reader accepts inline. A staged file keeps the upload route's limit. */
  maxBytes: number;
  /** File names this reader reads. A reader that judges by bytes alone accepts any name. */
  extensions: RegExp;
  /** The 400 code for a refused field set, file name, or encoding. */
  invalid: string;
  /** The 413 code for a payload past `maxBytes`. */
  tooLarge: string;
  /** Smallest payload that can hold this reader's format. */
  minBytes?: number;
  /** Reads a file the app staged for this import; without it only the inline form is accepted. */
  staged?: (uploadId: string) => Buffer;
};

export type ImportEnvelope = {
  name: string;
  bytes: Buffer;
  sha256: string;
  staged: boolean;
  source: ImportEnvelopeSource;
};
/** Without a staged reader the envelope can only be the inline form. */
export type InlineImportEnvelope = ImportEnvelope & {
  staged: false;
  source: Extract<ImportEnvelopeSource, { base64: string }>;
};

/** One visible file name: trimmed, single segment, no control characters, known extension. */
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

/**
 * Reads the request envelope every import file screen sends. It owns the field set, the file
 * name rule, the transport encoding and the size limit, so each reader only judges its own bytes.
 */
export function readImportEnvelope(
  value: unknown,
  options: ImportEnvelopeOptions & { staged?: undefined }
): InlineImportEnvelope;
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
    // Refuse an oversized body by its length, so no reader decodes the whole payload first.
    if (base64.length > Math.ceil(maxBytes / 3) * 4) throw new HttpError(413, tooLarge);
    bytes = Buffer.from(base64, 'base64');
    if (bytes.length > maxBytes) throw new HttpError(413, tooLarge);
    // Re-encoding proves the body is exactly this file, with nothing ignored as it decoded.
    if (bytes.toString('base64') !== base64) throw new HttpError(400, invalid);
    source = { name, base64 };
  }
  if (bytes.length < minBytes) throw new HttpError(400, invalid);
  return {
    name,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    staged: readStaged !== undefined,
    source,
  };
}
