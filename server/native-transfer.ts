import { projectNativeRisuPackage } from './risu-native-projection.js';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { FastifyInstance } from 'fastify';
import {
  NATIVE_TRANSFER_FORMAT,
  NATIVE_TRANSFER_VERSION,
  NATIVE_TRANSFER_MAX_BYTES,
  type NativeTransferContent,
  type NativeTransferFile,
  type NativeTransferModelBinding,
  type NativeTransferOrigin,
  type NativeTransferPrepare,
  type NativeTransferReceipt,
} from '../core/native-transfer.js';
import { validateNativeTransfer } from '../core/native-transfer-validation.js';
import { resolveEditablePromptValues } from '../core/risu-prompt.js';
import type { Content, PromptPreset, SavedPromptCombination } from '../core/product.js';
import { resolvePackageGraph } from '../core/package-graph.js';
import {
  putValidatedImageBlob,
  validateImageBlob,
  type PackageImageBlob,
} from './package-images.js';
import { assertModelSelection } from './provider-selection.js';
import { fields, HttpError, record, text } from './request-validation.js';
import type { Store } from './store.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
type OriginalIndex = {
  version: 1;
  roots: NativeTransferFile['roots'];
  contents: {
    key: string;
    id: string;
    source: Pick<Content, 'id' | 'revision' | 'relatedIds'> & {
      packageModules?: NonNullable<Content['package']>['modules'] | null;
    };
    origin?: NativeTransferOrigin;
  }[];
  prompts: {
    key: string;
    id: string;
    source: Pick<PromptPreset, 'id' | 'revision' | 'values'>;
    models: { agentId: string; model: { id: string } }[];
    combinations: { id: string; source: { id: string; revision: number } }[];
    origin?: NativeTransferOrigin;
  }[];
  images: string[];
  sourceFiles?: NativeTransferFile['sourceFiles'];
  modelBindings: NativeTransferModelBinding[];
};

function originalIndex(
  file: NativeTransferFile,
  ids: Map<string, string>,
  combinationIds: Map<string, string>,
  modelBindings: NativeTransferModelBinding[]
): OriginalIndex {
  return {
    version: 1,
    roots: file.roots,
    contents: file.contents.map((entry) => ({
      key: entry.key,
      id: ids.get(entry.key)!,
      source: {
        id: entry.source.id,
        revision: entry.source.revision,
        relatedIds: entry.source.relatedIds,
        packageModules: entry.source.package.modules ?? null,
      },
      ...(entry.origin ? { origin: entry.origin } : {}),
    })),
    prompts: file.prompts.map((entry) => ({
      key: entry.key,
      id: ids.get(entry.key)!,
      source: {
        id: entry.source.id,
        revision: entry.source.revision,
        ...(entry.source.values !== undefined ? { values: entry.source.values } : {}),
      },
      models: (entry.source.program.collaboration?.agents ?? []).flatMap((agent) =>
        agent.model ? [{ agentId: agent.id, model: agent.model }] : []
      ),
      combinations: entry.combinations.map((item) => ({
        id: combinationIds.get(item.id)!,
        source: { id: item.id, revision: item.revision },
      })),
      ...(entry.origin ? { origin: entry.origin } : {}),
    })),
    images: file.images.map((image) => image.hash),
    ...(file.sourceFiles !== undefined ? { sourceFiles: structuredClone(file.sourceFiles) } : {}),
    modelBindings,
  };
}

