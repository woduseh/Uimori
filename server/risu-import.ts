import { readImportReceipt, saveImportReceipt } from './import-operations.js';
import { bundleDigest, importPreparedResourceBundle } from './resource-bundle.js';
import {
  prepareStoredRisuImport,
  readPreparedRisuImport,
  deletePreparedRisuImport,
  findPreparedRisuImport,
} from './risu-import-prepared.js';
import type { PreparedNativeTransferFile } from '../core/native-transfer-validation.js';
import type { NativeTransferFile } from '../core/native-transfer.js';
import { normalizeTransferImages } from './transfer-images.js';
import type { FastifyInstance } from 'fastify';
import {
  RISU_IMPORT_MAX_BYTES,
  type RisuImportPreview,
  type RisuImportResult,
  type RisuImportKind,
} from '../core/risu-import.js';
import { readCharacterCard } from './character-card-file.js';
import { applyNativeTransfer, prepareNativeTransfer } from './native-transfer.js';
import { deleteUpload, readUpload } from './uploads.js';
import { fields, HttpError, record, text } from './request-validation.js';
import { analyzeNativeRisuImport } from './risu-native-import.js';
import type { Store } from './store.js';
import { createPackageStart } from './package-start.js';
import type { Content } from '../core/product.js';

function analyze(
  value: unknown,
  requestedKind?: RisuImportKind,
  readStaged?: (uploadId: string) => Buffer
) {
  return analyzeNativeRisuImport(readCharacterCard(value, requestedKind, readStaged));
}

export function prepareRisuImport(
  value: unknown,
  readStaged?: (uploadId: string) => Buffer
): RisuImportPreview {
  const body = record(value);
  fields(body, ['source', 'kind']);
  return analyze(body.source, body.kind as RisuImportKind | undefined, readStaged).preview;
}

