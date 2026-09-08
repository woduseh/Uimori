import { HttpError, fields, record, text } from './request-validation.js';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { packageImages, PACKAGE_IMAGE_MIMES } from '../core/package-images.js';
import type { Asset } from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';
import { type AssetEntry } from '../core/auxiliary.js';
import type { ProductStore } from './product-store.js';
import type { Store } from './store.js';
import { validateContentPackage, type ContentPackage } from '../core/content-package.js';

export type PackageImageBlob = {
  id: string;
  revision: 1;
  hash: string;
  mime: (typeof PACKAGE_IMAGE_MIMES)[number];
  base64: string;
};
export function decodeImage(
  mime: unknown,
  encoded: unknown
): { bytes: Buffer; mime: PackageImageBlob['mime']; hash: string } {
  if (!PACKAGE_IMAGE_MIMES.includes(mime as PackageImageBlob['mime']))
    throw new HttpError(400, 'PNG, JPEG 또는 WebP 이미지를 선택해 주세요.');
  const base64 = text(encoded, 'image bytes', 3_000_000);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(base64)) throw new HttpError(400, 'Invalid image encoding');
  const bytes = Buffer.from(base64, 'base64');
  const valid =
    mime === 'image/png'
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mime === 'image/jpeg'
        ? bytes.length >= 4 &&
          bytes[0] === 255 &&
          bytes[1] === 216 &&
          bytes.at(-2) === 255 &&
          bytes.at(-1) === 217
        : bytes.length >= 20 &&
          bytes.toString('ascii', 0, 4) === 'RIFF' &&
          bytes.toString('ascii', 8, 12) === 'WEBP' &&
          bytes.readUInt32LE(4) + 8 === bytes.length &&
          ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16));
  if (base64 !== bytes.toString('base64') || bytes.length > 2_000_000 || !valid)
    throw new HttpError(400, 'Invalid image bytes');
  return {
    bytes,
    mime: mime as PackageImageBlob['mime'],
    hash: createHash('sha256').update(bytes).digest('hex'),
  };
}
export function validateImageBlob(value: unknown): PackageImageBlob {
  const blob = record(value);
  fields(blob, ['id', 'revision', 'hash', 'mime', 'base64']);
  const image = decodeImage(blob.mime, blob.base64);
  if (blob.revision !== 1 || blob.id !== image.hash || blob.hash !== image.hash)
    throw new HttpError(400, 'Package image blob identity mismatch');
  return blob as PackageImageBlob;
}
export function putImageBlob(product: ProductStore, value: unknown): PackageImageBlob {
  const input = record(value);
  fields(input, ['mime', 'base64']);
  const image = decodeImage(input.mime, input.base64);
  const blob: PackageImageBlob = {
    id: image.hash,
    revision: 1,
    hash: image.hash,
    mime: image.mime,
    base64: input.base64,
  };
  const existing = product.db
    .prepare("SELECT body FROM versions WHERE kind='package-image' AND id=? AND revision=1")
    .get(image.hash) as { body: string } | undefined;
  if (existing) {
    if (!isDeepStrictEqual(validateImageBlob(JSON.parse(existing.body)), blob))
      throw new HttpError(409, 'Image blob collision');
    return blob;
  }
  product.db
    .prepare("INSERT INTO versions VALUES('package-image',?,1,?)")
    .run(image.hash, JSON.stringify(blob));
  return blob;
}
export function assertPackageImages(product: ProductStore, pkg: ContentPackage) {
  for (const image of pkg.images ?? []) {
    const blob = product.get<PackageImageBlob>('package-image', image.blobHash, 1);
    if (blob.hash !== image.blobHash || blob.mime !== image.mime)
      throw new HttpError(400, 'Package image reference mismatch');
  }
}
export function assetEntry(asset: Asset): AssetEntry {
  return {
    ref: asset.id,
    revision: asset.revision,
    hash: asset.hash,
    url: asset.url,
    alt: asset.title,
    caption: asset.description,
    actorId: asset.actor,
    clothing: asset.outfit,
    location: asset.location,
    uses: asset.allowedUse === 'both' ? ['profile', 'inline'] : [asset.allowedUse],
  };
}
export type ImageCatalog = { version: 1; hash: string; entries: AssetEntry[] };
export function imageJobInput(store: Store, snapshot: RunSnapshot): { imageCatalog: ImageCatalog } {
  const entries = [
    ...store.product.assets(snapshot.chatId).map(assetEntry),
    ...(snapshot.profile ? packageImages(snapshot.profile).map(assetEntry) : []),
  ];
  if (entries.length > 10_000) throw new HttpError(400, 'Image catalog limit');
  return {
    imageCatalog: {
      version: 1,
      hash: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
      entries,
    },
  };
}
/** A worker can only read the catalog fixed when the source/job was reserved. */
export function imageCatalog(input: unknown): AssetEntry[] {
  const raw = record(input);
  const catalog = record(raw.imageCatalog);
  fields(catalog, ['version', 'hash', 'entries']);
  if (
    catalog.version !== 1 ||
    !Array.isArray(catalog.entries) ||
    catalog.entries.length > 10_000 ||
    catalog.hash !== createHash('sha256').update(JSON.stringify(catalog.entries)).digest('hex')
  )
    throw new HttpError(400, 'Invalid frozen image catalog');
  if (new Set(catalog.entries.map((entry: any) => entry.ref)).size !== catalog.entries.length)
    throw new HttpError(400, 'Duplicate frozen asset reference');
  return structuredClone(catalog.entries) as AssetEntry[];
}
export function validateImageCatalog(store: Store, chatId: string, input: unknown) {
  const entries = imageCatalog(input);
  for (const entry of entries) {
    let expected: AssetEntry | undefined;
    const match = /^package:([^:]+):(bot|persona|module):([^:]+)$/u.exec(entry.ref);
    if (match) {
      const pkg = store.product.get<{ package: ContentPackage }>(
        'content',
        match[1],
        entry.revision
      ).package;
      expected = packageImages({
        chatId,
        packages: [pkg],
        packageAttachments: [
          { id: pkg.id, revision: pkg.revision, role: match[2] as 'bot' | 'persona' | 'module' },
        ],
      })
        .map(assetEntry)
        .find((item) => item.ref === entry.ref);
      assertPackageImages(store.product, pkg);
    } else {
      const asset = store.product.asset(entry.ref).asset;
      if (asset.chatId === chatId) expected = assetEntry(asset);
    }
    if (!expected || !isDeepStrictEqual(entry, expected))
      throw new HttpError(400, 'Frozen image catalog reference mismatch');
  }
}
const readerAssets = (chatId: string, entries: AssetEntry[]): Asset[] =>
  entries.map((entry) => ({
    id: entry.ref,
    chatId,
    revision: entry.revision,
    title: entry.alt,
    mime: 'image/*',
    hash: entry.hash,
    description: entry.caption,
    actor: entry.actorId ?? '',
    outfit: entry.clothing ?? '',
    location: entry.location ?? '',
    allowedUse: entry.uses.length === 2 ? 'both' : entry.uses[0],
    url: entry.url,
  }));