/** Rebuild definitions from immutable first revisions; opaque attachments stay in the receipt. */
function reconstructOriginal(store: Store, index: OriginalIndex): NativeTransferFile {
  if (
    index.version !== 1 ||
    !Array.isArray(index.contents) ||
    !Array.isArray(index.prompts) ||
    !Array.isArray(index.images)
  )
    throw new HttpError(400, 'NATIVE_TRANSFER_ORIGIN_INVALID');
  const keysByNewId = new Map(index.contents.map((entry) => [entry.id, entry.key]));
  return {
    format: NATIVE_TRANSFER_FORMAT,
    version: NATIVE_TRANSFER_VERSION,
    roots: index.roots,
    contents: index.contents.map((entry) => {
      const source = sourceContent(store.product.get<Content>('content', entry.id, 1));
      const modules = (source.package.modules ?? []).map((ref) => keysByNewId.get(ref.id)!);
      Object.assign(source, {
        id: entry.source.id,
        revision: entry.source.revision,
        relatedIds: entry.source.relatedIds,
      });
      source.package.id = source.id;
      source.package.revision = source.revision;
      if (entry.source.packageModules === null) delete source.package.modules;
      else source.package.modules = entry.source.packageModules;
      return { key: entry.key, source, modules, ...(entry.origin ? { origin: entry.origin } : {}) };
    }),
    prompts: index.prompts.map((entry) => {
      const source = structuredClone(store.product.get<PromptPreset>('prompt-preset', entry.id, 1));
      source.id = entry.source.id;
      source.revision = entry.source.revision;
      if (entry.source.values === undefined) delete source.values;
      else source.values = entry.source.values;
      for (const model of entry.models) {
        const agent = source.program.collaboration?.agents.find(
          (agent) => agent.id === model.agentId
        );
        if (!agent) throw new HttpError(400, 'NATIVE_TRANSFER_ORIGIN_INVALID');
        agent.model = model.model;
      }
      return {
        key: entry.key,
        source,
        combinations: entry.combinations.map((combination) => ({
          ...structuredClone(
            store.product.get<SavedPromptCombination>('prompt-combination', combination.id, 1)
          ),
          ...combination.source,
          owner: { kind: 'preset' as const, id: source.id },
        })),
        ...(entry.origin ? { origin: entry.origin } : {}),
      };
    }),
    images: index.images.map((hash) =>
      store.product.get<PackageImageBlob>('package-image', hash, 1)
    ),
    ...(index.sourceFiles !== undefined ? { sourceFiles: structuredClone(index.sourceFiles) } : {}),
  };
}
function checkedFile(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > NATIVE_TRANSFER_MAX_BYTES)
    throw new HttpError(413, 'NATIVE_TRANSFER_TOO_LARGE');
  const checked = validateNativeTransfer(value);
  for (const entry of checked.file.contents) {
    const projected = projectNativeRisuPackage(entry.source.package, entry.source.kind).pkg;
    if (!isDeepStrictEqual(projected, entry.source.package))
      throw new HttpError(400, 'NATIVE_TRANSFER_CONTENT_PROJECTION');
  }
  for (const image of checked.file.images) validateImageBlob(image);
  for (const source of checked.file.sourceFiles ?? []) {
    const bytes = Buffer.from(source.base64, 'base64');
    if (
      bytes.toString('base64') !== source.base64 ||
      createHash('sha256').update(bytes).digest('hex') !== source.hash
    )
      throw new HttpError(400, 'NATIVE_TRANSFER_SOURCE_FILE_HASH');
  }
  const summary = {
    contents: checked.file.contents.length,
    prompts: checked.file.prompts.length,
    combinations: checked.file.prompts.reduce((count, item) => count + item.combinations.length, 0),
    images: checked.file.images.length,
    imageBytes: checked.file.images.reduce(
      (bytes, image) => bytes + Buffer.byteLength(image.base64, 'base64'),
      0
    ),
    ...(checked.file.sourceFiles !== undefined
      ? {
          sourceFiles: checked.file.sourceFiles.length,
          sourceFileBytes: checked.file.sourceFiles.reduce(
            (bytes, item) => bytes + Buffer.byteLength(item.base64, 'base64'),
            0
          ),
        }
      : {}),
  };
  return { ...checked, digest: digest(checked.file), summary };
}

/** No Store parameter: preparation cannot initialize dependencies or image blobs. */
export function prepareNativeTransfer(value: unknown): NativeTransferPrepare {
  const body = record(value);
  fields(body, ['file']);
  const checked = checkedFile(body.file);
  return {
    digest: checked.digest,
    summary: checked.summary,
    entries: checked.entries,
    modelRequirements: checked.modelRequirements,
    warnings: checked.warnings,
  };
}

