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
  fields(body, ['source', 'kind', 'digest', 'imageHandoffIds', 'allowPartial', 'idempotencyKey']);
  const requestKey = text(body.idempotencyKey, 'request key', 100);
  const { file: originalFile, preview } = analyze(
    body.source,
    body.kind as RisuImportKind | undefined,
    readStaged
  );
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
  const file = await normalizeTransferImages(originalFile);
  const prepared = prepareNativeTransfer({ file });
  return store.transaction(() => {
    const receipt = applyNativeTransfer(store, {
      file,
      digest: prepared.digest,
      modelBindings: [],
      idempotencyKey: `risu:${requestKey}`,
    });
    if (preview.kind !== 'bot') return { receipt, chat: null };
    if (!receipt.created) {
      const exists = store.db.prepare('SELECT id FROM chats WHERE id=?').get(receipt.id);
      return { receipt, chat: exists ? store.chat(receipt.id) : null };
    }
    const botId = receipt.items.find((item) => item.key === 'bot')!.id;
    const chat = store.createChat(preview.title, undefined, { botId }, receipt.id);
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
    return { receipt, chat: store.chat(chat.id) };
  });
}

export function risuImportRoutes(app: FastifyInstance, store: Store) {
  const bodyLimit = Math.ceil(RISU_IMPORT_MAX_BYTES / 3) * 4 + 1024 * 1024;
  const readStaged = (uploadId: string) => readUpload(store.path, uploadId);
  app.post('/api/risu-imports/prepare', { bodyLimit }, async (request) =>
    prepareRisuImport(request.body, readStaged)
  );
  app.post('/api/risu-imports/apply', { bodyLimit }, async (request, reply) => {
    const result = await applyRisuImport(store, request.body, readStaged);
    const source = record(record(request.body).source);
    // The staged file has served its purpose once the material is registered.
    if (result.receipt.created && typeof source.uploadId === 'string')
      deleteUpload(store.path, source.uploadId);
    return reply.code(result.receipt.created ? 201 : 200).send(result);
  });
}
