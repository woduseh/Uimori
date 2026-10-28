import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  REQUEST_FILE_MAX_BYTES,
  REQUEST_FILE_MAX_COUNT,
  REQUEST_FILES_MAX_BYTES,
  classifyRequestFile,
  type RequestFile,
  type RequestFileUpload,
  type ResolvedRequestFile,
} from '../core/request-files.js';
import { countTextTokens } from '../core/text-tokens.js';
import {
  readRequestFileBlob,
  storeRequestFileBlob,
  type StoredRequestFile,
} from './request-file-storage.js';
import { fields, HttpError, record, text } from './request-validation.js';
import type { Store } from './store.js';
import { deleteUpload, readUpload } from './uploads.js';

const HASH = /^[a-f0-9]{64}$/u;
function invalidFormat(): never {
  throw new HttpError(400, 'REQUEST_FILE_FORMAT_INVALID');
}

function fileName(value: unknown): string {
  const name = text(value, 'file name', 300);
  if (/[\p{Cc}/\\]/u.test(name)) throw new HttpError(400, 'REQUEST_FILE_NAME_INVALID');
  return name;
}

export function requestFileUploads(value: unknown): RequestFileUpload[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > REQUEST_FILE_MAX_COUNT)
    throw new HttpError(400, 'REQUEST_FILE_COUNT_INVALID');
  return value.map((raw) => {
    const file = record(raw);
    fields(file, ['uploadId', 'sha256', 'name']);
    if (!/^[a-f0-9]{32}$/u.test(file.uploadId) || !HASH.test(file.sha256))
      throw new HttpError(400, 'REQUEST_FILE_UPLOAD_INVALID');
    const name = fileName(file.name);
    if (!classifyRequestFile(name)) invalidFormat();
    return { uploadId: file.uploadId as string, sha256: file.sha256 as string, name };
  });
}

const starts = (bytes: Buffer, marker: string) =>
  bytes.subarray(0, marker.length).toString('latin1') === marker;
const isoMedia = (bytes: Buffer) =>
  bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp';
const ebml = (bytes: Buffer) => bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));

/** Validate format signatures without decoding, extracting or changing authored binary bytes. */
function assertBinaryFormat(bytes: Buffer, name: string, mime: string): void {
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  let valid = false;
  if (mime === 'application/pdf') valid = bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'));
  else if (['docx', 'pptx', 'xlsx', 'odt', 'pages', 'key', 'keynote'].includes(extension))
    valid = starts(bytes, 'PK\x03\x04');
  else if (
    [
      'doc',
      'dot',
      'ppt',
      'pot',
      'ppa',
      'pps',
      'pwz',
      'wiz',
      'xls',
      'xla',
      'xlb',
      'xlc',
      'xlm',
      'xlt',
      'xlw',
    ].includes(extension)
  )
    valid = bytes
      .subarray(0, 8)
      .equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  else if (extension === 'rtf') valid = starts(bytes, '{\\rtf');
  else if (extension === 'wav')
    valid = starts(bytes, 'RIFF') && bytes.subarray(8, 12).toString('ascii') === 'WAVE';
  else if (['aif', 'aiff', 'aifc'].includes(extension))
    valid =
      starts(bytes, 'FORM') && ['AIFF', 'AIFC'].includes(bytes.subarray(8, 12).toString('ascii'));
  else if (['mp3', 'mpeg', 'mpg', 'mpga', 'aac'].includes(extension) && mime.startsWith('audio/'))
    valid =
      starts(bytes, 'ID3') ||
      (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  else if (['ogg', 'oga', 'opus'].includes(extension)) valid = starts(bytes, 'OggS');
  else if (extension === 'flac') valid = starts(bytes, 'fLaC');
  else if (['mp4', 'm4a', 'm4v', '3gp', '3gpp'].includes(extension)) valid = isoMedia(bytes);
  else if (extension === 'mov')
    valid =
      isoMedia(bytes) || ['moov', 'mdat', 'wide'].includes(bytes.subarray(4, 8).toString('ascii'));
  else if (['webm', 'weba'].includes(extension)) valid = ebml(bytes);
  else if (extension === 'avi')
    valid = starts(bytes, 'RIFF') && bytes.subarray(8, 12).toString('ascii') === 'AVI ';
  else if (extension === 'flv') valid = starts(bytes, 'FLV');
  else if (['mpeg', 'mpg'].includes(extension))
    valid = bytes.subarray(0, 3).equals(Buffer.from([0, 0, 1]));
  else if (extension === 'wmv')
    valid = bytes
      .subarray(0, 16)
      .equals(
        Buffer.from([
          0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0, 0xaa, 0, 0x62, 0xce, 0x6c,
        ])
      );
  else if (['l16', 'alaw', 'mulaw'].includes(extension)) valid = true;
  if (!valid) invalidFormat();
}

export type PreparedRequestFiles = { files: RequestFile[]; blobs: StoredRequestFile[] };

/** No unowned permanent bytes are written before the owning task is admitted. */
export function prepareRequestFiles(
  store: Pick<Store, 'path'>,
  uploads: readonly RequestFileUpload[]
): PreparedRequestFiles {
  if (uploads.length > REQUEST_FILE_MAX_COUNT)
    throw new HttpError(400, 'REQUEST_FILE_COUNT_INVALID');
  const files: RequestFile[] = [];
  const blobs = new Map<string, StoredRequestFile>();
  let totalBytes = 0;
  for (const upload of uploads) {
    const name = fileName(upload.name);
    const type = classifyRequestFile(name);
    if (!type) invalidFormat();
    const bytes = readUpload(store.path, upload.uploadId, REQUEST_FILE_MAX_BYTES);
    totalBytes += bytes.length;
    if (totalBytes > REQUEST_FILES_MAX_BYTES) throw new HttpError(413, 'REQUEST_FILES_TOO_LARGE');
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== upload.sha256) throw new HttpError(409, 'REQUEST_FILE_CHANGED');
    let tokenEstimate: number | undefined;
    if (type.kind === 'text') {
      let decoded: string;
      try {
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        return invalidFormat();
      }
      if (decoded.includes('\0')) invalidFormat();
      tokenEstimate = Math.max(1, countTextTokens(decoded));
    } else assertBinaryFormat(bytes, name, type.mime);
    files.push({
      hash,
      name,
      ...type,
      bytes: bytes.length,
      ...(tokenEstimate === undefined ? {} : { tokenEstimate }),
    });
    blobs.set(hash, { hash, bytes });
  }
  return { files, blobs: [...blobs.values()] };
}

