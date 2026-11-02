import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { nativeRisuAssetNameResolver } from '../core/risu-native.js';
import {
  REQUEST_IMAGE_MAX_COUNT,
  type RequestImage,
  type ResolvedRequestImage,
} from '../core/request-images.js';
import type { LogicalMessage } from '../core/risu-prompt.js';
import type { RunSnapshot } from '../core/types.js';
import { readImage } from './image-storage.js';
import { withImageProcessing } from './image-processing.js';
import { nativeRisuPackages } from './risu-native-context.js';
import { readRequestImage } from './request-images.js';
import type { Store } from './store.js';

export class NativeScriptImageError extends Error {}

/** Only images already owned by the frozen run can be resolved; no path or URL is fetched. */
export async function nativeScriptImages(
  store: Store,
  snapshot: RunSnapshot,
  messages: LogicalMessage[],
  signal: AbortSignal
): Promise<{
  messages: LogicalMessage[];
  resolveImage: (image: RequestImage) => ResolvedRequestImage;
}> {
  const assets = new Map<string, { hash: string; name: string }>();
  for (const { pkg, native } of nativeRisuPackages(snapshot)) {
    const images = new Map((pkg.images ?? []).map((image) => [image.id, image]));
    const names = nativeRisuAssetNameResolver(native);
    for (const asset of native.assets) {
      const image = images.get(asset.imageId);
      if (!image) continue;
      for (const name of names(asset))
        assets.set(name, { hash: image.blobHash, name: image.title });
    }
  }
  const requests = new Map<string, RequestImage>();
  const history = snapshot.nativeRisuExecution?.history ?? snapshot.logicalHistory ?? [];
  for (const image of [
    ...(snapshot.requestImages ?? []),
    ...history.filter((m) => m.role === 'user').flatMap((m) => m.requestImages ?? []),
  ])
    requests.set(`request-image:${image.hash}`, image);

  const pending = new Map<number, { text: string; names: string[] }>();
  let count = 0;
  for (const [index, message] of messages.entries()) {
    const names: string[] = [];
    const part = message.content[0];
    if (part.type !== 'text') throw new NativeScriptImageError('RISU_NATIVE_INLAY_INVALID');
    const text = part.text.replace(
      /\{\{(inlay|inlayed|inlayeddata)::(.+?)\}\}/gu,
      (_match, kind: string, name: string) => {
        if (message.role === 'assistant' && kind !== 'inlayeddata') return '';
        if (message.role !== 'user')
          throw new NativeScriptImageError('RISU_NATIVE_INLAY_ROLE_UNSUPPORTED');
        if (!assets.has(name) && !requests.has(name))
          throw new NativeScriptImageError('RISU_NATIVE_INLAY_UNAVAILABLE');
        if (++count > REQUEST_IMAGE_MAX_COUNT)
          throw new NativeScriptImageError('RISU_NATIVE_INLAY_LIMIT');
        names.push(name);
        return '';
      }
    );
    pending.set(index, { text, names });
  }
  const resolved = new Map<string, ResolvedRequestImage>();
  const converted = new Map<string, RequestImage>();
  const result: LogicalMessage[] = [];
  for (const [index, message] of messages.entries()) {
    const { text, names } = pending.get(index)!;
    const content: LogicalMessage['content'] = [{ type: 'text', text }];
    for (const name of names) {
      signal.throwIfAborted();
      const request = requests.get(name);
      if (request) {
        content.push({ type: 'image', image: request });
        continue;
      }
      const asset = assets.get(name)!;
      let image = converted.get(asset.hash);
      if (!image) {
        try {
          const stored = readImage(store.db, asset.hash);
          const output = await withImageProcessing(async () => {
            signal.throwIfAborted();
            let edge = 2048;
            const convert = () =>
              sharp(stored.bytes, {
                page: 0,
                pages: 1,
                limitInputPixels: 64 * 1024 * 1024,
                failOn: 'error',
              })
                .rotate()
                .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
                .webp({ quality: 90, alphaQuality: 90 })
                .toBuffer({ resolveWithObject: true });
            let output = await convert();
            while (output.data.length > 2 * 1024 * 1024) {
              signal.throwIfAborted();
              edge = Math.max(
                1,
                Math.floor(Math.max(output.info.width, output.info.height) * 0.75)
              );
              output = await convert();
            }
            signal.throwIfAborted();
            return output;
          });
          const hash = createHash('sha256').update(output.data).digest('hex');
          const width = output.info.width,
            height = output.info.height;
          image = {
            hash,
            mime: 'image/webp',
            name: asset.name.slice(0, 300),
            width,
            height,
            input: { hash, width, height },
          };
          resolved.set(hash, {
            mime: 'image/webp',
            base64: output.data.toString('base64'),
            width,
            height,
          });
          converted.set(asset.hash, image);
        } catch (error) {
          signal.throwIfAborted();
          throw new NativeScriptImageError('RISU_NATIVE_INLAY_UNAVAILABLE', { cause: error });
        }
      }
      content.push({ type: 'image', image });
    }
    result.push({ ...message, content });
  }
  return {
    messages: result,
    resolveImage: (image) => resolved.get(image.input.hash) ?? readRequestImage(store, image),
  };
}
