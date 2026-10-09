import { Worker } from 'node:worker_threads';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  RISU_IMPORT_MAX_BYTES,
  type RisuImportKind,
  type RisuImportPreview,
} from '../core/risu-import.js';
import type { PreparedNativeTransferFile } from '../core/native-transfer-validation.js';
import { fields, HttpError, record } from './request-validation.js';
import { readImportEnvelope } from './import-envelope.js';
import { hasControl } from './import-envelope.js';
import { uploadDirectory, UPLOAD_MAX_AGE_MS, UPLOAD_MAX_BYTES } from './uploads.js';
import { bundleDigest, type PreparedBundleImage } from './resource-bundle.js';
import { acquireImportPreparation, checkImportPreparation } from './import-preparation.js';

export type PreparedRisuImport = {
  version: 1;
  id: string;
  createdAt: number;
  sourceName: string;
  sourceHash: string;
  file: PreparedNativeTransferFile;
  preview: RisuImportPreview;
  images: PreparedBundleImage[];
  transferDigest: string;
  sourceUploadId?: string;
  requestedKind?: RisuImportKind;
};
const ID = /^[a-f0-9]{32}$/u;
const active = new Set<string>();
const directory = (dbPath: string) => join(dirname(resolve(dbPath)), 'risu-prepared');
function pathFor(dbPath: string, id: string) {
  if (!ID.test(id)) throw new HttpError(404, 'RISU_IMPORT_DRAFT_CHANGED');
  return join(directory(dbPath), id);
}
export function deletePreparedRisuImport(dbPath: string, id: string) {
  const path = pathFor(dbPath, id);
  if (active.has(path)) return;
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // A cleanup failure must not undo a successful response; expiry pruning retries it.
  }
}
export function readPreparedRisuImport(dbPath: string, id: string): PreparedRisuImport {
  const path = pathFor(dbPath, id);
  if (!existsSync(join(path, 'manifest.json')))
    throw new HttpError(409, 'RISU_IMPORT_DRAFT_CHANGED');
  const value = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8')) as PreparedRisuImport;
  if (value.version !== 1 || value.id !== id || Date.now() - value.createdAt > UPLOAD_MAX_AGE_MS)
    throw new HttpError(409, 'RISU_IMPORT_DRAFT_CHANGED');
  if (
    value.transferDigest !== bundleDigest(value.file) ||
    value.preview.digest !==
      bundleDigest({
        version: 8,
        transfer: value.transferDigest,
        kind: value.preview.kind,
        findings: value.preview.findings,
        lore: value.preview.lore,
      })
  )
    throw new HttpError(409, 'RISU_IMPORT_DRAFT_CHANGED');
  // The manifest is server-created; derive every binary path rather than following stored paths.
  value.images = value.images.map((image) => {
    if (!/^[a-f0-9]{64}$/u.test(image.hash)) throw new HttpError(409, 'RISU_IMPORT_DRAFT_CHANGED');
    return { ...image, path: join(path, `${image.hash}.image`) };
  });
  return value;
}
export function prunePreparedRisuImports(dbPath: string) {
  const root = directory(dbPath);
  if (!existsSync(root)) return;
  for (const id of readdirSync(root)) {
    if (!ID.test(id) || active.has(join(root, id))) continue;
    if (statSync(join(root, id)).mtimeMs < Date.now() - UPLOAD_MAX_AGE_MS)
      deletePreparedRisuImport(dbPath, id);
  }
}

