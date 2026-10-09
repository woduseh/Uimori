import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import type { Content, PromptPreset } from '../core/product.js';
import type { PackageImage } from '../core/package-images.js';
import { validateRisuContentSource } from '../core/risu-native.js';
import { validateNativeRisuPreset } from '../core/risu-native-preset.js';
import {
  stripDeprecatedRisuCardFields,
  stripDeprecatedRisuModuleFields,
  stripDeprecatedRisuPresetFields,
} from '../core/risu-deprecated-fields.js';
import {
  RISU_IMPORT_MAX_ASSETS,
  RISU_IMPORT_MAX_UPLOAD_BYTES,
  risuImportExpandedLimit,
} from '../core/risu-import.js';
import type { ProductStore } from './product-store.js';
import type { Store } from './store.js';
import { assertLibraryVisible } from './library-deletion.js';
import { readImage } from './image-storage.js';
import { HttpError } from './request-validation.js';
import { bundleRisuModules } from './risu-export-modules.js';
import {
  assertExportPath,
  exportJson,
  exportLimit,
  writeEmbeddedRisuModule,
  writeRisuPreset,
  writeRisuZip,
} from './risu-export-codec.js';

const extension = (image: PackageImage) =>
  image.mime === 'image/jpeg' ? 'jpg' : image.mime.slice(6);
const failAsset = (): never => {
  throw new HttpError(409, 'RISU_EXPORT_ASSET_UNAVAILABLE');
};
export type RisuExport = { bytes: Buffer; filename: string; mediaType: string; revision: number };
function filename(title: string, suffix: string) {
  return `${
    Array.from(
      Buffer.from(title)
        .toString('utf8')
        .replace(/[\\/:*?"<>|\p{Cc}]/gu, '_')
        .trim()
    )
      .slice(0, 120)
      .join('') || 'uimori'
  }.${suffix}`;
}

