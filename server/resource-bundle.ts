import { createHash, randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import type { Content, PromptPreset, SavedPromptCombination } from '../core/product.js';
import {
  NATIVE_TRANSFER_FORMAT,
  NATIVE_TRANSFER_VERSION,
  type NativeTransferFile,
  type NativeTransferPrepare,
  type NativeTransferReceipt,
} from '../core/native-transfer.js';
import { validateNativeTransfer } from '../core/native-transfer-validation.js';
import { validateImageBlob, putValidatedImageBlob } from './package-images.js';
import { encodedImage } from './image-storage.js';
import { fields, HttpError, record, text } from './request-validation.js';

export const bundleDigest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function inspectBundle(value: unknown): NativeTransferPrepare {
  const checked = validateNativeTransfer(value);
  for (const image of checked.file.images) validateImageBlob(image);
  return {
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
}

/** A saved-resource bundle, not a dump of database tables or old execution records. */
export function exportResourceBundle(
  store: Store,
  selection: { kind: 'content' | 'prompt-preset'; id: string }[]
): NativeTransferFile {
  const file: NativeTransferFile = {
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
    if (capturing.has(id)) throw new HttpError(400, '모듈 연결에 순환이 있어요.');
    const previous = captured.get(id);
    if (previous) return previous;
    capturing.add(id);
    const {
      coverImage: _cover,
      hasPackage: _hasPackage,
      ...source
    } = store.product.get<Content>('content', id);
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
    store.product.assertAvailable(item.kind, item.id);
    if (item.kind === 'content') file.roots.push({ kind: item.kind, key: capture(item.id) });
    else {
      const source = store.product.get<PromptPreset>('prompt-preset', item.id);
      const key = `prompt-${file.prompts.length + 1}`;
      const combinations = (
        store.product.all('prompt-combination') as SavedPromptCombination[]
      ).filter(
        (combination) => combination.owner?.kind === 'preset' && combination.owner.id === item.id
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
  file.images = [...hashes].map((hash) => encodedImage(store.db, hash));
  inspectBundle(file);
  return file;
}

/** New identities on every intentional import; a tiny request receipt only prevents a lost HTTP response duplicating it. */
export function importResourceBundle(store: Store, value: unknown): NativeTransferReceipt {
  const body = record(value);
  fields(body, ['file', 'digest', 'modelBindings', 'idempotencyKey']);
  const checked = validateNativeTransfer(body.file);
  const prepared = inspectBundle(checked.file);
  if (body.digest !== prepared.digest)
    throw new HttpError(409, '가져올 자료가 변경됐어요. 다시 확인해 주세요.');
  const supplied = body.modelBindings ?? [];
  if (!Array.isArray(supplied)) throw new HttpError(400, '모델 연결 목록을 확인해 주세요.');
  const requirements = new Set(checked.modelRequirements.map((item) => item.key));
  const mapped = new Map<
    string,
    { requirementKey: string; mode: 'local' | 'inherit-main'; model?: { id: string } }
  >();
  for (const value of supplied) {
    const binding = record(value);
    fields(binding, ['requirementKey', 'mode', 'model']);
    const requirementKey = text(binding.requirementKey, 'model requirement', 300);
    if (!requirements.has(requirementKey) || mapped.has(requirementKey))
      throw new HttpError(400, '잘못되거나 중복된 모델 연결이에요.');
    if (binding.mode === 'inherit-main')
      mapped.set(requirementKey, { requirementKey, mode: 'inherit-main' });
    else if (binding.mode === 'local')
      mapped.set(requirementKey, {
        requirementKey,
        mode: 'local',
        model: { id: text(record(binding.model).id, 'model ID', 100) },
      });
    else throw new HttpError(400, '모델 연결 방식을 확인해 주세요.');
  }
  const bindings = [...requirements]
    .sort()
    .map(
      (requirementKey) =>
        mapped.get(requirementKey) ?? { requirementKey, mode: 'inherit-main' as const }
    );
  const commandDigest = bundleDigest({ file: prepared.digest, bindings });
  const key = text(body.idempotencyKey, 'import request', 200);
  return store.transaction(() => {
    const prior = store.db
      .prepare('SELECT digest,result FROM import_operations WHERE key=?')
      .get(key);
    if (prior) {
      if (prior.digest !== commandDigest)
        throw new HttpError(409, '다른 가져오기 요청에 같은 ID가 사용됐어요.');
      return { ...JSON.parse(String(prior.result)), created: false };
    }
    const ids = new Map(checked.entries.map((entry) => [entry.key, randomUUID()]));
    const contentIds = new Map(
      checked.file.contents.map((entry) => [entry.source.id, ids.get(entry.key)!])
    );
    for (const image of checked.file.images)
      putValidatedImageBlob(store.product, validateImageBlob(image));
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
        agent.model = binding?.mode === 'local' ? binding.model! : null;
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
    const receipt: NativeTransferReceipt = {
      id: randomUUID(),
      created: true,
      digest: prepared.digest,
      importedAt: new Date().toISOString(),
      summary: prepared.summary,
      items: checked.entries.map((entry) => ({ ...entry, id: ids.get(entry.key)!, revision: 1 })),
    };
    store.db
      .prepare('INSERT INTO import_operations VALUES(?,?,?)')
      .run(key, commandDigest, JSON.stringify(receipt));
    store.db
      .prepare(
        'DELETE FROM import_operations WHERE rowid NOT IN (SELECT rowid FROM import_operations ORDER BY rowid DESC LIMIT 256)'
      )
      .run();
    return receipt;
  });
}
