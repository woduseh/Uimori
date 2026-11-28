import { readImportReceipt, saveImportReceipt } from './import-operations.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import type { ReferenceSource } from './product-store.js';
import type { Content, PromptPreset, SavedPromptCombination } from '../core/product.js';
import {
  NATIVE_TRANSFER_FORMAT,
  NATIVE_TRANSFER_VERSION,
  type NativeTransferPrepare,
  type NativeTransferReceipt,
} from '../core/native-transfer.js';
import {
  validateNativeTransfer,
  validatePreparedNativeTransfer,
  type PreparedNativeTransferFile,
  type ValidatedPreparedNativeTransfer,
} from '../core/native-transfer-validation.js';
import { readFileSync } from 'node:fs';
import { storeImage, type StoredImage } from './image-storage.js';
import { validateImageBlob, putValidatedImageBlob } from './package-images.js';
import { HttpError } from './request-validation.js';
import { normalizeTransferImages } from './transfer-images.js';
import { assertTx, type Tx } from './tx.js';
import { AppError } from './app-errors.js';
import type { ApplyNativeTransfer, NativeTransferModelBinding } from '#contracts/operations';

type BundleCommand = Pick<ApplyNativeTransfer, 'idempotencyKey' | 'modelBindings'>;

export const bundleDigest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function prepareBundle(value: unknown) {
  const checked = validateNativeTransfer(value);
  for (const image of checked.file.images) validateImageBlob(image);
  const preview: NativeTransferPrepare = {
    digest: bundleDigest(checked.file),
    entries: checked.entries,
    modelRequirements: checked.modelRequirements,
    warnings: checked.warnings,
    summary: {
      contents: checked.file.contents.length,
      prompts: checked.file.prompts.length,
      combinations: checked.file.prompts.reduce((sum, item) => sum + item.combinations.length, 0),
      images: checked.file.images.length,
      imageBytes: checked.file.images.reduce(
        (sum, item) => sum + Buffer.byteLength(item.base64, 'base64'),
        0
      ),
    },
  };
  return { checked, preview };
}

export function inspectBundle(value: unknown): NativeTransferPrepare {
  return prepareBundle(value).preview;
}

export function captureResourceBundle(
  store: Store,
  selection: { kind: 'content' | 'prompt-preset'; id: string }[],
  roots: ReferenceSource
): PreparedNativeTransferFile {
  const file: PreparedNativeTransferFile = {
    format: NATIVE_TRANSFER_FORMAT,
    version: NATIVE_TRANSFER_VERSION,
    roots: [],
    contents: [],
    prompts: [],
    images: [],
  };
  const captured = new Map<string, string>();
  const capturing = new Set<string>();
  const capture = (id: string): string => {
    if (capturing.has(id)) throw new AppError(400, 'RESOURCE_BUNDLE_MODULE_CYCLE');
    const previous = captured.get(id);
    if (previous) return previous;
    capturing.add(id);
    const {
      coverImage: _cover,
      hasPackage: _hasPackage,
      ...source
    } = store.product.stored<Content>('content', id);
    const key = `content-${captured.size + 1}`;
    captured.set(id, key);
    const entry = { key, source: structuredClone(source), modules: [] as string[] };
    file.contents.push(entry);
    for (const module of entry.source.package.modules ?? []) {
      entry.modules.push(capture(module.id));
      const latest = file.contents.find((item) => item.key === captured.get(module.id))!.source;
      module.revision = latest.revision;
    }
    capturing.delete(id);
    return key;
  };
  for (const item of selection) {
    if (item.kind === 'content') {
      store.product.reference(roots, 'content', item.id);
      file.roots.push({ kind: item.kind, key: capture(item.id) });
    } else {
      const source = store.product.reference<PromptPreset>(roots, 'prompt-preset', item.id);
      const key = `prompt-${file.prompts.length + 1}`;
      const combinations = (
        store.product.all('prompt-combination') as SavedPromptCombination[]
      ).filter(
        (combination) => combination.owner.kind === 'preset' && combination.owner.id === item.id
      );
      file.prompts.push({ key, source, combinations });
      file.roots.push({ kind: item.kind, key });
    }
  }
  const hashes = new Set(
    file.contents.flatMap(
      (entry) => entry.source.package.images?.map((image) => image.blobHash) ?? []
    )
  );
  file.images = [...hashes].map((hash) => ({
    id: hash,
    hash,
    revision: 1,
    mime: store.db.prepare('SELECT mime FROM image_blobs WHERE hash=?').get(hash)
      ?.mime as PreparedNativeTransferFile['images'][number]['mime'],
  }));
  validatePreparedNativeTransfer(file);
  return file;
}

