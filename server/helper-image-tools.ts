import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { ProviderTool } from '../core/transport.js';
import type { RequestImage, ResolvedRequestImage } from '../core/request-images.js';
import type { Asset, Content } from '../core/product.js';
import type { PackageImage } from '../core/package-images.js';
import type { RisuContent } from '../core/risu-content.js';
import { readImage } from './image-storage.js';
import { withImageProcessing } from './image-processing.js';
import { readResource } from './resource-service.js';
import { illustrationReferenceCandidates } from './illustrations.js';
import { resolvePackageProfile } from './package-features.js';
import { fields, HttpError, number, record, text } from './request-validation.js';
import type { Store } from './store.js';

const MAX_BYTES = 2 * 1024 * 1024;
type ImageReadMode = 'full' | 'thumbnail';
const readModeSchema = {
  type: 'string',
  enum: ['full', 'thumbnail'],
  description:
    'thumbnail (default) is at most 512 pixels on the longest side; full is at most 2048 pixels for fine detail.',
};
function readMode(args: ReturnType<typeof record>): ImageReadMode {
  if (args.mode === undefined || args.mode === 'thumbnail') return 'thumbnail';
  if (args.mode === 'full') return 'full';
  throw new HttpError(400, 'Invalid image read mode');
}
const id = { type: 'string', minLength: 1, maxLength: 100 } as const;
const paging = {
  query: {
    type: 'string',
    maxLength: 200,
    description: 'Search terms matched against image names and descriptions. Omit to list all.',
  },
  offset: {
    type: 'integer',
    minimum: 0,
    description: 'Result offset. Pass the previous nextOffset.',
  },
  limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum images per page.' },
} as const;
export const HELPER_IMAGE_TOOLS: ProviderTool[] = [
  {
    name: 'image.list',
    description:
      'List the images saved with one bot, persona or module, including CHARX assets, to find an image by its title, description or original asset name. Returns metadata, the content revision and nextOffset, not pixels: view an image with image.read. The package portrait is marked isPortrait. Images in an unsaved editor draft are not included.',
    inputSchema: {
      type: 'object',
      properties: {
        contentId: { ...id, description: 'Id of the bot, persona or module that owns the images.' },
        ...paging,
      },
      required: ['contentId'],
      additionalProperties: false,
    },
  },
  {
    name: 'image.read',
    description:
      'Look at one saved image of a bot, persona or module. The image arrives as actual image input, so use it before describing or judging what a picture shows. Start with the default thumbnail and ask for mode=full only when fine detail matters. An animated image is shown as its first frame. The saved original is never changed. A model known to lack image input gets an unsupported-image result instead.',
    inputSchema: {
      type: 'object',
      properties: {
        contentId: { ...id, description: 'Id of the bot, persona or module that owns the image.' },
        imageId: { ...id, description: 'Id of the image, from image.list.' },
        mode: readModeSchema,
      },
      required: ['contentId', 'imageId'],
      additionalProperties: false,
    },
  },
  {
    name: 'illustration.image.list',
    description:
      'Find the images that can serve as illustration references in a chat: images uploaded to the chat and images of its attached bots, personas and modules. Search by name, character, outfit or location. Each entry has a ref for illustration.image.read, illustration.profiles.save and illustration.references.save; isPortrait marks package cover art and nativeNames gives the original CHARX asset names. This returns metadata only, so view just the relevant refs, thumbnails first.',
    inputSchema: { type: 'object', properties: paging, required: [], additionalProperties: false },
  },
  {
    name: 'illustration.image.read',
    description:
      'Look at one illustration reference image by its ref from illustration.image.list. The image arrives as actual image input. Start with the default thumbnail and ask for mode=full only when fine detail matters. An animated image is shown as its first frame.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          minLength: 1,
          maxLength: 300,
          description: 'Image ref exactly as returned by illustration.image.list.',
        },
        mode: readModeSchema,
      },
      required: ['ref'],
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
    isPortrait: content.package.portraitImageId === image.id,
    title: image.title,
    description: image.description.slice(0, 500),
    descriptionTruncated: image.description.length > 500,
    mime: image.mime,
    allowedUse: image.allowedUse,
    nativeNames: nativeNames.slice(0, 4).map((name) => name.slice(0, 200)),
    nativeNamesTruncated: nativeNames.length > 4 || nativeNames.some((name) => name.length > 200),
  };
}

function imagePage(args: ReturnType<typeof record>) {
  const query = args.query === undefined ? '' : text(args.query, 'image query', 200, true);
  const offset = args.offset === undefined ? 0 : number(args.offset, 'offset', 0);
  const limit = args.limit === undefined ? 10 : number(args.limit, 'limit', 1, 20);
  return { query, offset, limit, terms: query.toLocaleLowerCase().split(/\s+/u).filter(Boolean) };
}

