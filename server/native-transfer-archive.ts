import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { NativeTransferPrepare } from '../core/native-transfer.js';
import {
  validatePreparedNativeTransfer,
  type PreparedNativeTransferFile,
} from '../core/native-transfer-validation.js';
import { RISU_AGGREGATE_IMAGES_MAX } from '../core/risu-limits.js';
import { CHAT_BACKUP_FORMAT, CHAT_BACKUP_VERSION, type ChatBackup } from '../core/chat-backup.js';
import { validateChatTranscript } from '../core/chat-transcript.js';
import { validateChatVariableState } from '../core/chat-variables.js';
import type { Store } from './store.js';
import { fields, HttpError, record, text } from './request-validation.js';
import {
  bundleDigest,
  importPreparedResourceBundle,
  type PreparedBundleImage,
} from './resource-bundle.js';
import { readImage } from './image-storage.js';
import { readImportReceipt, saveImportReceipt } from './import-operations.js';
import type { NativeTransferReceipt } from '../core/native-transfer.js';
import { processImage } from './image-processing.js';
import { acquireImportPreparation, checkImportPreparation } from './import-preparation.js';
import { deleteUpload, uploadDirectory, UPLOAD_MAX_AGE_MS } from './uploads.js';
import {
  NATIVE_ARCHIVE_MAX_BYTES,
  NATIVE_ARCHIVE_METADATA_MAX_BYTES,
  nativeArchiveStream,
  readNativeArchive,
} from './native-transfer-archive-codec.js';

type BinaryImage = { hash: string; mime: PreparedBundleImage['mime']; bytes: number };
export type ArchiveBackup = Omit<ChatBackup, 'resources'>;
export type NativeArchiveManifest = {
  format: 'uimori-archive';
  version: 1;
  kind: 'resources' | 'chat';
  resources: PreparedNativeTransferFile;
  images: BinaryImage[];
  backup?: ArchiveBackup;
};
export type PreparedArchive = {
  manifest: NativeArchiveManifest;
  images: PreparedBundleImage[];
  preview: NativeTransferPrepare;
  createdAt: number;
};
const invalid = (): never => {
  throw new HttpError(400, '자료 백업 파일을 확인해 주세요.');
};
const imagePath = (hash: string) => `images/${hash}.bin`;
function archiveBytes(metadataBytes: number, images: BinaryImage[]) {
  return (
    metadataBytes +
    images.reduce(
      (sum, image) => sum + image.bytes + 76 + 2 * Buffer.byteLength(imagePath(image.hash)),
      0
    ) +
    76 +
    2 * Buffer.byteLength('manifest.json') +
    22
  );
}
const archiveDirectory = (store: Store) => join(uploadDirectory(store.path), 'native-prepared');
const activeArchives = new Set<string>();
function preparedPath(store: Store, id: string) {
  if (!/^[a-f0-9]{32}$/u.test(id)) invalid();
  return join(archiveDirectory(store), id);
}

/** Cleanup cannot turn a committed import into a failed response; TTL pruning retries failures. */
export function deletePreparedArchive(store: Store, id: string): void {
  const directory = preparedPath(store, id);
  if (activeArchives.has(directory)) return;
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    /* The next expiry prune retries. */
  }
}