/** Serialize the edited native source and the current image blobs, never the import receipt. */
export function exportRisuContent(product: ProductStore, content: Content): RisuExport {
  const standalone =
    content.kind === 'module' && !Object.keys(content.package.nativeRisu.card).length;
  if (standalone && !content.package.nativeRisu.module)
    throw new HttpError(409, 'RISU_EXPORT_MODULE_UNSUPPORTED');
  if (standalone && content.package.modules?.length)
    throw new HttpError(409, 'RISU_EXPORT_MODULE_CONFLICT');
  const pkg = bundleRisuModules(product, content).package;
  if (!standalone && !Object.keys(pkg.nativeRisu.card).length)
    throw new HttpError(409, 'RISU_EXPORT_MODULE_UNSUPPORTED');
  const native = validateRisuContentSource(pkg.nativeRisu),
    card = native.card;
  stripDeprecatedRisuCardFields(card);
  const files = new Map<string, Buffer>(),
    consumed = new Set<string>();
  let total = 0;
  const blobs = new Map<string, Buffer>();
  const imagesById = new Map(pkg.images?.map((image) => [image.id, image]));
  const nativeByUri = new Map<string, (typeof native.assets)[number]>();
  const nativeByUriName = new Map<string, Map<string, (typeof native.assets)[number]>>();
  const moduleByName = new Map<string, typeof native.assets>();
  for (const asset of native.assets) {
    if (!nativeByUri.has(asset.uri)) nativeByUri.set(asset.uri, asset);
    let names = nativeByUriName.get(asset.uri);
    if (!names) nativeByUriName.set(asset.uri, (names = new Map()));
    if (!names.has(asset.name)) names.set(asset.name, asset);
    if (
      asset.uri.startsWith('embeded://module-assets/') ||
      asset.uri.startsWith('embeded://__risu_module__/module-assets/')
    ) {
      const entries = moduleByName.get(asset.name) ?? [];
      entries.push(asset);
      moduleByName.set(asset.name, entries);
    }
  }
  const imageBytes = (imageId: string) => {
    const image = imagesById.get(imageId);
    if (!image) return failAsset();
    if (!blobs.has(image.blobHash)) {
      const blob = readImage(product.db, image.blobHash);
      if (
        blob.mime !== image.mime ||
        createHash('sha256').update(blob.bytes).digest('hex') !== image.blobHash
      )
        return failAsset();
      const bytes = blob.bytes;
      exportLimit((total += bytes.length), risuImportExpandedLimit(RISU_IMPORT_MAX_UPLOAD_BYTES));
      blobs.set(image.blobHash, bytes);
    }
    consumed.add(imageId);
    return { image, bytes: blobs.get(image.blobHash)! };
  };
  const add = (path: string, bytes: Buffer) => {
    assertExportPath(path);
    if (
      ['card.json', 'module.risum'].includes(path) ||
      (files.has(path) && !files.get(path)!.equals(bytes))
    )
      throw new HttpError(409, 'RISU_EXPORT_ASSET_PATH');
    files.set(path, bytes);
  };
  const assets = (Array.isArray(card.assets) ? card.assets : []).map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return failAsset();
    const asset = entry as Record<string, unknown>;
    if (typeof asset.uri !== 'string') return failAsset();
    if (/^(?:embeded|embedded):\/\//iu.test(asset.uri)) {
      const match =
        (typeof asset.name === 'string'
          ? nativeByUriName.get(asset.uri)?.get(asset.name)
          : undefined) ?? nativeByUri.get(asset.uri);
      if (!match) return failAsset();
      add(asset.uri.replace(/^(?:embeded|embedded):\/\//iu, ''), imageBytes(match.imageId).bytes);
    } else if (!/^(?:https?:\/\/|data:)/iu.test(asset.uri)) {
      // Host-local paths and missing embedded payloads cannot become portable references.
      return failAsset();
    }
    return asset;
  });
  if (native.module) {
    const module = native.module;
    stripDeprecatedRisuModuleFields(module);
    const metadata = module.assets === undefined ? [] : module.assets;
    if (!Array.isArray(metadata) || metadata.length > RISU_IMPORT_MAX_ASSETS) return failAsset();
    const moduleImageIds = new Set<string>();
    const bytes = metadata.map((entry) => {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[1] !== 'string')
        return failAsset();
      const matches = moduleByName.get(entry[0]) ?? [];
      if (matches.length !== 1) return failAsset();
      const match = matches[0];
      moduleImageIds.add(match.imageId);
      return imageBytes(match.imageId).bytes;
    });
    // module.icon is inline data in the Risu format; preserve edits to its stored image as well.
    const icon = native.assets.find(
      (item) =>
        /^embeded:\/\/(?:__risu_module__\/)?module-assets\//u.test(item.uri) &&
        item.name === 'main' &&
        !moduleImageIds.has(item.imageId)
    );
    if (icon && module.icon) {
      const current = imageBytes(icon.imageId);
      module.icon = `data:${current.image.mime};base64,${current.bytes.toString('base64')}`;
    }
    if (module.icon && pkg.portraitImageId) {
      const portrait = imageBytes(pkg.portraitImageId);
      module.icon = `data:${portrait.image.mime};base64,${portrait.bytes.toString('base64')}`;
    }
    if (standalone) {
      const metadataNames = new Set(metadata.filter(Array.isArray).map((entry) => entry[0]));
      for (const image of pkg.images ?? []) {
        if (consumed.has(image.id)) continue;
        if (metadataNames.has(image.title)) throw new HttpError(409, 'RISU_EXPORT_MODULE_CONFLICT');
        metadata.push([image.title, '', extension(image)]);
        metadataNames.add(image.title);
        bytes.push(imageBytes(image.id).bytes);
      }
      module.assets = metadata;
      if (metadata.length > RISU_IMPORT_MAX_ASSETS)
        throw new HttpError(413, 'RISU_EXPORT_TOO_LARGE');
      return {
        bytes: writeEmbeddedRisuModule(module, bytes),
        filename: filename(content.title, 'risum'),
        mediaType: 'application/octet-stream',
        revision: content.revision,
      };
    }
    files.set('module.risum', writeEmbeddedRisuModule(module, bytes));
  }
  // New host images have no imported URI yet. Give them stable archive names while keeping authored names.
  for (const image of pkg.images ?? []) {
    if (consumed.has(image.id)) continue;
    const path = `assets/uimori/${image.id}.${extension(image)}`;
    add(path, imageBytes(image.id).bytes);
    assets.push({
      type: 'x-risu-asset',
      name: image.title,
      uri: `embeded://${path}`,
      ext: extension(image),
    });
  }
  if (pkg.portraitImageId) {
    const portrait = imageBytes(pkg.portraitImageId);
    const original = native.assets.find((item) => item.imageId === pkg.portraitImageId);
    const matching = assets.find(
      (asset) => asset.type === 'icon' && asset.name === 'main' && asset.uri === original?.uri
    );
    if (!matching) {
      for (const asset of assets)
        if (asset.type === 'icon' && asset.name === 'main') asset.type = 'x-risu-asset';
      const path = `assets/uimori/portrait-${portrait.image.id}.${extension(portrait.image)}`;
      add(path, portrait.bytes);
      assets.push({
        type: 'icon',
        name: 'main',
        uri: `embeded://${path}`,
        ext: extension(portrait.image),
      });
    }
  }
  if (assets.length > RISU_IMPORT_MAX_ASSETS) throw new HttpError(413, 'RISU_EXPORT_TOO_LARGE');
  card.assets = assets;
  files.set('card.json', exportJson({ spec: 'chara_card_v3', spec_version: '3.0', data: card }));
  return {
    bytes: writeRisuZip(files),
    filename: filename(content.title, 'charx'),
    mediaType: 'application/zip',
    revision: content.revision,
  };
}