/** Compatibility for clients that return only a preview digest; paths and blobs remain server-owned. */
export function findPreparedRisuImport(
  dbPath: string,
  digest: string,
  sourceValue: unknown
): PreparedRisuImport | undefined {
  const source = record(sourceValue);
  const root = directory(dbPath);
  if (!existsSync(root)) return undefined;
  let sourceHash: string | undefined;
  if (source.uploadId === undefined) {
    sourceHash = readImportEnvelope(source, {
      maxBytes: RISU_IMPORT_MAX_BYTES,
      extensions: /\.(?:charx|json|png|jpe?g|risum|zip)$/iu,
      invalid: 'RISU_IMPORT_INVALID_FILE',
      tooLarge: 'RISU_IMPORT_TOO_LARGE',
    }).sha256;
  }
  for (const id of readdirSync(root)
    .filter((id) => ID.test(id))
    .slice(-128)) {
    try {
      const prepared = readPreparedRisuImport(dbPath, id);
      if (
        prepared.preview.digest === digest &&
        prepared.sourceName === source.name &&
        (sourceHash
          ? sourceHash === prepared.sourceHash
          : source.uploadId === prepared.sourceUploadId)
      )
        return prepared;
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
    }
  }
  return undefined;
}
const bootstrap = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { registerHooks } = require('node:module');
const { existsSync } = require('node:fs');
const { fileURLToPath } = require('node:url');
registerHooks({ resolve(specifier, context, nextResolve) {
 if ((specifier.startsWith('.') || specifier.startsWith('file:')) && specifier.endsWith('.js')) {
  const url = new URL(specifier, context.parentURL);
  if (!existsSync(fileURLToPath(url))) return nextResolve(url.href.slice(0,-3)+'.ts', context);
 }
 return nextResolve(specifier, context);
}});
import(workerData.module).then(module => module.prepareRisuInWorker(workerData.input))
.then(() => parentPort.postMessage({ok:true}))
.catch(error => parentPort.postMessage({ok:false, code:String(error.message), statusCode:error.statusCode || 400}));
`;
async function worker(input: unknown, signal?: AbortSignal) {
  return new Promise<void>((accept, reject) => {
    if (signal?.aborted) return reject(new HttpError(499, 'RISU_IMPORT_CANCELLED'));
    const thread = new Worker(bootstrap, {
      eval: true,
      execArgv: ['--experimental-transform-types', '--disable-warning=ExperimentalWarning'],
      workerData: {
        module: new URL('./risu-import-prepared-worker.js', import.meta.url).href,
        input,
      },
    });
    let answered = false;
    const abort = () => {
      if (answered) return;
      answered = true;
      signal?.removeEventListener('abort', abort);
      void thread.terminate().then(() => reject(new HttpError(499, 'RISU_IMPORT_CANCELLED')));
    };
    signal?.addEventListener('abort', abort, { once: true });
    thread.once('message', (message) => {
      if (answered) return;
      answered = true;
      signal?.removeEventListener('abort', abort);
      void thread
        .terminate()
        .then(() =>
          message.ok ? accept() : reject(new HttpError(message.statusCode, message.code))
        );
    });
    thread.once('error', (error) => {
      if (answered) return;
      answered = true;
      signal?.removeEventListener('abort', abort);
      reject(error);
    });
    thread.once('exit', () => {
      signal?.removeEventListener('abort', abort);
      if (!answered) reject(new HttpError(400, 'RISU_IMPORT_PREPARATION_FAILED'));
    });
  });
}
/** Large preparation has one accountable owner; an overlapping request cannot multiply peak memory. */
export async function prepareStoredRisuImport(
  dbPath: string,
  value: unknown,
  signal?: AbortSignal
): Promise<RisuImportPreview> {
  checkImportPreparation(signal);
  const body = record(value);
  fields(body, ['source', 'kind', 'preparedId']);
  if (body.kind !== undefined && !['bot', 'persona', 'module'].includes(body.kind))
    throw new HttpError(400, 'RISU_IMPORT_INVALID_FILE');
  if (body.preparedId) {
    const prior = readPreparedRisuImport(dbPath, body.preparedId);
    if (prior.requestedKind === body.kind) return prior.preview;
    const workspace = pathFor(dbPath, prior.id);
    const release = acquireImportPreparation(signal);
    active.add(workspace);
    try {
      await worker(
        {
          path: '',
          name: prior.sourceName,
          kind: body.kind,
          directory: workspace,
          id: prior.id,
          reproject: true,
        },
        signal
      );
      checkImportPreparation(signal);
      // Publish only completed metadata. Failed/cancelled reviews keep the previous manifest.
      renameSync(join(workspace, 'manifest.next.json'), join(workspace, 'manifest.json'));
      return readPreparedRisuImport(dbPath, prior.id).preview;
    } finally {
      try {
        rmSync(join(workspace, 'manifest.next.json'), { force: true });
      } catch {
        // Any abandoned candidate expires with its workspace.
      }
      active.delete(workspace);
      release();
    }
  }
  const id = randomBytes(16).toString('hex');
  const workspace = pathFor(dbPath, id);
  const release = acquireImportPreparation(signal);
  try {
    prunePreparedRisuImports(dbPath);
    mkdirSync(workspace, { recursive: true });
    active.add(workspace);
    const source = record(body.source);
    let sourcePath: string;
    let name: string;
    if (source.uploadId !== undefined) {
      fields(source, ['name', 'uploadId']);
      if (
        typeof source.name !== 'string' ||
        source.name.length > 255 ||
        !source.name.trim() ||
        source.name !== source.name.trim() ||
        hasControl(source.name) ||
        /[/\\:]/u.test(source.name) ||
        typeof source.uploadId !== 'string' ||
        !ID.test(source.uploadId)
      )
        throw new HttpError(400, 'RISU_IMPORT_INVALID_FILE');
      name = source.name;
      sourcePath = join(uploadDirectory(dbPath), `${source.uploadId}.bin`);
      if (!existsSync(sourcePath)) throw new HttpError(404, 'UPLOAD_NOT_FOUND');
      if (statSync(sourcePath).size > UPLOAD_MAX_BYTES)
        throw new HttpError(413, 'UPLOAD_TOO_LARGE');
    } else {
      const envelope = readImportEnvelope(source, {
        maxBytes: RISU_IMPORT_MAX_BYTES,
        extensions: /\.(?:charx|json|png|jpe?g|risum|zip)$/iu,
        invalid: 'RISU_IMPORT_INVALID_FILE',
        tooLarge: 'RISU_IMPORT_TOO_LARGE',
      });
      name = envelope.name;
      sourcePath = join(workspace, 'source.bin');
      writeFileSync(sourcePath, envelope.bytes, { flag: 'wx' });
    }
    await worker(
      {
        path: sourcePath,
        name,
        kind: body.kind as RisuImportKind | undefined,
        directory: workspace,
        id,
      },
      signal
    );
    const prepared = readPreparedRisuImport(dbPath, id);
    if (typeof source.uploadId === 'string') {
      prepared.sourceUploadId = source.uploadId;
      writeFileSync(join(workspace, 'manifest.json'), JSON.stringify(prepared));
    }
    return prepared.preview;
  } catch (error) {
    active.delete(workspace);
    deletePreparedRisuImport(dbPath, id);
    throw error;
  } finally {
    active.delete(workspace);
    release();
  }
}