export async function applyRisuImport(
  store: Store,
  value: unknown,
  readStaged?: (uploadId: string) => Buffer
): Promise<RisuImportResult> {
  const body = record(value);
  fields(body, [
    'source',
    'preparedId',
    'kind',
    'digest',
    'imageHandoffIds',
    'allowPartial',
    'createChat',
    'idempotencyKey',
  ]);
  if (body.createChat !== undefined && typeof body.createChat !== 'boolean')
    throw new HttpError(400, 'RISU_IMPORT_INVALID_FILE');
  if (body.preparedId !== undefined && typeof body.preparedId !== 'string')
    throw new HttpError(400, 'RISU_IMPORT_INVALID_FILE');
  const requestKey = text(body.idempotencyKey, 'request key', 100);
  // A response-loss retry must not touch the already-consumed staged upload.
  const operationKey = `risu-result:${requestKey}`;
  const commandDigest = bundleDigest({
    digest: text(body.digest, 'import digest', 100),
    kind: body.kind ?? null,
    allowPartial: body.allowPartial,
    imageHandoffIds: body.imageHandoffIds ?? null,
    ...(body.createChat === false ? { createChat: false } : {}),
  });
  const previous = () => {
    const result = readImportReceipt<RisuImportResult>(store, operationKey, commandDigest);
    if (!result) return undefined;
    const exists =
      result.chat && store.db.prepare('SELECT id FROM chats WHERE id=?').get(result.chat.id);
    return {
      receipt: { ...result.receipt, created: false },
      chat: exists ? store.chat(result.chat!.id) : null,
    };
  };
  const prior = previous();
  if (prior) return prior;
  const staged =
    typeof body.preparedId === 'string'
      ? readPreparedRisuImport(store.path, body.preparedId)
      : findPreparedRisuImport(store.path, body.digest, body.source);
  const { file: originalFile, preview } =
    staged ?? analyze(body.source, body.kind as RisuImportKind | undefined, readStaged);
  if (staged && body.kind !== undefined && body.kind !== preview.kind)
    throw new HttpError(409, 'RISU_IMPORT_DRAFT_CHANGED');
  if (body.digest !== preview.digest) throw new HttpError(409, 'RISU_IMPORT_DRAFT_CHANGED');
  if (typeof body.allowPartial !== 'boolean') throw new HttpError(400, 'RISU_IMPORT_INVALID_FILE');
  if (preview.findings.some((item) => item.level === 'unsupported') && !body.allowPartial)
    throw new HttpError(400, 'RISU_IMPORT_PARTIAL_REQUIRED');
  if (body.imageHandoffIds !== undefined) {
    const policy = originalFile.contents[0].source.package!.imageHandoff;
    if (
      !Array.isArray(body.imageHandoffIds) ||
      body.imageHandoffIds.length > 64 ||
      body.imageHandoffIds.some(
        (id: unknown) => typeof id !== 'string' || !policy?.ranges.some((range) => range.id === id)
      )
    )
      throw new HttpError(400, 'RISU_IMPORT_IMAGE_HANDOFF_SELECTION');
    if (policy)
      policy.ranges = policy.ranges.map((range) => ({
        ...range,
        enabled: body.imageHandoffIds.includes(range.id),
      }));
  }
  const file = staged
    ? staged.file
    : await normalizeTransferImages(originalFile as NativeTransferFile);
  const prepared = staged ? { digest: bundleDigest(file) } : prepareNativeTransfer({ file });
  const result = store.transaction(() => {
    const concurrent = previous();
    if (concurrent) return concurrent;
    const finish = (result: RisuImportResult) => {
      saveImportReceipt(store, operationKey, commandDigest, result);
      return result;
    };
    const command = {
      file,
      digest: prepared.digest,
      modelBindings: [],
      idempotencyKey: `risu:${requestKey}`,
    };
    const receipt = staged
      ? importPreparedResourceBundle(
          store,
          file as PreparedNativeTransferFile,
          staged.images,
          command
        )
      : applyNativeTransfer(store, command);
    if (preview.kind !== 'bot' || body.createChat === false) return finish({ receipt, chat: null });
    if (!receipt.created) {
      const exists = store.db.prepare('SELECT id FROM chats WHERE id=?').get(receipt.id);
      return finish({ receipt, chat: exists ? store.chat(receipt.id) : null });
    }
    const botId = receipt.items.find((item) => item.key === 'bot')!.id;
    const chat = store.createChat(preview.title, { botId }, receipt.id);
    const content = store.product.get<Content>('content', botId);
    const first =
      content.package?.nativeRisu &&
      content.package.starts?.find(
        (start) => start.id === 'start-0' && start.mode === 'authored' && start.text.trim()
      );
    if (first)
      createPackageStart(store, chat.id, {
        packageId: content.id,
        packageRevision: content.revision,
        startId: first.id,
        expectedSettingsRevision: chat.settingsRevision,
        expectedProfileRevision: store.product.profile(chat.id).revision,
        idempotencyKey: `risu-start:${requestKey}`,
      });
    return finish({ receipt, chat: store.chat(chat.id) });
  });
  if (staged && result.receipt.created) deletePreparedRisuImport(store.path, staged.id);
  return result;
}

export function risuImportRoutes(app: FastifyInstance, store: Store) {
  const bodyLimit = Math.ceil(RISU_IMPORT_MAX_BYTES / 3) * 4 + 1024 * 1024;
  const readStaged = (uploadId: string) => readUpload(store.path, uploadId);
  app.post('/api/risu-imports/prepare', { bodyLimit }, async (request, reply) => {
    const abort = new AbortController();
    const closed = () => {
      if (!reply.raw.writableFinished) abort.abort();
    };
    reply.raw.once('close', closed);
    try {
      return await prepareStoredRisuImport(store.path, request.body, abort.signal);
    } finally {
      reply.raw.removeListener('close', closed);
    }
  });
  app.post('/api/risu-imports/apply', { bodyLimit }, async (request, reply) => {
    const result = await applyRisuImport(store, request.body, readStaged);
    const source = record(record(request.body).source);
    // The staged file has served its purpose once the material is registered.
    if (result.receipt.created && typeof source.uploadId === 'string') {
      try {
        deleteUpload(store.path, source.uploadId);
      } catch {
        // The import is committed; upload expiry cleanup retries a locked file.
      }
    }
    return reply.code(result.receipt.created ? 201 : 200).send(result);
  });
}