function sourceContent(value: Content): NativeTransferContent['source'] {
  const { coverImage: _cover, hasPackage: _hasPackage, ...source } = value;
  return structuredClone(source);
}
type ImportedOrigin = { origin: NativeTransferOrigin; receiptId: string };
function importedOrigins(store: Store): Map<string, ImportedOrigin> {
  const found = new Map<string, ImportedOrigin>();
  for (const row of store.db
    .prepare(
      "SELECT id,body,json_remove(original,'$.sourceFiles') AS original FROM native_transfer_receipts ORDER BY rowid"
    )
    .all()) {
    const receipt = JSON.parse(String(row.body)) as NativeTransferReceipt;
    const original = JSON.parse(String(row.original)) as OriginalIndex;
    for (const item of receipt.items) {
      const source = (item.kind === 'content' ? original.contents : original.prompts).find(
        (entry) => entry.key === item.key
      )!.source;
      found.set(`${item.kind}:${item.id}`, {
        receiptId: String(row.id),
        origin: {
          format: NATIVE_TRANSFER_FORMAT,
          digest: receipt.digest,
          entryKey: item.key,
          sourceId: source.id,
          sourceRevision: source.revision,
        },
      });
    }
  }
  return found;
}

/** Export saved entries and the exact effective module closure without changing source definitions. */
export function exportNativeTransfer(store: Store, value: unknown): NativeTransferFile {
  const body = record(value);
  fields(body, ['items']);
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 1000)
    throw new HttpError(400, 'NATIVE_TRANSFER_SELECTION');
  const selection = body.items.map((value) => {
    const item = record(value);
    fields(item, ['kind', 'id']);
    if (!['content', 'prompt-preset'].includes(item.kind))
      throw new HttpError(400, 'NATIVE_TRANSFER_SELECTION');
    return {
      kind: item.kind as 'content' | 'prompt-preset',
      id: text(item.id, 'library item', 100),
    };
  });
  if (new Set(selection.map((item) => `${item.kind}:${item.id}`)).size !== selection.length)
    throw new HttpError(400, 'NATIVE_TRANSFER_DUPLICATE_SELECTION');
  // No asynchronous work occurs while holding this coherent library read boundary.
  return store.transaction(() => {
    const origins = importedOrigins(store);
    const file: NativeTransferFile = {
      format: NATIVE_TRANSFER_FORMAT,
      version: NATIVE_TRANSFER_VERSION,
      roots: [],
      contents: [],
      prompts: [],
      images: [],
    };
    let bytes = Buffer.byteLength(JSON.stringify(file));
    const checkBytes = (additional: number) => {
      if (bytes + additional > NATIVE_TRANSFER_MAX_BYTES)
        throw new HttpError(413, 'NATIVE_TRANSFER_TOO_LARGE');
    };
    const append = <T>(items: T[], item: T) => {
      const additional = Buffer.byteLength(JSON.stringify(item)) + (items.length ? 1 : 0);
      checkBytes(additional);
      bytes += additional;
      items.push(item);
    };
    const attachSourceFiles = (provenance: ImportedOrigin, entryKey: string) => {
      const rows = store.db
        .prepare(
          "SELECT f.key,length(CAST(f.value AS BLOB)) AS bytes FROM native_transfer_receipts r,json_each(r.original,'$.sourceFiles') f WHERE r.id=? AND json_extract(f.value,'$.entryKey')=?"
        )
        .all(provenance.receiptId, provenance.origin.entryKey);
      for (const row of rows) {
        checkBytes(Number(row.bytes) + entryKey.length + 20);
        const original = store.db
          .prepare(
            "SELECT f.value FROM native_transfer_receipts r,json_each(r.original,'$.sourceFiles') f WHERE r.id=? AND f.key=?"
          )
          .get(provenance.receiptId, row.key)!;
        if (!file.sourceFiles) {
          checkBytes(17);
          bytes += 17;
          file.sourceFiles = [];
        }
        append(file.sourceFiles, { ...JSON.parse(String(original.value)), entryKey });
      }
    };
    // Read byte length in SQLite before materializing another body. Each accepted entry is
    // charged once, so a large selection cannot accumulate unbounded JSON before final validation.
    const readBounded = <T>(kind: string, id: string, revision?: number): T => {
      const row = store.db
        .prepare(
          'SELECT length(CAST(body AS BLOB)) AS bytes FROM versions WHERE kind=? AND id=? AND (? IS NULL OR revision=?) ORDER BY revision DESC LIMIT 1'
        )
        .get(kind, id, revision ?? null, revision ?? null);
      if (!row) throw new HttpError(404, 'Library revision not found');
      checkBytes(Number(row.bytes));
      return store.product.get<T>(kind, id, revision);
    };
    const contentKeys = new Map<string, string>();
    const addContent = (source: Content): string => {
      const prior = contentKeys.get(source.id);
      if (prior) {
        if (file.contents.find((entry) => entry.key === prior)!.source.revision !== source.revision)
          throw new HttpError(409, 'NATIVE_TRANSFER_SOURCE_CHANGED');
        return prior;
      }
      const key = `content-${file.contents.length + 1}`;
      contentKeys.set(source.id, key);
      const provenance = origins.get(`content:${source.id}`);
      const origin = provenance?.origin;
      append(file.contents, {
        key,
        source: sourceContent(source),
        modules: [],
        ...(origin ? { origin } : {}),
      });
      if (provenance) attachSourceFiles(provenance, key);
      return key;
    };
    const captureContent = (id: string, revision?: number): NativeTransferContent => {
      const prior = contentKeys.get(id);
      if (prior) {
        const entry = file.contents.find((entry) => entry.key === prior)!;
        if (revision !== undefined && entry.source.revision !== revision)
          throw new HttpError(409, 'NATIVE_TRANSFER_SOURCE_CHANGED');
        return entry;
      }
      const source = readBounded<Content>('content', id, revision);
      const key = addContent(source);
      return file.contents.find((entry) => entry.key === key)!;
    };
    for (const selected of selection) {
      store.product.assertAvailable(selected.kind, selected.id);
      if (selected.kind === 'prompt-preset') {
        const source = readBounded<PromptPreset>('prompt-preset', selected.id);
        const key = `prompt-${file.prompts.length + 1}`;
        const provenance = origins.get(`prompt-preset:${source.id}`);
        const origin = provenance?.origin;
        const entry: NativeTransferFile['prompts'][number] = {
          key,
          source: structuredClone(source),
          combinations: [],
          ...(origin ? { origin } : {}),
        };
        append(file.prompts, entry);
        if (provenance) attachSourceFiles(provenance, key);
        for (const row of store.db
          .prepare(
            "SELECT id,revision FROM versions v WHERE kind='prompt-combination' AND revision=(SELECT MAX(revision) FROM versions n WHERE n.kind=v.kind AND n.id=v.id) AND json_extract(body,'$.owner.kind')='preset' AND json_extract(body,'$.owner.id')=? AND NOT EXISTS(SELECT 1 FROM library_hidden h WHERE h.kind=v.kind AND h.id=v.id) ORDER BY id"
          )
          .all(source.id))
          append(
            entry.combinations,
            readBounded<SavedPromptCombination>(
              'prompt-combination',
              String(row.id),
              Number(row.revision)
            )
          );
        append(file.roots, { kind: 'prompt-preset', key });
      } else {
        const entry = captureContent(selected.id),
          source = entry.source,
          key = entry.key;
        append(file.roots, { kind: 'content', key });
        {
          resolvePackageGraph(
            {
              latestRevision: (id) =>
                Number(
                  store.db
                    .prepare(
                      "SELECT MAX(revision) AS revision FROM versions WHERE kind='content' AND id=?"
                    )
                    .get(id)!.revision
                ),
              read: (ref) => {
                const pkg = captureContent(ref.id, ref.revision).source.package;
                return pkg;
              },
            },
            [{ id: source.id, revision: source.revision, role: source.kind }],
            { latest: true }
          );
        }
      }
    }
    for (const entry of file.contents) {
      entry.modules = (entry.source.package.modules ?? []).map((ref) => {
        const key = contentKeys.get(ref.id);
        if (!key) throw new HttpError(400, 'NATIVE_TRANSFER_MISSING_MODULE');
        return key;
      });
      const additional = Buffer.byteLength(JSON.stringify(entry.modules)) - 2;
      checkBytes(additional);
      bytes += additional;
    }
    const hashes = new Set(
      file.contents.flatMap(
        (entry) => entry.source.package.images?.map((image) => image.blobHash) ?? []
      )
    );
    for (const hash of hashes)
      append(file.images, readBounded<PackageImageBlob>('package-image', hash, 1));
    return checkedFile(file).file;
  });
}

