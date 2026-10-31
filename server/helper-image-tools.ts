import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { ProviderTool } from '../core/transport.js';
import type { RequestImage, ResolvedRequestImage } from '../core/request-images.js';
import type { Content } from '../core/product.js';
import type { PackageImage } from '../core/package-images.js';
import { readImage } from './image-storage.js';
import { withImageProcessing } from './image-processing.js';
import { readResource } from './resource-service.js';
import { HttpError, number, record, text } from './request-validation.js';
import type { Store } from './store.js';

const MAX_BYTES = 2 * 1024 * 1024;
const id = { type: 'string', minLength: 1, maxLength: 100 } as const;
export const HELPER_IMAGE_TOOLS: ProviderTool[] = [
  {
    name: 'image.list',
    description:
      'List saved content images, including CHARX assets. Search titles, descriptions and original asset names with query; follow nextOffset for more. Use image.read with contentId and imageId to view pixels.',
    inputSchema: {
      type: 'object',
      properties: {
        contentId: id,
        query: { type: 'string', maxLength: 200 },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['contentId'],
      additionalProperties: false,
    },
  },
  {
    name: 'image.read',
    description:
      'View the pixels of a saved content image from image.list. Supplies WebP visual input while preserving the original. Animated images supply their first frame. Reads the current saved version.',
    inputSchema: {
      type: 'object',
      properties: {
        contentId: id,
        imageId: id,
      },
      required: ['contentId', 'imageId'],
      additionalProperties: false,
    },
  },
];

function owner(store: Store, contentId: unknown): Content {
  return readResource(store, 'content', text(contentId, 'content ID', 100)) as Content;
}

function imageMetadata(content: Content, image: PackageImage, names?: string[]) {
  const nativeNames =
    names ??
    (content.package.nativeRisu?.assets ?? [])
      .filter((asset) => asset.imageId === image.id)
      .map((asset) => asset.name);
  return {
    imageId: image.id,
    title: image.title,
    description: image.description.slice(0, 500),
    descriptionTruncated: image.description.length > 500,
    mime: image.mime,
    allowedUse: image.allowedUse,
    nativeNames: nativeNames.slice(0, 4).map((name) => name.slice(0, 200)),
    nativeNamesTruncated: nativeNames.length > 4 || nativeNames.some((name) => name.length > 200),
  };
}

export function listHelperImages(store: Store, value: unknown) {
  const args = record(value);
  const content = owner(store, args.contentId);
  const query = args.query === undefined ? '' : text(args.query, 'image query', 200, true);
  const offset = args.offset === undefined ? 0 : number(args.offset, 'offset', 0);
  const limit = args.limit === undefined ? 10 : number(args.limit, 'limit', 1, 20);
  const all = content.package.images ?? [];
  const nativeNames = new Map<string, string[]>();
  for (const asset of content.package.nativeRisu?.assets ?? []) {
    const names = nativeNames.get(asset.imageId);
    if (names) names.push(asset.name);
    else nativeNames.set(asset.imageId, [asset.name]);
  }
  const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const matching = all.filter((image) => {
    const names = nativeNames.get(image.id) ?? [];
    const searchable = [image.id, image.title, image.description, ...names]
      .join('\n')
      .toLocaleLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
  const images = matching
    .slice(offset, offset + limit)
    .map((image) => imageMetadata(content, image, nativeNames.get(image.id) ?? []));
  return {
    contentId: content.id,
    revision: content.revision,
    query,
    total: all.length,
    matching: matching.length,
    images,
    nextOffset: offset + images.length < matching.length ? offset + images.length : null,
  };
}

/** Transmission bytes are ephemeral: neither originals nor converted copies are written. */
export async function readHelperImage(store: Store, value: unknown, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const args = record(value);
  const content = owner(store, args.contentId);
  const imageId = text(args.imageId, 'image ID', 100);
  const source = content.package.images?.find((image) => image.id === imageId);
  if (!source) throw new HttpError(404, 'IMAGE_NOT_FOUND_IN_CONTENT');
  const stored = readImage(store.db, source.blobHash);
  return withImageProcessing(async () => {
    signal?.throwIfAborted();
    try {
      const options = {
        page: 0,
        pages: 1,
        limitInputPixels: 64 * 1024 * 1024,
        failOn: 'error' as const,
      };
      const metadata = await sharp(stored.bytes, options).metadata();
      const width = metadata.width ?? 0;
      const height = metadata.pageHeight ?? metadata.height ?? 0;
      if (!width || !height) throw new HttpError(400, 'HELPER_IMAGE_INVALID');
      const frames = metadata.pages ?? 1;
      const reuse =
        metadata.format === 'webp' &&
        frames === 1 &&
        (metadata.orientation ?? 1) === 1 &&
        Math.max(width, height) <= 2048 &&
        stored.bytes.length <= MAX_BYTES;
      let edge = 2048;
      const convert = () =>
        sharp(stored.bytes, options)
          .rotate()
          .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 90, alphaQuality: 90 })
          .toBuffer({ resolveWithObject: true });
      let output = reuse ? { data: stored.bytes, info: { width, height } } : await convert();
      while (output.data.length > MAX_BYTES) {
        signal?.throwIfAborted();
        edge = Math.max(1, Math.floor(Math.max(output.info.width, output.info.height) * 0.75));
        output = await convert();
      }
      signal?.throwIfAborted();
      const hash = reuse ? source.blobHash : createHash('sha256').update(output.data).digest('hex');
      const image: RequestImage = {
        hash,
        mime: 'image/webp',
        name: `${content.title} — ${source.title}`.slice(0, 300).replace(/[\uD800-\uDBFF]$/u, ''),
        width: output.info.width,
        height: output.info.height,
        input: { hash, width: output.info.width, height: output.info.height },
      };
      const resolved: ResolvedRequestImage = {
        mime: 'image/webp',
        base64: output.data.toString('base64'),
        width: image.width,
        height: image.height,
      };
      return {
        result: {
          contentId: content.id,
          revision: content.revision,
          ...imageMetadata(content, source),
          source: { hash: source.blobHash, mime: stored.mime, width, height, frames },
          transmission: { mime: image.mime, width: image.width, height: image.height },
          ...(frames > 1
            ? { notice: 'Only the first frame of this animated image is supplied.' }
            : {}),
        },
        image,
        resolved,
      };
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, 'HELPER_IMAGE_INVALID');
    }
  });
}