export function listHelperImages(store: Store, value: unknown) {
  const args = record(value);
  const content = owner(store, args.contentId);
  const { query, offset, limit, terms } = imagePage(args);
  const all = content.package.images ?? [];
  const nativeNames = new Map<string, string[]>();
  for (const asset of content.package.nativeRisu?.assets ?? []) {
    const names = nativeNames.get(asset.imageId);
    if (names) names.push(asset.name);
    else nativeNames.set(asset.imageId, [asset.name]);
  }
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

function referenceMetadata(asset: Asset, packages: RisuContent[]) {
  const owner = asset.packageOwner;
  const pkg =
    owner && packages.find((item) => item.id === owner.id && item.revision === owner.revision);
  const nativeNames =
    pkg?.nativeRisu?.assets
      .filter((item) => item.imageId === owner?.imageId)
      .map((item) => item.name) ?? [];
  return {
    ref: asset.id,
    title: asset.title,
    description: asset.description.slice(0, 500),
    descriptionTruncated: asset.description.length > 500,
    actor: asset.actor,
    ...(owner ? { packageTitle: owner.title } : {}),
    isPortrait: !!(pkg && owner && pkg.portraitImageId === owner.imageId),
    nativeNames: nativeNames.slice(0, 4).map((name) => name.slice(0, 200)),
    nativeNamesTruncated: nativeNames.length > 4 || nativeNames.some((name) => name.length > 200),
    outfit: asset.outfit,
    location: asset.location,
  };
}

export function listIllustrationHelperImages(store: Store, chatId: string, value: unknown) {
  const args = record(value);
  fields(args, ['query', 'offset', 'limit']);
  const { offset, limit, terms } = imagePage(args);
  const packages =
    resolvePackageProfile(store.product, store.product.profile(chatId)).packages ?? [];
  const all = illustrationReferenceCandidates(store, chatId).map((asset) =>
    referenceMetadata(asset, packages)
  );
  const matching = terms.length
    ? all.filter((image) => {
        const haystack = [
          image.ref,
          image.title,
          image.description,
          image.actor,
          image.packageTitle,
          ...image.nativeNames,
          image.outfit,
          image.location,
        ]
          .join('\n')
          .toLocaleLowerCase();
        return terms.every((term) => haystack.includes(term));
      })
    : all;
  const images = matching.slice(offset, offset + limit);
  return {
    images,
    matching: matching.length,
    total: all.length,
    nextOffset: offset + images.length < matching.length ? offset + images.length : null,
  };
}

export async function readIllustrationHelperImage(
  store: Store,
  chatId: string,
  value: unknown,
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  const args = record(value);
  fields(args, ['ref', 'mode']);
  const mode = readMode(args);
  const ref = text(args.ref, 'illustration image ref', 300);
  const asset = illustrationReferenceCandidates(store, chatId).find(
    (candidate) => candidate.id === ref
  );
  if (!asset) throw new HttpError(404, 'ILLUSTRATION_REFERENCE_NOT_FOUND');
  const packages =
    resolvePackageProfile(store.product, store.product.profile(chatId)).packages ?? [];
  return prepareHelperImage(
    store,
    asset.hash,
    asset.title,
    referenceMetadata(asset, packages),
    signal,
    mode
  );
}

export async function readHelperImage(store: Store, value: unknown, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const args = record(value);
  fields(args, ['contentId', 'imageId', 'mode']);
  const mode = readMode(args);
  const content = owner(store, args.contentId);
  const imageId = text(args.imageId, 'image ID', 100);
  const source = content.package.images?.find((image) => image.id === imageId);
  if (!source) throw new HttpError(404, 'IMAGE_NOT_FOUND_IN_CONTENT');
  return prepareHelperImage(
    store,
    source.blobHash,
    `${content.title} — ${source.title}`,
    {
      contentId: content.id,
      revision: content.revision,
      ...imageMetadata(content, source),
    },
    signal,
    mode
  );
}

export async function prepareHelperImage<T extends object>(
  store: Store,
  sourceHash: string,
  title: string,
  metadataFields: T,
  signal?: AbortSignal,
  mode: ImageReadMode = 'thumbnail'
) {
  const stored = readImage(store.db, sourceHash);
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
      const edgeLimit = mode === 'thumbnail' ? 512 : 2048;
      const reuse =
        metadata.format === 'webp' &&
        frames === 1 &&
        (metadata.orientation ?? 1) === 1 &&
        Math.max(width, height) <= edgeLimit &&
        stored.bytes.length <= MAX_BYTES;
      let edge = edgeLimit;
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
      const hash = reuse ? sourceHash : createHash('sha256').update(output.data).digest('hex');
      const image: RequestImage = {
        hash,
        mime: 'image/webp',
        name: title.slice(0, 300).replace(/[\uD800-\uDBFF]$/u, ''),
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
          ...metadataFields,
          source: { hash: sourceHash, mime: stored.mime, width, height, frames },
          transmission: {
            mime: image.mime,
            width: image.width,
            height: image.height,
            ...(mode === 'thumbnail' ? { mode } : {}),
          },
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
