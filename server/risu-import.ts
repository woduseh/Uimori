import type { FastifyInstance } from 'fastify';
import {
  RISU_IMPORT_MAX_BYTES,
  type RisuImportPreview,
  type RisuImportResult,
  type RisuImportKind,
} from '../core/risu-import.js';
import { readCharacterCard } from './character-card-file.js';
import { importRisuDisplayRegex } from './risu-regex.js';
import { applyNativeTransfer, prepareNativeTransfer } from './native-transfer.js';
import { deleteUpload, readUpload } from './uploads.js';
import { fields, HttpError, record, text } from './request-validation.js';
import { object, type RisuCard, type RisuCardExtension } from './risu-import-card.js';
import { createRisuImportFindings } from './risu-import-findings.js';
import { importRisuIdentity } from './risu-import-identity.js';
import { importRisuAssets } from './risu-import-assets.js';
import { createRisuImportText } from './risu-import-text.js';
import { importRisuBody, importRisuGreetings } from './risu-import-body.js';
import { importRisuLore } from './risu-import-lore.js';
import { importRisuTriggers } from './risu-import-triggers.js';
import { scanRisuExtensionSurfaces } from './risu-import-surfaces.js';
import { buildRisuTransfer } from './risu-import-transfer.js';
import type { Store } from './store.js';

/**
 * A one-way format adapter. No Risu runtime or source-specific behavior enters the package.
 * Each stage reads the card and reports what it could not carry over, and the order they run in is
 * the order the preview lists its findings.
 */
function analyze(
  value: unknown,
  requestedKind?: RisuImportKind,
  readStaged?: (uploadId: string) => Buffer
) {
  const input = readCharacterCard(value, requestedKind, readStaged);
  const card = input.card as RisuCard;
  const risu = object(object(card.extensions).risuai) as RisuCardExtension;
  const findings = createRisuImportFindings();
  const { pkg, title } = importRisuIdentity({ input, card, risu, findings });
  const assets = importRisuAssets({ card, kind: input.kind, members: input.members, findings });
  pkg.images = assets.packageImages;
  if (assets.portraitImageId !== undefined) pkg.portraitImageId = assets.portraitImageId;
  const cardText = createRisuImportText(assets.assetUrls, findings);
  const body = importRisuBody({ card, cardText, findings });
  pkg.body = body.body;
  if (body.bodyTemplate) pkg.bodyTemplate = body.bodyTemplate;
  pkg.instructions.push(...body.instructions);
  pkg.starts = importRisuGreetings({ card, cardText, findings });
  const lore = importRisuLore({ card, cardText, findings });
  pkg.lore.push(...lore.lore);
  const regex = importRisuDisplayRegex(risu.customScripts);
  pkg.transforms = regex.transforms;
  findings.append(regex.findings);
  const behavior = importRisuTriggers({ risu, findings });
  if (behavior) pkg.behavior = behavior;
  scanRisuExtensionSurfaces({ input, card, risu, findings });
  const { file, preview } = buildRisuTransfer({
    input,
    card,
    pkg,
    title,
    images: assets.images,
    lore: lore.preview,
    findings,
  });
  return { file, preview, hash: input.hash };
}

export function prepareRisuImport(
  value: unknown,
  readStaged?: (uploadId: string) => Buffer
): RisuImportPreview {
  const body = record(value);
  fields(body, ['source', 'kind']);
  return analyze(body.source, body.kind as RisuImportKind | undefined, readStaged).preview;
}

export function applyRisuImport(
  store: Store,
  value: unknown,
  readStaged?: (uploadId: string) => Buffer
): RisuImportResult {
  const body = record(value);
  fields(body, ['source', 'kind', 'digest', 'memoryIds', 'allowPartial', 'idempotencyKey']);
  const requestKey = text(body.idempotencyKey, 'request key', 100);
  const { file, preview, hash } = analyze(
    body.source,
    body.kind as RisuImportKind | undefined,
    readStaged
  );
  if (body.digest !== preview.digest) throw new HttpError(409, 'RISU_IMPORT_DRAFT_CHANGED');
  if (typeof body.allowPartial !== 'boolean') throw new HttpError(400, 'RISU_IMPORT_INVALID_FILE');
  if (preview.findings.some((item) => item.level === 'unsupported') && !body.allowPartial)
    throw new HttpError(400, 'RISU_IMPORT_PARTIAL_REQUIRED');
  if (
    !Array.isArray(body.memoryIds) ||
    (preview.kind === 'module' && body.memoryIds.length > 0) ||
    new Set(body.memoryIds).size !== body.memoryIds.length ||
    body.memoryIds.some(
      (id: unknown) =>
        typeof id !== 'string' ||
        !preview.lore.some(
          (item) => item.id === id && item.enabled && item.text.trim() && item.text.length <= 32000
        )
    )
  )
    throw new HttpError(400, 'RISU_IMPORT_MEMORY_SELECTION');
  const selected = new Set<string>(body.memoryIds);
  const memories = preview.lore.filter((item) => selected.has(item.id));
  file.contents[0].source.package!.lore = file.contents[0].source.package!.lore.filter(
    (item) => !selected.has(item.id)
  );
  const prepared = prepareNativeTransfer({ file });
  return store.transaction(() => {
    const receipt = applyNativeTransfer(store, {
      file,
      digest: prepared.digest,
      modelBindings: [],
      idempotencyKey: `risu:${requestKey}`,
    });
    if (preview.kind === 'module') return { receipt, chat: null };
    if (!receipt.created) {
      const exists = store.db.prepare('SELECT id FROM chats WHERE id=?').get(receipt.id);
      return { receipt, chat: exists ? store.chat(receipt.id) : null };
    }
    const botId = receipt.items.find((item) => item.key === 'bot')!.id;
    const chat = store.createChat(preview.title, undefined, { botId }, receipt.id);
    for (const [index, memory] of memories.entries())
      store.story.notes.write(chat.id, {
        kind: 'imported-memory',
        origin: { fileHash: hash, entryId: memory.id, title: memory.title },
        text: memory.text,
        author: '가져온 자료',
        branchId: `main:${chat.id}`,
        expectedRevision: index,
        expectedHeadRevision: null,
        idempotencyKey: `import:${memory.id}`,
      });
    return { receipt, chat };
  });
}

export function risuImportRoutes(app: FastifyInstance, store: Store) {
  const bodyLimit = Math.ceil(RISU_IMPORT_MAX_BYTES / 3) * 4 + 1024 * 1024;
  const readStaged = (uploadId: string) => readUpload(store.path, uploadId);
  app.post('/api/risu-imports/prepare', { bodyLimit }, async (request) =>
    prepareRisuImport(request.body, readStaged)
  );
  app.post('/api/risu-imports/apply', { bodyLimit }, async (request, reply) => {
    const result = applyRisuImport(store, request.body, readStaged);
    const source = record(record(request.body).source);
    // The staged file has served its purpose once the material is registered.
    if (result.receipt.created && typeof source.uploadId === 'string')
      deleteUpload(store.path, source.uploadId);
    return reply.code(result.receipt.created ? 201 : 200).send(result);
  });
}
