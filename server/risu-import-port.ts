import type { OperationBody } from '#contracts';
import type { risuOperations } from '#contracts/operations';
import type { Content, PromptPreset } from '../core/product.js';
import type { NativeTransferReceipt } from '../core/native-transfer.js';
import { AppError, HttpError } from './app-errors.js';
import { readCharacterCard } from './character-card-file.js';
import { createPackageStartInTransaction } from './package-start.js';
import { prepareRisuBundle, persistRisuBundle } from './resource-bundle.js';
import {
  findPreparedRisuImport,
  readPreparedRisuImport,
  deletePreparedRisuImport,
  preparedManifestIdentity,
} from './risu-import-prepared.js';
import { analyzeNativeRisuImport } from './risu-native-import.js';
import { normalizeTransferImages } from './transfer-images.js';
import type { Store } from './store.js';
import type { Tx } from './tx.js';
import { deleteUpload, readUpload } from './uploads.js';

async function prepareCard(
  store: Store,
  readStaged: (id: string) => Buffer,
  digest: string,
  {
    source,
    kind,
    preparedId,
    imageHandoffIds,
    allowPartial,
  }: OperationBody<typeof risuOperations.apply>
) {
  const staged =
    preparedId === undefined
      ? findPreparedRisuImport(store.path, digest, source)
      : readPreparedRisuImport(store.path, preparedId);
  const manifest = staged && {
    id: staged.id,
    identity: preparedManifestIdentity(store.path, staged.id),
  };
  const analyzed = staged ?? analyzeNativeRisuImport(readCharacterCard(source, kind, readStaged));
  const { preview } = analyzed;
  if (preview.digest !== digest || (kind !== undefined && kind !== preview.kind))
    throw new AppError(409, 'RISU_IMPORT_DRAFT_CHANGED');
  if (!allowPartial && preview.findings.some((item) => item.level === 'unsupported'))
    throw new AppError(400, 'RISU_IMPORT_PARTIAL_REQUIRED');
  const file = staged
    ? staged.file
    : await normalizeTransferImages(
        analyzed.file as import('../core/native-transfer.js').NativeTransferFile
      );
  if (imageHandoffIds) {
    const policy = file.contents[0].source.package!.imageHandoff;
    const selected = imageHandoffIds;
    if (selected.some((id) => !policy?.ranges.some((range) => range.id === id)))
      throw new HttpError(400, 'RISU_IMPORT_IMAGE_HANDOFF_SELECTION');
    if (policy)
      policy.ranges = policy.ranges.map((range) => ({
        ...range,
        enabled: selected.includes(range.id),
      }));
  }
  return {
    ...prepareRisuBundle(store, file, staged?.images),
    manifest,
    preview,
    uploadId: staged
      ? staged.sourceUploadId
      : source &&
          typeof source === 'object' &&
          'uploadId' in source &&
          typeof source.uploadId === 'string'
        ? source.uploadId
        : undefined,
  };
}

export function createRisuImportPort(
  store: Store,
  readStaged = (id: string) => readUpload(store.path, id)
) {
  return {
    prepareCard: (digest: string, body: OperationBody<typeof risuOperations.apply>) =>
      prepareCard(store, readStaged, digest, body),
    persistCard(
      tx: Tx,
      prepared: Awaited<ReturnType<typeof prepareCard>>,
      createChat: boolean,
      key: string
    ) {
      if (
        prepared.manifest &&
        preparedManifestIdentity(store.path, prepared.manifest.id) !== prepared.manifest.identity
      )
        throw new AppError(409, 'RISU_IMPORT_DRAFT_CHANGED');
      const receipt = persistRisuBundle(store, tx, prepared.bundle, prepared.images);
      if (!createChat || prepared.preview.kind !== 'bot') return { receipt, chat: null };
      const botId = receipt.items.find((item) => item.key === 'bot')!.id;
      const chat = store.createChatInTransaction(prepared.preview.title, { botId }, receipt.id);
      const content = store.product.stored<Content>('content', botId);
      const first =
        content.package?.nativeRisu &&
        content.package.starts?.find(
          (start) => start.id === 'start-0' && start.mode === 'authored' && start.text.trim()
        );
      if (first)
        createPackageStartInTransaction(store, chat.id, {
          packageId: content.id,
          packageRevision: content.revision,
          startId: first.id,
          expectedSettingsRevision: chat.settingsRevision,
          expectedProfileRevision: store.product.profile(chat.id).revision,
          idempotencyKey: `risu-start:${key}`,
        });
      return { receipt, chat: store.chat(chat.id) };
    },
    persistPreset(tx: Tx, bundle: ReturnType<typeof prepareRisuBundle>['bundle']) {
      return persistRisuBundle(store, tx, bundle);
    },
    preset(receipt: NativeTransferReceipt) {
      const preset = receipt.items.find(
        (item) => item.kind === 'prompt-preset' && item.key === 'prompt'
      )!;
      return store.product.stored<PromptPreset>('prompt-preset', preset.id);
    },
    chat(id?: string) {
      return id && store.db.prepare('SELECT 1 FROM chats WHERE id=?').get(id)
        ? store.chat(id)
        : null;
    },
    consume(preparedId: string | undefined, uploadId: string | undefined) {
      if (preparedId) deletePreparedRisuImport(store.path, preparedId);
      if (uploadId) {
        try {
          deleteUpload(store.path, uploadId);
        } catch {}
      }
    },
  };
}
export type RisuImportPort = ReturnType<typeof createRisuImportPort>;
