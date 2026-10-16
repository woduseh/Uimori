import { ProviderContractError } from './provider-errors.js';
import type { RequestImage } from './request-images.js';
import type { Json, ProviderRequest } from './transport.js';
import type { ProviderProtocol } from './product.js';

const IMAGE_REFERENCE = /^uimori-image:\/\/([a-f0-9]{64})\/([1-9][0-9]*)\/([1-9][0-9]*)$/u;

/** Small immutable references are safe in previews, signed continuations and saved requests. */
export function providerImageReference(image: RequestImage): string {
  return `uimori-image://${image.input.hash}/${image.input.width}/${image.input.height}`;
}

export function imageReferenceMetadata(value: string) {
  const match = IMAGE_REFERENCE.exec(value);
  return match ? { hash: match[1], width: Number(match[2]), height: Number(match[3]) } : undefined;
}

export function requestImages(request: Pick<ProviderRequest, 'prompt'>): RequestImage[] {
  return (request.prompt?.messages ?? []).flatMap((message) =>
    message.content.flatMap((part) => (part.type === 'image' ? [part.image] : []))
  );
}

/** Unknown routed/custom models may try image input; known text-only families are rejected. */
export function imageInputSupported(protocol: ProviderProtocol, modelId: string): boolean | null {
  if (protocol === 'fixture-sse-v1') return true;
  if (
    protocol === 'deepseek-chat-v1' ||
    [
      'deepseek-chat',
      'deepseek-reasoner',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'deepseek/deepseek-chat',
      'deepseek/deepseek-reasoner',
      'deepseek/deepseek-v4-pro',
      'deepseek/deepseek-v4-flash',
    ].includes(modelId)
  )
    return false;
  return null;
}

export function assertProviderImageSupport(
  request: Pick<ProviderRequest, 'prompt' | 'modelId'>,
  protocol: ProviderProtocol
): void {
  if (requestImages(request).length && imageInputSupported(protocol, request.modelId) === false)
    throw new ProviderContractError('IMAGE_INPUT_UNSUPPORTED_MODEL');
}

export function providerImagePart(image: RequestImage, protocol: ProviderProtocol): Json {
  const reference = providerImageReference(image);
  if (protocol === 'openai-responses-v1')
    return { type: 'input_image', image_url: reference, detail: 'auto' };
  if (protocol === 'anthropic-messages-v1')
    return { type: 'image', source: { type: 'base64', media_type: image.mime, data: reference } };
  if (protocol === 'vertex-gemini-v1' || protocol === 'google-gemini-v1')
    return { inlineData: { mimeType: image.mime, data: reference } };
  if (protocol === 'openai-chat-v1' || protocol === 'vercel-chat-v1')
    return { type: 'image_url', image_url: { url: reference, detail: 'auto' } };
  if (protocol === 'codex-app-server-v1' || protocol === 'fixture-sse-v1')
    return { type: 'image', url: reference };
  throw new ProviderContractError('IMAGE_INPUT_UNSUPPORTED_PROTOCOL');
}

const object = (value: Json): value is Record<string, Json> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Visit native image slots only. Text and provider tool output cannot request blob resolution. */
export function imageSlot(
  value: Record<string, Json>
): { owner: Record<string, Json>; key: string; url: boolean } | undefined {
  if (value.type === 'input_image') return { owner: value, key: 'image_url', url: true };
  if (value.type === 'image_url' && object(value.image_url))
    return { owner: value.image_url, key: 'url', url: true };
  if (value.type === 'image' && typeof value.url === 'string')
    return { owner: value, key: 'url', url: true };
  if (
    value.type === 'image' &&
    value.source &&
    object(value.source) &&
    value.source.type === 'base64'
  )
    return { owner: value.source, key: 'data', url: false };
  if (value.inlineData && object(value.inlineData))
    return { owner: value.inlineData, key: 'data', url: false };
  return undefined;
}

/** Recognize a real planned image part, never a marker appearing in ordinary source text. */
export function plannedImageMetadata(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const slot = imageSlot(value as Record<string, Json>);
  const reference = slot?.owner[slot.key];
  return typeof reference === 'string' ? imageReferenceMetadata(reference) : undefined;
}