function prepareImport(input: ApplyNativeTransfer) {
  const bundle = prepareBundle(input.file);
  if (input.digest !== bundle.preview.digest)
    throw new AppError(409, 'NATIVE_TRANSFER_DRAFT_CHANGED');
  return bundle;
}

export function importResourceBundle(
  store: Store,
  input: ApplyNativeTransfer
): NativeTransferReceipt {
  const bundle = prepareImport(input);
  return applyPreparedBundle(store, input, bundleReceipt(input, bundle.preview.digest), bundle);
}

export async function importNormalizedResourceBundle(
  store: Store,
  input: ApplyNativeTransfer
): Promise<NativeTransferReceipt> {
  const receipt = bundleReceipt(input, bundleDigest(input.file ?? null), 'transfer:');
  const prior = readImportReceipt<NativeTransferReceipt>(store, receipt.key, receipt.digest);
  if (prior) return { ...prior, created: false };
  const bundle = prepareImport(input);
  const converted = await normalizeTransferImages(bundle.checked.file);
  return applyPreparedBundle(store, input, receipt, prepareBundle(converted));
}

type BundleReceipt = { key: string; digest: string };

function bundleReceipt(input: BundleCommand, fileDigest: string, prefix = ''): BundleReceipt {
  return {
    key: `${prefix}${input.idempotencyKey}`,
    digest: bundleDigest({ file: fileDigest, bindings: sortedBindings(input.modelBindings) }),
  };
}

export const sortedBindings = (bindings: readonly NativeTransferModelBinding[]) =>
  [...bindings].sort((a, b) =>
    a.requirementKey < b.requirementKey ? -1 : a.requirementKey > b.requirementKey ? 1 : 0
  );

function bundleBindings(
  bindings: NativeTransferModelBinding[],
  checked: ValidatedPreparedNativeTransfer
) {
  const requirements = new Set(checked.modelRequirements.map((item) => item.key));
  const mapped = new Map<string, NativeTransferModelBinding>();
  for (const binding of bindings) {
    if (!requirements.has(binding.requirementKey) || mapped.has(binding.requirementKey))
      throw new HttpError(400, 'Unknown or duplicate model binding');
    mapped.set(binding.requirementKey, binding);
  }
  return mapped;
}

function applyPreparedBundle(
  store: Store,
  input: BundleCommand,
  { key, digest: commandDigest }: BundleReceipt,
  bundle: CheckedBundle,
  putImages?: () => void
): NativeTransferReceipt {
  return store.transaction(() => {
    const prior = readImportReceipt<NativeTransferReceipt>(store, key, commandDigest);
    if (prior) return { ...prior, created: false };
    const receipt = persistBundle(store, input.modelBindings, bundle, putImages);
    saveImportReceipt(store, key, commandDigest, receipt);
    return receipt;
  });
}

type CheckedBundle = { checked: ValidatedPreparedNativeTransfer; preview: NativeTransferPrepare };

