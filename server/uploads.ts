import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  createWriteStream,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { HttpError } from './request-validation.js';
import { AppError } from './app-errors.js';
import { noStore } from './endpoint.js';
import { RISU_IMPORT_MAX_UPLOAD_BYTES } from '../core/risu-import.js';
import { ownedImportStagingRoot } from './import-preparation.js';

export const UPLOAD_MAX_BYTES = RISU_IMPORT_MAX_UPLOAD_BYTES;
export const UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ID = /^[a-f0-9]{32}$/u;

export function uploadDirectory(dbPath: string): string {
  return join(dirname(resolve(dbPath)), 'uploads');
}
function uploadPath(dbPath: string, id: string): string {
  if (!ID.test(id)) throw new AppError(400, 'UPLOAD_NOT_FOUND');
  return join(uploadDirectory(dbPath), `${id}.bin`);
}

export function pruneUploads(dbPath: string, maxAgeMs = UPLOAD_MAX_AGE_MS): void {
  const directory = uploadDirectory(dbPath);
  if (!ownedImportStagingRoot(dbPath, directory)) return;
  const cutoff = Date.now() - Math.max(0, maxAgeMs);
  for (const entry of readdirSync(directory)) {
    if (!/^[a-f0-9]{32}\.bin$/u.test(entry)) continue;
    const path = join(directory, entry);
    try {
      const info = lstatSync(path);
      if (info.isFile() && !info.isSymbolicLink() && info.mtimeMs < cutoff)
        rmSync(path, { force: true });
    } catch {}
  }
}

export async function storeUpload(
  dbPath: string,
  stream: Readable,
  limit = UPLOAD_MAX_BYTES
): Promise<{ uploadId: string; bytes: number; sha256: string }> {
  const directory = uploadDirectory(dbPath);
  mkdirSync(directory, { recursive: true });
  const uploadId = randomBytes(16).toString('hex');
  const path = join(directory, `${uploadId}.bin`);
  const file = createWriteStream(path);
  const digest = createHash('sha256');
  let bytes = 0;
  try {
    await new Promise<void>((settle, fail) => {
      const abort = (error: unknown) => {
        stream.destroy();
        file.destroy();
        fail(error);
      };
      stream.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > limit) {
          abort(new AppError(413, 'UPLOAD_TOO_LARGE', { maxBytes: limit }));
          return;
        }
        digest.update(chunk);
        if (!file.write(chunk)) {
          stream.pause();
          file.once('drain', () => stream.resume());
        }
      });
      stream.on('error', abort);
      file.on('error', abort);
      stream.on('end', () => file.end(() => settle()));
    });
  } catch (error) {
    deleteUpload(dbPath, uploadId);
    throw error;
  }
  if (!bytes) {
    deleteUpload(dbPath, uploadId);
    throw new AppError(400, 'UPLOAD_EMPTY');
  }
  return { uploadId, bytes, sha256: digest.digest('hex') };
}

export function readUpload(dbPath: string, id: string, limit = UPLOAD_MAX_BYTES): Buffer {
  const path = uploadPath(dbPath, id);
  if (!existsSync(path)) throw new AppError(404, 'UPLOAD_NOT_FOUND');
  if (statSync(path).size > limit) throw new AppError(413, 'UPLOAD_TOO_LARGE', { maxBytes: limit });
  return readFileSync(path);
}

export function deleteUpload(dbPath: string, id: string): void {
  const path = uploadPath(dbPath, id);
  if (!ownedImportStagingRoot(dbPath, uploadDirectory(dbPath))) return;
  try {
    const info = lstatSync(path);
    if (info.isFile() && !info.isSymbolicLink()) rmSync(path, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function uploadRoutes(app: FastifyInstance, dbPath: string) {
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) =>
    done(null, payload)
  );
  app.post('/api/uploads', { bodyLimit: UPLOAD_MAX_BYTES, onSend: noStore }, async (request) => {
    if (request.headers['content-type'] !== 'application/octet-stream')
      throw new HttpError(415, 'Expected application/octet-stream');
    pruneUploads(dbPath);
    return storeUpload(dbPath, request.raw);
  });
}