function bindingsFor(
  value: unknown,
  requirements: NativeTransferPrepare['modelRequirements']
): NativeTransferModelBinding[] {
  if (!Array.isArray(value) || value.length !== requirements.length)
    throw new HttpError(400, 'NATIVE_TRANSFER_MODEL_BINDINGS_REQUIRED');
  const bindings = new Map<string, NativeTransferModelBinding>();
  for (const raw of value) {
    const item = record(raw);
    fields(
      item,
      item.mode === 'local' ? ['requirementKey', 'mode', 'model'] : ['requirementKey', 'mode']
    );
    const key = text(item.requirementKey, 'requirement', 200);
    if (bindings.has(key) || !requirements.some((required) => required.key === key))
      throw new HttpError(400, 'NATIVE_TRANSFER_MODEL_BINDINGS_REQUIRED');
    if (item.mode === 'local') {
      const model = record(item.model);
      fields(model, ['id']);
      bindings.set(key, {
        requirementKey: key,
        mode: 'local',
        model: { id: text(model.id, 'model', 100) },
      });
    } else if (item.mode === 'inherit-main')
      bindings.set(key, { requirementKey: key, mode: 'inherit-main' });
    else throw new HttpError(400, 'NATIVE_TRANSFER_MODEL_BINDINGS_REQUIRED');
  }
  return requirements.map((item) => bindings.get(item.key)!);
}
function priorImport(
  store: Store,
  key: string,
  commandDigest: string
): NativeTransferReceipt | undefined {
  const row = store.db
    .prepare('SELECT digest,body FROM native_transfer_receipts WHERE request_key=?')
    .get(key);
  if (!row) return;
  if (row.digest !== commandDigest) throw new HttpError(409, 'NATIVE_TRANSFER_IMPORT_CONFLICT');
  return { ...JSON.parse(String(row.body)), created: false };
}

