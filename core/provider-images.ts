import { createHash } from 'node:crypto';
import { ProviderContractError } from './provider-errors.js';
import type { ResolvedRequestImage } from './request-images.js';
import type { Json, ProviderExecutionOptions, ProviderRequest } from './transport.js';

import { imageSlot, providerImageReference, requestImages } from './provider-image-reference.js';
export {
  assertProviderImageSupport,
  imageInputSupported,
  providerImagePart,
  providerImageReference,
  requestImages,
} from './provider-image-reference.js';

export const PROVIDER_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const PROVIDER_REQUEST_MAX_BYTES = 64 * 1024 * 1024;
const object = (value: Json): value is Record<string, Json> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function assertProviderRequestBytes(body: Json): void {
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > PROVIDER_REQUEST_MAX_BYTES)
    throw new ProviderContractError('IMAGE_REQUEST_TOO_LARGE');
}

/** Detach image-bearing wire bodies so frozen requests and opaque replay never contain bytes. */
export async function materializeProviderImages(
  body: Json,
  request: Pick<ProviderRequest, 'prompt'>,
  options: Pick<ProviderExecutionOptions, 'resolveImage'>,
  signal?: AbortSignal
): Promise<Json> {
  const images = requestImages(request);
  if (!images.length) return body;
  const allowed = new Map(images.map((image) => [providerImageReference(image), image]));
  const resolved = new Map<string, ResolvedRequestImage>();
  let wireBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
  if (wireBytes > PROVIDER_REQUEST_MAX_BYTES)
    throw new ProviderContractError('IMAGE_REQUEST_TOO_LARGE');
  const copy = structuredClone(body);
  const visit = async (value: Json): Promise<void> => {
    signal?.throwIfAborted();
    if (Array.isArray(value)) {
      for (const item of value) await visit(item);
      return;
    }
    if (!object(value)) return;
    const slot = imageSlot(value);
    if (slot) {
      const reference = slot.owner[slot.key];
      if (typeof reference === 'string' && reference.startsWith('uimori-image://')) {
        const image = allowed.get(reference);
        if (!image || !options.resolveImage)
          throw new ProviderContractError('IMAGE_INPUT_UNAVAILABLE');
        let data = resolved.get(reference);
        if (!data) {
          data = await options.resolveImage(image, signal);
          signal?.throwIfAborted();
          if (
            data.mime !== image.mime ||
            data.width !== image.input.width ||
            data.height !== image.input.height ||
            typeof data.base64 !== 'string' ||
            !data.base64.length ||
            data.base64.length > 4 * Math.ceil(PROVIDER_IMAGE_MAX_BYTES / 3)
          )
            throw new ProviderContractError('IMAGE_INPUT_INVALID');
          const bytes = Buffer.from(data.base64, 'base64');
          if (
            bytes.length > PROVIDER_IMAGE_MAX_BYTES ||
            bytes.toString('base64') !== data.base64 ||
            createHash('sha256').update(bytes).digest('hex') !== image.input.hash
          )
            throw new ProviderContractError('IMAGE_INPUT_INVALID');
          resolved.set(reference, data);
        }
        const payload = slot.url ? `data:${data.mime};base64,${data.base64}` : data.base64;
        wireBytes += payload.length - reference.length;
        if (wireBytes > PROVIDER_REQUEST_MAX_BYTES)
          throw new ProviderContractError('IMAGE_REQUEST_TOO_LARGE');
        slot.owner[slot.key] = payload;
        return;
      }
    }
    for (const item of Object.values(value)) await visit(item);
  };
  await visit(copy);
  assertProviderRequestBytes(copy);
  return copy;
}