function persistBundle(
  store: Store,
  bindings: NativeTransferModelBinding[],
  { checked, preview: prepared }: CheckedBundle,
  putImages?: () => void
): NativeTransferReceipt {
  const mapped = bundleBindings(bindings, checked);
  const ids = new Map(checked.entries.map((entry) => [entry.key, randomUUID()]));
  const contentIds = new Map(
    checked.file.contents.map((entry) => [entry.source.id, ids.get(entry.key)!])
  );
  if (putImages) putImages();
  else
    for (const image of checked.file.images) {
      if (!('base64' in image) || typeof image.base64 !== 'string')
        throw new Error('Unprepared transfer image without payload');
      putValidatedImageBlob(store.product, { ...image, base64: image.base64 });
    }
  for (const key of checked.persistOrder) {
    const entry = checked.file.contents.find((item) => item.key === key)!;
    const { id: _id, revision: _revision, ...source } = structuredClone(entry.source);
    source.relatedIds = source.relatedIds.flatMap((id) =>
      contentIds.has(id) ? [contentIds.get(id)!] : []
    );
    source.package.modules = entry.modules.map((key) => ({ id: ids.get(key)!, revision: 1 }));
    store.product.content(source, undefined, true, ids.get(key)!);
  }
  for (const entry of checked.file.prompts) {
    const { id: _id, revision: _revision, ...source } = structuredClone(entry.source);
    for (const agent of source.program.collaboration?.agents ?? []) {
      const binding = mapped.get(`${entry.key}/${agent.id}`);
      agent.model = binding?.mode === 'local' ? binding.model : null;
    }
    const saved = store.product.promptPreset(source, undefined, true, ids.get(entry.key)!);
    for (const combination of entry.combinations) {
      const { id: _old, revision: _oldRevision, ...data } = combination;
      store.product.saveInTransaction('prompt-combination', {
        ...data,
        owner: { kind: 'preset', id: saved.id },
      });
    }
  }
  return {
    id: randomUUID(),
    created: true,
    digest: prepared.digest,
    importedAt: new Date().toISOString(),
    summary: prepared.summary,
    items: checked.entries.map((entry) => ({ ...entry, id: ids.get(entry.key)!, revision: 1 })),
  };
}

export type PreparedBundleImage = {
  hash: string;
  mime: 'image/webp' | 'image/png' | 'image/jpeg' | 'image/avif' | 'image/gif';
  path: string;
  bytes: number;
};

export function importPreparedResourceBundle(
  store: Store,
  file: PreparedNativeTransferFile,
  images: PreparedBundleImage[],
  command: BundleCommand
): NativeTransferReceipt {
  const bundle = prepareStagedBundle(file, images);
  return applyPreparedBundle(
    store,
    command,
    bundleReceipt(command, bundle.preview.digest),
    bundle,
    () => {
      for (const image of images) {
        if (store.db.prepare('SELECT hash FROM image_blobs WHERE hash=?').get(image.hash)) continue;
        storeImage(store.db, {
          hash: image.hash,
          mime: image.mime,
          bytes: readFileSync(image.path),
        });
      }
    }
  );
}

function prepareStagedBundle(file: PreparedNativeTransferFile, images: PreparedBundleImage[]) {
  const checked = validatePreparedNativeTransfer(file);
  const supplied = new Map(images.map((image) => [image.hash, image]));
  if (
    supplied.size !== images.length ||
    supplied.size !== checked.file.images.length ||
    checked.file.images.some((image) => supplied.get(image.hash)?.mime !== image.mime)
  )
    throw new AppError(400, 'NATIVE_TRANSFER_FILE_INVALID');
  const preview: NativeTransferPrepare = {
    digest: bundleDigest(checked.file),
    entries: checked.entries,
    modelRequirements: checked.modelRequirements,
    warnings: checked.warnings,
    summary: {
      contents: file.contents.length,
      prompts: file.prompts.length,
      combinations: file.prompts.reduce((sum, item) => sum + item.combinations.length, 0),
      images: images.length,
      imageBytes: images.reduce((sum, item) => sum + item.bytes, 0),
    },
  };
  return { checked, preview };
}

export function persistRisuBundle(
  store: Store,
  tx: Tx,
  bundle: CheckedBundle,
  images?: StoredImage[]
) {
  assertTx(tx, store.db);
  return persistBundle(
    store,
    [],
    bundle,
    images &&
      (() => {
        for (const image of images) storeImage(store.db, image);
      })
  );
}

export function prepareRisuBundle(
  store: Store,
  file: PreparedNativeTransferFile,
  stagedImages?: PreparedBundleImage[]
) {
  if (!stagedImages) return { bundle: prepareBundle(file), images: undefined };
  const bundle = prepareStagedBundle(file, stagedImages);
  const stored = store.db.prepare('SELECT bytes FROM image_blobs WHERE hash=?');
  const images = stagedImages.map(({ hash, mime, path }) => {
    const existing = stored.get(hash)?.bytes as Uint8Array | undefined;
    return {
      hash,
      mime,
      bytes: existing
        ? Buffer.from(existing.buffer, existing.byteOffset, existing.byteLength)
        : readFileSync(path),
    };
  });
  return { bundle, images };
}