/** A separate read snapshot keeps bytes alive while the HTTP stream yields to other requests. */
export function exportNativeArchive(
  store: Store,
  resources: PreparedNativeTransferFile,
  backup?: ArchiveBackup
) {
  validatePreparedNativeTransfer(resources);
  const hashes = new Set(resources.images.map((image) => image.hash));
  for (const copy of backup?.chats ?? []) {
    for (const image of copy.illustrations) {
      if (!/^archive:[a-f0-9]{64}$/u.test(image.base64)) invalid();
      hashes.add(image.base64.slice(8));
    }
    for (const entry of [
      ...copy.transcript.entries,
      ...(copy.state.messages ?? []).map((message) => ({
        text: JSON.stringify(message),
        translation: null,
      })),
    ])
      for (const value of [entry.text, entry.translation ?? ''])
        for (const match of value.matchAll(/\/api\/package-image-blobs\/([a-f0-9]{64})/gu))
          hashes.add(match[1]);
  }
  if (hashes.size > RISU_AGGREGATE_IMAGES_MAX) invalid();
  const db = new DatabaseSync(store.path, { readOnly: true });
  try {
    db.exec('BEGIN');
    const query = db.prepare('SELECT mime,length(bytes) AS bytes FROM image_blobs WHERE hash=?');
    const images = [...hashes].map((hash) => {
      const row = query.get(hash);
      if (!row) invalid();
      return { hash, mime: row!.mime as BinaryImage['mime'], bytes: Number(row!.bytes) };
    });
    const manifest: NativeArchiveManifest = {
      format: 'uimori-archive',
      version: 1,
      kind: backup ? 'chat' : 'resources',
      resources,
      images,
      ...(backup ? { backup } : {}),
    };
    const metadata = Buffer.from(JSON.stringify(manifest));
    const estimated = archiveBytes(metadata.length, images);
    if (metadata.length > NATIVE_ARCHIVE_METADATA_MAX_BYTES || estimated > NATIVE_ARCHIVE_MAX_BYTES)
      throw new HttpError(413, '자료 백업은 512MiB까지 내보낼 수 있어요.');
    const entries = [
      { name: 'manifest.json', read: () => metadata },
      ...images.map((image) => ({
        name: imagePath(image.hash),
        read: () => readImage(db, image.hash).bytes,
      })),
    ];
    const stream = nativeArchiveStream(entries);
    let closed = false;
    const close = () => {
      if (!closed) {
        closed = true;
        db.close();
      }
    };
    stream.once('close', close);
    stream.once('end', close);
    stream.once('error', close);
    return stream;
  } catch (error) {
    db.close();
    throw error;
  }
}

function pruneArchives(store: Store) {
  const directory = archiveDirectory(store);
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory)) {
    if (!/^[a-f0-9]{32}$/u.test(name) || activeArchives.has(join(directory, name))) continue;
    const path = join(directory, name);
    if (statSync(path).mtimeMs < Date.now() - UPLOAD_MAX_AGE_MS)
      rmSync(path, { recursive: true, force: true });
  }
}

