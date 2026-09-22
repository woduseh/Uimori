import type { NativeTransferFile } from '../core/native-transfer.js';
import { processImage } from './image-processing.js';

/** Convert each distinct input once before a DB transaction. Native logical asset aliases stay stable. */
export async function convertTransferImages(file: NativeTransferFile) {
  const mapped = new Map<string, NativeTransferFile['images'][number]>();
  for (const image of file.images) {
    if (mapped.has(image.hash)) continue;
    const processed = await processImage(Buffer.from(image.base64, 'base64'));
    mapped.set(image.hash, {
      id: processed.hash,
      revision: 1,
      hash: processed.hash,
      mime: processed.mime,
      base64: processed.bytes.toString('base64'),
    });
  }
  const replaceUrls = (value: unknown): any => {
    if (typeof value === 'string')
      return value.replace(/\/api\/package-image-blobs\/([a-f0-9]{64})/gu, (url, hash) =>
        mapped.has(hash) ? `/api/package-image-blobs/${mapped.get(hash)!.hash}` : url
      );
    if (Array.isArray(value)) return value.map(replaceUrls);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, replaceUrls(item)])
      );
    return value;
  };
  const contents = file.contents.map((entry) => {
    const copy = replaceUrls(entry) as typeof entry;
    copy.source.package.images = (entry.source.package.images ?? []).map((image) => {
      const stored = mapped.get(image.blobHash)!;
      return { ...image, blobHash: stored.hash, mime: stored.mime };
    });
    return copy;
  });
  // Containers and original unconverted image copies are not persistent app data.
  return {
    file: {
      format: file.format,
      version: file.version,
      roots: file.roots,
      contents,
      prompts: file.prompts,
      images: [...new Map([...mapped.values()].map((image) => [image.hash, image])).values()],
    } as NativeTransferFile,
    imagesBySourceHash: mapped,
  };
}
export async function normalizeTransferImages(
  file: NativeTransferFile
): Promise<NativeTransferFile> {
  return (await convertTransferImages(file)).file;
}