/** Must join the transaction that reserves the owning task and message. */
export function storeRequestFiles(store: Pick<Store, 'db'>, prepared: PreparedRequestFiles): void {
  for (const blob of prepared.blobs) storeRequestFileBlob(store.db, blob);
}

export function releaseRequestFileUploads(
  store: Pick<Store, 'path'>,
  uploads: readonly RequestFileUpload[]
): void {
  for (const upload of uploads) {
    try {
      deleteUpload(store.path, upload.uploadId);
    } catch {
      /* Staging expiry retries cleanup without changing an accepted task's outcome. */
    }
  }
}

export function assertRequestFiles(store: Pick<Store, 'db'>, files: readonly RequestFile[]): void {
  const exists = store.db.prepare(
    'SELECT length(bytes) AS size FROM attachment_blobs WHERE hash=?'
  );
  for (const file of files) {
    const row = exists.get(file.hash);
    if (!row) throw new HttpError(400, 'REQUEST_FILE_MISSING');
    if (row.size !== file.bytes) throw new HttpError(409, 'REQUEST_FILE_CHANGED');
  }
}

export function readRequestFile(store: Pick<Store, 'db'>, file: RequestFile): ResolvedRequestFile {
  const blob = readRequestFileBlob(store.db, file.hash);
  if (blob.bytes.length !== file.bytes) throw new HttpError(409, 'REQUEST_FILE_CHANGED');
  return { mime: file.mime, base64: blob.bytes.toString('base64') };
}

export function requestFileRoutes(app: FastifyInstance, store: Pick<Store, 'db'>): void {
  app.get<{ Params: { hash: string }; Querystring: { name?: string } }>(
    '/api/request-files/:hash',
    (request, reply) => {
      const blob = readRequestFileBlob(store.db, request.params.hash);
      const name =
        request.query.name === undefined ? 'attachment.bin' : fileName(request.query.name);
      const encodedName = encodeURIComponent(name).replace(
        /[!'()*]/gu,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
      );
      return reply
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'private, max-age=31536000, immutable')
        .header(
          'Content-Disposition',
          `attachment; filename="attachment"; filename*=UTF-8''${encodedName}`
        )
        .type(classifyRequestFile(name)?.mime ?? 'application/octet-stream')
        .send(blob.bytes);
    }
  );
}