/** Pure validation precedes one bounded, synchronous and all-or-nothing registration. */
export function applyNativeTransfer(store: Store, value: unknown): NativeTransferReceipt {
  const body = record(value);
  fields(body, ['file', 'digest', 'modelBindings', 'idempotencyKey']);
  const requestKey = text(body.idempotencyKey, 'request key', 120);
  const checked = checkedFile(body.file);
  if (body.digest !== checked.digest) throw new HttpError(409, 'NATIVE_TRANSFER_DRAFT_CHANGED');
  const bindings = bindingsFor(body.modelBindings, checked.modelRequirements);
  const commandDigest = digest({ file: checked.digest, bindings });
  const prior = priorImport(store, requestKey, commandDigest);
  if (prior) return prior;
  const ids = new Map(checked.entries.map((entry) => [entry.key, randomUUID()]));
  const combinationIds = new Map(
    checked.file.prompts.flatMap((entry) =>
      entry.combinations.map((item) => [item.id, randomUUID()] as const)
    )
  );
  const bySourceId = new Map(
    checked.file.contents.map((entry) => [entry.source.id, ids.get(entry.key)!])
  );
  return store.transaction(() => {
    const duplicate = priorImport(store, requestKey, commandDigest);
    if (duplicate) return duplicate;
    for (const binding of bindings)
      if (binding.mode === 'local') assertModelSelection(store.product, binding.model);
    for (const image of checked.file.images) putValidatedImageBlob(store.product, image);
    for (const key of checked.persistOrder) {
      const entry = checked.file.contents.find((entry) => entry.key === key)!;
      const { id: _id, revision: _revision, ...source } = entry.source;
      const pkg = checked.packages.get(key);
      store.product.content(
        {
          ...source,
          relatedIds: source.relatedIds.flatMap((id) =>
            bySourceId.has(id) ? [bySourceId.get(id)!] : []
          ),
          ...(pkg
            ? {
                package: {
                  ...pkg,
                  ...(pkg.modules !== undefined
                    ? { modules: entry.modules.map((key) => ({ id: ids.get(key)!, revision: 1 })) }
                    : {}),
                },
              }
            : {}),
        },
        undefined,
        true,
        ids.get(key)!
      );
    }
    for (const entry of checked.file.prompts) {
      const { id: _id, revision: _revision, ...source } = structuredClone(entry.source);
      for (const agent of source.program.collaboration?.agents ?? []) {
        if (!agent.model) continue;
        const binding = bindings.find(
          (item) => item.requirementKey === `${entry.key}/${agent.id}`
        )!;
        agent.model = binding.mode === 'local' ? binding.model : null;
      }
      const saved = store.product.promptPreset(source, undefined, true, ids.get(entry.key)!);
      for (const combination of entry.combinations) {
        const { id: _combinationId, revision: _combinationRevision, ...item } = combination;
        store.product.saveInTransaction(
          'prompt-combination',
          { ...item, owner: { kind: 'preset', id: saved.id } },
          undefined,
          undefined,
          combinationIds.get(combination.id)
        );
      }
    }
    const receipt: NativeTransferReceipt = {
      id: randomUUID(),
      created: true,
      digest: checked.digest,
      importedAt: new Date().toISOString(),
      summary: checked.summary,
      items: checked.entries.map((entry) => ({ ...entry, id: ids.get(entry.key)!, revision: 1 })),
    };
    // Authored bodies/ASTs/images live once in immutable versions. Only remapped metadata is copied.
    const original = originalIndex(checked.file, ids, combinationIds, bindings);
    store.db
      .prepare('INSERT INTO native_transfer_receipts VALUES(?,?,?,?,?,?)')
      .run(
        receipt.id,
        requestKey,
        commandDigest,
        JSON.stringify(receipt),
        JSON.stringify(original),
        receipt.importedAt
      );
    return receipt;
  });
}

