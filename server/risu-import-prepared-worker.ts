import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readCharacterCardPath } from './character-card-file.js';
import { analyzeNativeRisuImport } from './risu-native-import.js';
import { processImage } from './image-processing.js';
import { object, string } from './risu-import-card.js';
import type { PreparedRisuAsset } from './risu-import-assets.js';
import {
  RISU_IMPORT_MAX_ASSETS,
  RISU_IMPORT_MAX_PREPARED_BYTES,
  type RisuImportKind,
} from '../core/risu-import.js';
import { HttpError } from './request-validation.js';
import { bundleDigest, type PreparedBundleImage } from './resource-bundle.js';
import type { PreparedRisuImport } from './risu-import-prepared.js';

/** One image at a time, including extraction: a large card never becomes a base64 image array. */
export async function prepareRisuInWorker(input: {
  path: string;
  name: string;
  kind?: RisuImportKind;
  directory: string;
  id: string;
  reproject?: boolean;
}): Promise<void> {
  if (input.reproject) {
    const cached = JSON.parse(readFileSync(join(input.directory, 'input.json'), 'utf8'));
    const previous = JSON.parse(
      readFileSync(join(input.directory, 'manifest.json'), 'utf8')
    ) as PreparedRisuImport;
    const card = {
      ...cached.card,
      kind: input.kind ?? (cached.card.format.startsWith('risu-module-') ? 'module' : 'bot'),
      members: new Map(cached.memberKeys.map((key: string) => [key, () => Buffer.alloc(0)])),
    };
    const analyzed = analyzeNativeRisuImport(card, new Map(cached.assets));
    writeFileSync(
      join(input.directory, 'manifest.next.json'),
      JSON.stringify({
        ...previous,
        id: input.id,
        requestedKind: input.kind,
        createdAt: Date.now(),
        file: analyzed.file,
        preview: { ...analyzed.preview, preparedId: input.id },
        images: previous.images,
        transferDigest: bundleDigest(analyzed.file),
      }),
      { flag: 'w' }
    );
    return;
  }
  const card = await readCharacterCardPath(input.path, input.name, input.kind, input.directory);
  if ((card.card.assets?.length ?? 0) > RISU_IMPORT_MAX_ASSETS)
    throw new HttpError(400, 'RISU_IMPORT_INVALID_FILE');
  const preparedAssets = new Map<string, PreparedRisuAsset | null>();
  const sourceHashes = new Map<string, PreparedRisuAsset | null>();
  const images = new Map<string, PreparedBundleImage>();
  let total = 0;
  for (const raw of card.card.assets ?? []) {
    const uri = string(object(raw).uri);
    if (preparedAssets.has(uri)) continue;
    const path = uri.replace(/^(?:embeded|embedded):\/\//iu, '');
    const read = /^(?:embeded|embedded):\/\//iu.test(uri) ? card.members.get(path) : undefined;
    if (!read) continue;
    // Container errors are not silently converted into missing-image findings.
    const bytes = read();
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (sourceHashes.has(hash)) {
      preparedAssets.set(uri, sourceHashes.get(hash)!);
      continue;
    }
    try {
      const supported =
        bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        (bytes[0] === 255 && bytes[1] === 216) ||
        bytes.toString('ascii', 0, 4) === 'RIFF' ||
        bytes.toString('ascii', 4, 8) === 'ftyp' ||
        ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6));
      if (!supported) throw new HttpError(400, 'Unsupported image');
      const image = await processImage(bytes);
      if (image.bytes.length > 64 * 1024 * 1024)
        throw new HttpError(400, 'Prepared image too large');
      const descriptor: PreparedRisuAsset = { hash: image.hash, mime: image.mime };
      if (!images.has(image.hash)) {
        total += image.bytes.length;
        if (total > RISU_IMPORT_MAX_PREPARED_BYTES)
          throw new HttpError(413, 'RISU_IMPORT_IMAGES_TOO_LARGE');
        const path = join(input.directory, `${image.hash}.image`);
        writeFileSync(path, image.bytes, { flag: 'wx' });
        images.set(image.hash, { ...descriptor, path, bytes: image.bytes.length });
      }
      sourceHashes.set(hash, descriptor);
      preparedAssets.set(uri, descriptor);
    } catch (error) {
      if (!(error instanceof HttpError) || error.statusCode === 413) throw error;
      sourceHashes.set(hash, null);
      preparedAssets.set(uri, null);
    }
  }
  const analyzed = analyzeNativeRisuImport(card, preparedAssets);
  const { members, ...cardMetadata } = card;
  writeFileSync(
    join(input.directory, 'input.json'),
    JSON.stringify({
      card: cardMetadata,
      memberKeys: [...members.keys()],
      assets: [...preparedAssets],
    }),
    { flag: 'wx' }
  );
  const manifest: PreparedRisuImport = {
    version: 1,
    requestedKind: input.kind,
    id: input.id,
    createdAt: Date.now(),
    sourceName: input.name,
    sourceHash: card.hash,
    file: analyzed.file,
    preview: { ...analyzed.preview, preparedId: input.id },
    images: [...images.values()],
    transferDigest: bundleDigest(analyzed.file),
  };
  writeFileSync(join(input.directory, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx' });
  for (const entry of readdirSync(input.directory)) {
    if (entry === 'manifest.json' || entry === 'input.json' || /^[a-f0-9]{64}\.image$/u.test(entry))
      continue;
    const path = join(input.directory, entry);
    if (statSync(path).isFile()) rmSync(path);
  }
}