export function exportRisuPrompt(preset: PromptPreset): RisuExport {
  const native = structuredClone(preset.program.nativeRisuPreset);
  stripDeprecatedRisuPresetFields(native.preset);
  validateNativeRisuPreset(native);
  // Models/connections are host settings. The saved authored preset already excludes them.
  native.preset.name = preset.title;
  delete native.preset.openAIKey;
  delete native.preset.proxyKey;
  return {
    bytes: writeRisuPreset(native.preset),
    filename: filename(preset.title, 'risup'),
    mediaType: 'application/octet-stream',
    revision: preset.revision,
  };
}

export function risuExportRoutes(app: FastifyInstance, store: Store): void {
  for (const kind of ['content', 'prompt-preset'] as const) {
    const path = kind === 'content' ? 'content' : 'prompt-presets';
    app.get<{ Params: { id: string }; Querystring: { expectedRevision?: string } }>(
      `/api/${path}/:id/risu-export`,
      async (request, reply) => {
        assertLibraryVisible(store, kind, request.params.id);
        const item = store.product.get<Content | PromptPreset>(kind, request.params.id);
        if (request.query.expectedRevision !== undefined) {
          const expected = Number(request.query.expectedRevision);
          if (!Number.isSafeInteger(expected) || expected < 1)
            throw new HttpError(400, 'RISU_EXPORT_REVISION_INVALID');
          if (item.revision !== expected) throw new HttpError(409, 'RISU_EXPORT_REVISION_CHANGED');
        }
        const exported =
          kind === 'content'
            ? exportRisuContent(store.product, item as Content)
            : exportRisuPrompt(item as PromptPreset);
        return reply
          .header('Cache-Control', 'no-store')
          .header('X-Content-Type-Options', 'nosniff')
          .header('X-Uimori-Revision', exported.revision)
          .header(
            'Content-Disposition',
            `attachment; filename="uimori.${exported.filename.split('.').pop()}"; filename*=UTF-8''${encodeURIComponent(exported.filename).replace(/[!'()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`
          )
          .type(exported.mediaType)
          .send(exported.bytes);
      }
    );
  }
}