export function catalogReaderAssets(chatId: string, input: unknown): Asset[] {
  return readerAssets(chatId, imageCatalog(input));
}
/** Project only displayed references; a large authoring catalog never reaches the Reader. */
export function readerImageAssets(store: Store, chatId: string, sourceIds?: string[]): Asset[] {
  if (sourceIds && !sourceIds.length) return [];
  const restriction = sourceIds
    ? ` AND j.source_revision IN (${sourceIds.map(() => '?').join(',')})`
    : '';
  const rows = store.db
    .prepare(`SELECT DISTINCT asset.value AS body FROM jobs j JOIN job_results r ON r.job_id=j.id,
    json_each(j.input,'$.imageCatalog.entries') AS asset
    WHERE j.chat_id=? AND j.kind='image' AND j.status='completed' ${restriction}
    AND EXISTS(SELECT 1 FROM json_each(r.result,'$.annotations') annotation
      WHERE json_extract(annotation.value,'$.assetRef')=json_extract(asset.value,'$.ref')
      AND json_extract(annotation.value,'$.assetRevision')=json_extract(asset.value,'$.revision')
      AND json_extract(annotation.value,'$.assetHash')=json_extract(asset.value,'$.hash'))`)
    .all(chatId, ...(sourceIds ?? [])) as { body: string }[];
  const entries = rows.map((row) => JSON.parse(row.body) as AssetEntry);
  return readerAssets(chatId, entries);
}
/** A selected chat asset is already in the base list; keep one exact version. */
export function mergedReaderAssets(store: Store, chatId: string, sourceIds?: string[]): Asset[] {
  const assets = [...store.product.assets(chatId), ...readerImageAssets(store, chatId, sourceIds)];
  const unique = new Map<string, Asset>();
  for (const asset of assets) {
    const key = JSON.stringify([asset.id, asset.revision, asset.hash]);
    if (!unique.has(key)) unique.set(key, asset);
  }
  return [...unique.values()];
}
export function forkImageInput(
  input: unknown,
  assetIds: Map<string, string>
): { imageCatalog: ImageCatalog } {
  const entries = imageCatalog(input).map((entry) => {
    const id = assetIds.get(entry.ref);
    return id ? { ...entry, ref: id, url: `/api/assets/${id}` } : entry;
  });
  return {
    imageCatalog: {
      version: 1,
      hash: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
      entries,
    },
  };
}
export function requestImages(store: Store, sourceId: string, value: unknown) {
  const request = record(value);
  fields(request, ['expectedSourceHash', 'expectedRevision']);
  return store.transaction(() => {
    const source = store.source(sourceId);
    const previous = store.db
      .prepare(
        "SELECT id FROM jobs WHERE source_revision=? AND kind='image' ORDER BY revision DESC LIMIT 1"
      )
      .get(sourceId) as { id: string } | undefined;
    const job = previous ? store.job(previous.id) : undefined;
    if (
      source.hash !== request.expectedSourceHash ||
      (job?.revision ?? 0) !== request.expectedRevision
    )
      throw new HttpError(409, 'Image selection revision conflict');
    if (job && ['queued', 'running'].includes(job.status) && job.sourceHash === source.hash)
      return job;
    const snapshot = store.run(source.runId).snapshot;
    const profile = store.product.snapshot(source.chatId);
    const input = imageJobInput(store, { ...snapshot, ...(profile ? { profile } : {}) });
    const id = job?.id ?? randomUUID(),
      time = new Date().toISOString();
    if (job) {
      store.db.prepare('DELETE FROM job_results WHERE job_id=?').run(id);
      store.db
        .prepare(
          "UPDATE jobs SET source_hash=?,status='queued',generation=generation+1,revision=revision+1,owner=NULL,input=?,error=NULL,updated_at=? WHERE id=?"
        )
        .run(source.hash, JSON.stringify(input), time, id);
    } else
      store.db
        .prepare(
          "INSERT INTO jobs(id,chat_id,source_revision,source_hash,kind,status,input,created_at,updated_at) VALUES(?,?,?,?,'image','queued',?,?,?)"
        )
        .run(id, source.chatId, sourceId, source.hash, JSON.stringify(input), time, time);
    store.event(source.chatId, 'job.queued', id);
    return store.job(id);
  });
}
export function packageImageRoutes(
  app: FastifyInstance,
  store: Store,
  hooks: { publish: (id: string) => void; pump: () => void }
) {
  app.post('/api/package-image-blobs', { bodyLimit: 4 * 1024 * 1024 }, async (request) => {
    const blob = putImageBlob(store.product, request.body);
    return { hash: blob.hash, mime: blob.mime, url: `/api/package-image-blobs/${blob.hash}` };
  });
  app.get<{ Params: { hash: string } }>(
    '/api/package-image-blobs/:hash',
    async (request, reply) => {
      const blob = store.product.get<PackageImageBlob>('package-image', request.params.hash, 1);
      return reply
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'private, max-age=31536000, immutable')
        .type(blob.mime)
        .send(Buffer.from(blob.base64, 'base64'));
    }
  );
  app.post('/api/package-bundles/export', { bodyLimit: 8 * 1024 * 1024 }, async (request) => {
    const b = record(request.body);
    fields(b, ['package']);
    const pkg = validateContentPackage(b.package);
    assertPackageImages(store.product, pkg);
    return {
      format: 'uimori-package-bundle',
      version: 1,
      package: pkg,
      images: [...new Set((pkg.images ?? []).map((image) => image.blobHash))].map((hash) =>
        store.product.get('package-image', hash, 1)
      ),
    };
  });
  app.post('/api/package-bundles/prepare', { bodyLimit: 64 * 1024 * 1024 }, async (request) => {
    const b = record(request.body);
    fields(b, ['format', 'version', 'package', 'images']);
    if (
      b.format !== 'uimori-package-bundle' ||
      b.version !== 1 ||
      !Array.isArray(b.images) ||
      b.images.length > 2000
    )
      throw new HttpError(400, 'Invalid package bundle');
    const pkg = validateContentPackage(b.package),
      blobs = b.images.map(validateImageBlob);
    const hashes = new Set((pkg.images ?? []).map((image) => image.blobHash));
    if (
      blobs.length !== hashes.size ||
      new Set(blobs.map((blob) => blob.hash)).size !== blobs.length ||
      blobs.some((blob) => !hashes.has(blob.hash))
    )
      throw new HttpError(400, 'Package bundle images mismatch');
    return store.transaction(() => {
      for (const blob of blobs)
        putImageBlob(store.product, { mime: blob.mime, base64: blob.base64 });
      assertPackageImages(store.product, pkg);
      return { package: pkg };
    });
  });
  app.post<{ Params: { id: string } }>('/api/sources/:id/images', async (request) => {
    const job = requestImages(store, request.params.id, request.body);
    hooks.publish(job.chatId);
    hooks.pump();
    return job;
  });
}