export function nativeTransferOriginal(store: Store, id: string): NativeTransferFile {
  const row = store.db.prepare('SELECT original FROM native_transfer_receipts WHERE id=?').get(id);
  if (!row) throw new HttpError(404, 'NATIVE_TRANSFER_RECEIPT_NOT_FOUND');
  return checkedFile(reconstructOriginal(store, JSON.parse(String(row.original)))).file;
}

/** Portable receipt verification binds origin reconstruction to the created immutable revisions. */
export function validateNativeTransferArchive(store: Store): void {
  const createdIds = new Set<string>();
  for (const row of store.db.prepare('SELECT * FROM native_transfer_receipts').all()) {
    text(row.id, 'transfer receipt', 100);
    const receipt = record(JSON.parse(String(row.body))) as NativeTransferReceipt;
    const index = JSON.parse(String(row.original)) as OriginalIndex;
    const checked = checkedFile(reconstructOriginal(store, index));
    const bindings = bindingsFor(index.modelBindings, checked.modelRequirements);
    const ids = new Map(
      [...index.contents, ...index.prompts].map((entry) => [entry.key, entry.id])
    );
    const comboIds = new Map(
      index.prompts.flatMap((entry) =>
        entry.combinations.map((item) => [item.source.id, item.id] as const)
      )
    );
    for (const id of [...ids.values(), ...comboIds.values()]) {
      if (createdIds.has(id)) throw new HttpError(400, 'NATIVE_TRANSFER_REUSED_IDENTITY');
      createdIds.add(id);
    }
    if (
      new Set([...ids.values(), ...comboIds.values()]).size !== ids.size + comboIds.size ||
      !isDeepStrictEqual(index, originalIndex(checked.file, ids, comboIds, bindings)) ||
      !isDeepStrictEqual(receipt, {
        id: row.id,
        created: true,
        digest: checked.digest,
        importedAt: row.created_at,
        summary: checked.summary,
        items: checked.entries.map((entry) => ({ ...entry, id: ids.get(entry.key)!, revision: 1 })),
      }) ||
      row.digest !== digest({ file: checked.digest, bindings }) ||
      typeof row.request_key !== 'string' ||
      !row.request_key.trim() ||
      row.request_key.length > 120 ||
      typeof row.created_at !== 'string' ||
      !Number.isFinite(Date.parse(row.created_at)) ||
      new Date(row.created_at).toISOString() !== row.created_at
    )
      throw new HttpError(400, 'NATIVE_TRANSFER_ORIGIN_INVALID');
    const contentIds = new Map(
      checked.file.contents.map((entry) => [entry.source.id, ids.get(entry.key)!])
    );
    for (const entry of checked.file.contents) {
      const expected = structuredClone(entry.source);
      expected.id = ids.get(entry.key)!;
      expected.revision = 1;
      expected.relatedIds = expected.relatedIds.flatMap((id) =>
        contentIds.has(id) ? [contentIds.get(id)!] : []
      );
      if (expected.package) {
        expected.package.id = expected.id;
        expected.package.revision = 1;
        if (expected.package.modules !== undefined)
          expected.package.modules = entry.modules.map((key) => ({
            id: ids.get(key)!,
            revision: 1,
          }));
      }
      if (!isDeepStrictEqual(store.product.get('content', expected.id, 1), expected))
        throw new HttpError(400, 'NATIVE_TRANSFER_DESTINATION_MISMATCH');
    }
    for (const entry of checked.file.prompts) {
      const expected = structuredClone(entry.source);
      expected.id = ids.get(entry.key)!;
      expected.revision = 1;
      expected.values = resolveEditablePromptValues(expected.program, expected.values ?? {});
      for (const agent of expected.program.collaboration?.agents ?? [])
        if (agent.model) {
          const binding = bindings.find(
            (item) => item.requirementKey === `${entry.key}/${agent.id}`
          )!;
          agent.model = binding.mode === 'local' ? binding.model : null;
        }
      if (!isDeepStrictEqual(store.product.get('prompt-preset', expected.id, 1), expected))
        throw new HttpError(400, 'NATIVE_TRANSFER_DESTINATION_MISMATCH');
      for (const item of entry.combinations)
        if (
          !isDeepStrictEqual(store.product.get('prompt-combination', comboIds.get(item.id)!, 1), {
            ...item,
            id: comboIds.get(item.id),
            revision: 1,
            owner: { kind: 'preset', id: expected.id },
          })
        )
          throw new HttpError(400, 'NATIVE_TRANSFER_DESTINATION_MISMATCH');
    }
  }
}

export function nativeTransferRoutes(app: FastifyInstance, store: Store) {
  app.post('/api/native-transfers/export', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return exportNativeTransfer(store, request.body);
  });
  app.post(
    '/api/native-transfers/prepare',
    { bodyLimit: NATIVE_TRANSFER_MAX_BYTES + 1024 },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return prepareNativeTransfer(request.body);
    }
  );
  app.post(
    '/api/native-transfers/apply',
    { bodyLimit: NATIVE_TRANSFER_MAX_BYTES + 1024 * 1024 },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return applyNativeTransfer(store, request.body);
    }
  );
  app.get<{ Params: { id: string } }>(
    '/api/native-transfers/:id/original',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return nativeTransferOriginal(store, text(request.params.id, 'receipt', 100));
    }
  );
}