/** The uploaded archive is read by ranges, then images are validated one at a time before review. */
export async function prepareNativeArchive(
  store: Store,
  uploadId: string,
  kind: 'resources' | 'chat',
  signal?: AbortSignal
) {
  if (!/^[a-f0-9]{32}$/u.test(uploadId)) invalid();
  const source = join(uploadDirectory(store.path), `${uploadId}.bin`);
  const id = randomBytes(16).toString('hex'),
    directory = preparedPath(store, id);
  const release = acquireImportPreparation(signal);
  let fd: number | undefined;
  let completed = false;
  try {
    pruneArchives(store);
    checkImportPreparation(signal);
    fd = openSync(source, 'r');
    mkdirSync(directory, { recursive: true });
    activeArchives.add(directory);
    const read = (offset: number, length: number) => {
      checkImportPreparation(signal);
      const result = Buffer.alloc(length);
      if (readSync(fd!, result, 0, length, offset) !== length) invalid();
      return result;
    };
    const members = readNativeArchive(statSync(source).size, read);
    let value: unknown;
    try {
      value = JSON.parse(members.get('manifest.json')!().toString('utf8'));
    } catch {
      invalid();
    }
    const raw = record(value);
    fields(raw, ['format', 'version', 'kind', 'resources', 'images', 'backup']);
    if (
      raw.format !== 'uimori-archive' ||
      raw.version !== 1 ||
      raw.kind !== kind ||
      !Array.isArray(raw.images) ||
      raw.images.length > RISU_AGGREGATE_IMAGES_MAX
    )
      invalid();
    const manifest = raw as NativeArchiveManifest;
    validatePreparedNativeTransfer(manifest.resources);
    if ((kind === 'chat') !== !!manifest.backup || members.size !== manifest.images.length + 1)
      invalid();
    if (manifest.backup) {
      const backup = record(manifest.backup);
      fields(backup, ['format', 'version', 'createdAt', 'title', 'chats', 'notices']);
      if (
        backup.format !== CHAT_BACKUP_FORMAT ||
        backup.version !== CHAT_BACKUP_VERSION ||
        typeof backup.createdAt !== 'string' ||
        typeof backup.title !== 'string' ||
        !Array.isArray(backup.chats) ||
        !backup.chats.length ||
        !Array.isArray(backup.notices) ||
        backup.notices.some((notice: unknown) => typeof notice !== 'string')
      )
        invalid();
      for (const rawCopy of backup.chats) {
        const copy = record(rawCopy);
        fields(copy, ['transcript', 'state', 'illustrations']);
        validateChatTranscript(copy.transcript);
        const state = record(copy.state);
        validateChatVariableState(state.variables);
        if (!Array.isArray(state.checkpoints) || !Array.isArray(copy.illustrations)) invalid();
        for (const checkpoint of state.checkpoints)
          if (checkpoint !== null) validateChatVariableState(checkpoint);
      }
    }
    const converted = new Map<string, BinaryImage>(),
      blobs = new Map<string, PreparedBundleImage>();
    let total = 0;
    for (const item of manifest.images) {
      checkImportPreparation(signal);
      const descriptor = record(item);
      fields(descriptor, ['hash', 'mime', 'bytes']);
      if (
        !/^[a-f0-9]{64}$/u.test(descriptor.hash) ||
        converted.has(descriptor.hash) ||
        !Number.isSafeInteger(descriptor.bytes) ||
        descriptor.bytes <= 0
      )
        invalid();
      const get = members.get(imagePath(descriptor.hash));
      if (!get) invalid();
      const bytes = get!();
      if (
        bytes.length !== descriptor.bytes ||
        createHash('sha256').update(bytes).digest('hex') !== descriptor.hash
      )
        invalid();
      const processed = await processImage(bytes);
      checkImportPreparation(signal);
      const image = { hash: processed.hash, mime: processed.mime, bytes: processed.bytes.length };
      converted.set(descriptor.hash, image);
      if (!blobs.has(image.hash)) {
        total += image.bytes;
        if (total > NATIVE_ARCHIVE_MAX_BYTES)
          throw new HttpError(413, '자료 이미지가 512MiB를 넘어요.');
        const path = join(directory, `${image.hash}.bin`);
        writeFileSync(path, processed.bytes);
        blobs.set(image.hash, { ...image, path });
      }
    }
    for (const entry of manifest.resources.contents)
      for (const image of entry.source.package.images ?? []) {
        const blob = converted.get(image.blobHash);
        if (!blob) invalid();
        image.blobHash = blob!.hash;
        image.mime = blob!.mime;
      }
    const resourceHashes = new Set(manifest.resources.images.map((image) => image.hash));
    manifest.resources.images = [
      ...new Map(
        [...(kind === 'chat' ? converted.keys() : resourceHashes)].map((hash) => {
          const image = converted.get(hash);
          if (!image) invalid();
          return [
            image!.hash,
            { id: image!.hash, revision: 1 as const, hash: image!.hash, mime: image!.mime },
          ] as const;
        })
      ).values(),
    ];
    if (manifest.backup)
      for (const copy of manifest.backup.chats) {
        const rewrite = (value: string) =>
          value.replace(/\/api\/package-image-blobs\/([a-f0-9]{64})/gu, (url, hash: string) => {
            const image = converted.get(hash);
            if (!image) invalid();
            return image ? `/api/package-image-blobs/${image.hash}` : url;
          });
        for (const entry of copy.transcript.entries) {
          entry.text = rewrite(entry.text);
          if (entry.translation !== null) entry.translation = rewrite(entry.translation);
        }
        // Message state is metadata; rewriting only the image URLs preserves its other fields.
        if (copy.state.messages)
          copy.state.messages = JSON.parse(rewrite(JSON.stringify(copy.state.messages)));
        for (const image of copy.illustrations) {
          if (!/^archive:[a-f0-9]{64}$/u.test(image.base64)) invalid();
          const blob = converted.get(image.base64.slice(8));
          if (!blob) invalid();
          image.base64 = `archive:${blob!.hash}`;
          image.mime = 'image/webp';
        }
      }
    manifest.images = [...blobs.values()].map(({ path: _path, ...image }) => image);
    const metadataBytes = Buffer.byteLength(JSON.stringify(manifest));
    if (
      metadataBytes > NATIVE_ARCHIVE_METADATA_MAX_BYTES ||
      archiveBytes(metadataBytes, manifest.images) > NATIVE_ARCHIVE_MAX_BYTES
    )
      throw new HttpError(413, '변환한 자료 백업이 512MiB를 넘어요.');
    const checked = validatePreparedNativeTransfer(manifest.resources);
    const images = [...blobs.values()];
    const preview: NativeTransferPrepare = {
      digest: bundleDigest(manifest),
      entries: checked.entries,
      modelRequirements: checked.modelRequirements,
      warnings: checked.warnings,
      summary: {
        contents: manifest.resources.contents.length,
        prompts: manifest.resources.prompts.length,
        combinations: manifest.resources.prompts.reduce(
          (sum, item) => sum + item.combinations.length,
          0
        ),
        images: images.length,
        imageBytes: total,
      },
    };
    const prepared: PreparedArchive = { manifest, images, preview, createdAt: Date.now() };
    checkImportPreparation(signal);
    writeFileSync(join(directory, 'prepared.json'), JSON.stringify(prepared));
    completed = true;
    return {
      preparedId: id,
      ...preview,
      ...(manifest.backup
        ? {
            backup: {
              title: manifest.backup.title,
              chats: manifest.backup.chats.length,
              sources: manifest.backup.chats.reduce(
                (sum, chat) => sum + chat.transcript.entries.length,
                0
              ),
            },
          }
        : {}),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  } finally {
    try {
      if (fd !== undefined) closeSync(fd);
    } finally {
      activeArchives.delete(directory);
      release();
      if (completed) {
        try {
          deleteUpload(store.path, uploadId);
        } catch {
          /* Upload expiry cleanup retries. */
        }
      }
    }
  }
}

export async function prepareNativeArchiveRequest(
  store: Store,
  request: FastifyRequest,
  reply: FastifyReply,
  kind: 'resources' | 'chat'
) {
  const body = record(request.body);
  fields(body, ['uploadId']);
  const abort = new AbortController();
  const closed = () => {
    if (!reply.raw.writableFinished) abort.abort();
  };
  reply.raw.once('close', closed);
  try {
    return await prepareNativeArchive(
      store,
      text(body.uploadId, 'upload ID', 32),
      kind,
      abort.signal
    );
  } finally {
    reply.raw.removeListener('close', closed);
  }
}

export function readPreparedArchive(
  store: Store,
  id: string,
  digest: string,
  kind: 'resources' | 'chat'
): PreparedArchive {
  const directory = preparedPath(store, id),
    path = join(directory, 'prepared.json');
  if (!existsSync(path))
    throw new HttpError(410, '자료 가져오기가 만료됐어요. 파일을 다시 선택해 주세요.');
  const result = JSON.parse(readFileSync(path, 'utf8')) as PreparedArchive;
  if (
    result.createdAt < Date.now() - UPLOAD_MAX_AGE_MS ||
    result.manifest.kind !== kind ||
    bundleDigest(result.manifest) !== digest
  )
    throw new HttpError(409, '가져올 자료가 변경됐어요. 다시 확인해 주세요.');
  // No caller-provided absolute path crosses the registration boundary.
  result.images = result.images.map((image) => ({
    ...image,
    path: join(directory, `${image.hash}.bin`),
  }));
  return result;
}

export function nativeTransferArchiveRoutes(
  app: FastifyInstance,
  store: Store,
  capture: (value: unknown) => PreparedNativeTransferFile
) {
  app.post('/api/native-transfers/export-archive', (request, reply) =>
    reply
      .type('application/zip')
      .header('Content-Disposition', 'attachment; filename="resources.uimori"')
      .send(exportNativeArchive(store, capture(request.body)))
  );
  app.post('/api/native-transfers/prepare-archive', (request, reply) =>
    prepareNativeArchiveRequest(store, request, reply, 'resources')
  );
  app.post('/api/native-transfers/apply-archive', (request) => {
    const body = record(request.body);
    fields(body, ['preparedId', 'digest', 'idempotencyKey', 'modelBindings']);
    const id = text(body.preparedId, 'prepared ID', 32),
      digest = text(body.digest, 'digest', 64),
      key = `archive:${text(body.idempotencyKey, 'import request', 100)}`;
    const command = bundleDigest({ id, digest, modelBindings: body.modelBindings ?? [] });
    const result = store.transaction(() => {
      // A completed request is recoverable even after its temporary files expire.
      const prior = readImportReceipt<NativeTransferReceipt>(store, key, command);
      if (prior) return { ...prior, created: false };
      const prepared = readPreparedArchive(store, id, digest, 'resources');
      const receipt = importPreparedResourceBundle(
        store,
        prepared.manifest.resources,
        prepared.images,
        {
          digest: bundleDigest(prepared.manifest.resources),
          idempotencyKey: `resources:${key}`,
          modelBindings: body.modelBindings,
        }
      );
      const result = { ...receipt, digest };
      saveImportReceipt(store, key, command, result);
      return result;
    });
    deletePreparedArchive(store, id);
    return result;
  });
}
