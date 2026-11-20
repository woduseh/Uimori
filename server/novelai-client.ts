import { randomInt } from 'node:crypto';
import {
  ProviderBodyLimitError,
  providerFetchOptions,
  readProviderBody,
  transportFailureCode,
} from '../core/provider-fetch.js';
import {
  detectImageMime,
  isValidIllustrationImage,
  IllustrationError,
  ILLUSTRATION_MAX_IMAGE_BYTES,
  type IllustrationImageMime,
} from '../core/illustration.js';
import type {
  NovelAIAccount,
  NovelAICharacterPrompt,
  NovelAIRenderSettings,
} from '../core/novelai-settings.js';
import { readCardZip } from './risu-card-zip.js';

// https://image.novelai.net/docs/doc.json (2026-11-20): image and account paths share this host
// and accept the Persistent API token as a Bearer credential.
export const NOVELAI_ORIGIN = 'https://image.novelai.net';
export const NOVELAI_TIERS = ['Paper', 'Tablet', 'Scroll', 'Opus'] as const;

export type NovelAIRequestOptions = {
  signal: AbortSignal;
  token: () => string | undefined | Promise<string | undefined>;
};
export type NovelAIImage = { mime: IllustrationImageMime; bytes: Buffer };

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const PRECONNECT = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'];

function statusCode(status: number): string {
  if (status === 401 || status === 403) return 'NOVELAI_UNAUTHORIZED';
  if (status === 402) return 'NOVELAI_ANLAS_INSUFFICIENT';
  if (status === 429) return 'NOVELAI_BUSY';
  return status >= 500 ? 'NOVELAI_RESULT_UNCERTAIN' : 'NOVELAI_REQUEST_REJECTED';
}
async function rejection(response: Response, signal: AbortSignal): Promise<IllustrationError> {
  let message: string | undefined;
  try {
    const body = JSON.parse((await readProviderBody(response, signal, 64_000)).toString('utf8'));
    if (object(body) && typeof body.message === 'string')
      message = Array.from(body.message.trim()).slice(0, 300).join('') || undefined;
  } catch {}
  return new IllustrationError(statusCode(response.status), false, {
    novelai: { httpStatus: response.status, ...(message ? { message } : {}) },
  });
}
async function send(
  path: string,
  options: NovelAIRequestOptions,
  body?: unknown
): Promise<Response> {
  options.signal.throwIfAborted();
  const token = await options.token();
  if (!token) throw new IllustrationError('NOVELAI_TOKEN_MISSING');
  options.signal.throwIfAborted();
  try {
    return await fetch(
      `${NOVELAI_ORIGIN}${path}`,
      providerFetchOptions({
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: options.signal,
        redirect: 'error',
      })
    );
  } catch (error) {
    if (options.signal.aborted) throw error;
    const cause =
      error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
    const preconnect = PRECONNECT.includes(String(cause?.code ?? ''));
    throw new IllustrationError(
      preconnect || body === undefined ? 'NOVELAI_UNREACHABLE' : 'NOVELAI_RESULT_UNCERTAIN',
      false,
      { novelai: { message: transportFailureCode(error) } }
    );
  }
}

export async function novelAISubscription(options: NovelAIRequestOptions): Promise<NovelAIAccount> {
  const response = await send('/user/subscription', options);
  if (!response.ok) throw await rejection(response, options.signal);
  let body: unknown;
  try {
    body = JSON.parse((await readProviderBody(response, options.signal, 256_000)).toString('utf8'));
  } catch (error) {
    if (options.signal.aborted) throw error;
    throw new IllustrationError('NOVELAI_RESPONSE_INVALID');
  }
  if (!object(body)) throw new IllustrationError('NOVELAI_RESPONSE_INVALID');
  const count = (value: unknown) =>
    Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
  const steps = object(body.trainingStepsLeft) ? body.trainingStepsLeft : {};
  const subscription = count(steps.fixedTrainingStepsLeft);
  const purchased = count(steps.purchasedTrainingSteps);
  const usage = object(body.usage) ? body.usage : {};
  const percent = Number.isFinite(usage.percent) ? Number(usage.percent) : null;
  return {
    tier: Number.isInteger(body.tier) ? (NOVELAI_TIERS[Number(body.tier)] ?? null) : null,
    active: body.active === true,
    anlas:
      subscription === null && purchased === null
        ? null
        : { subscription: subscription ?? 0, purchased: purchased ?? 0 },
    usage:
      percent === null
        ? null
        : {
            percent: usage.isNegative === true ? -Math.abs(percent) : percent,
            secondsUntilNextPercent: count(usage.timeUntilNextPercent) ?? 0,
          },
  };
}

export type NovelAIPrompt = {
  prompt: string;
  negativePrompt: string;
  characters?: NovelAICharacterPrompt[];
  referenceImages?: Buffer[];
};
// https://docs.novelai.net/en/image/multiplecharacters (2026-11-20): V4 and V4.5 place
// characters on a 5x5 grid; V5 positions freely, sent at 0.01 precision.
const GRID = [0.1, 0.3, 0.5, 0.7, 0.9];
// https://image.novelai.net/docs/doc.json (2026-11-20): director_reference_strength_values
// takes values from 0 to 1.
const REFERENCE_STRENGTH = 0.6;
function center(model: string, value: number): number {
  if (model.startsWith('nai-diffusion-5'))
    return Math.round(Math.min(0.9, Math.max(0.1, value)) * 100) / 100;
  return GRID.reduce((best, step) =>
    Math.abs(step - value) < Math.abs(best - value) ? step : best
  );
}
function captions(
  model: string,
  characters: NovelAICharacterPrompt[],
  text: 'prompt' | 'negativePrompt'
) {
  return characters.map((character) => ({
    char_caption: character[text],
    centers: [
      character.position
        ? { x: center(model, character.position.x), y: center(model, character.position.y) }
        : { x: 0.5, y: 0.5 },
    ],
  }));
}

export function novelAIImageRequest(
  settings: NovelAIRenderSettings,
  prompt: NovelAIPrompt,
  seed: number
) {
  const characters = prompt.characters ?? [];
  const references = prompt.referenceImages ?? [];
  return {
    input: prompt.prompt,
    model: settings.model,
    action: 'generate',
    parameters: {
      params_version: 3,
      width: settings.width,
      height: settings.height,
      scale: settings.scale,
      sampler: settings.sampler,
      steps: settings.steps,
      seed,
      n_samples: 1,
      ucPreset: 0,
      qualityToggle: true,
      noise_schedule: 'karras',
      cfg_rescale: 0,
      dynamic_thresholding: false,
      legacy: false,
      add_original_image: false,
      prefer_brownian: true,
      deliberate_euler_ancestral_bug: false,
      negative_prompt: prompt.negativePrompt,
      v4_prompt: {
        caption: {
          base_caption: prompt.prompt,
          char_captions: captions(settings.model, characters, 'prompt'),
        },
        use_coords: characters.length > 0 && characters.every((character) => character.position),
        use_order: true,
      },
      v4_negative_prompt: {
        caption: {
          base_caption: prompt.negativePrompt,
          char_captions: captions(settings.model, characters, 'negativePrompt'),
        },
        legacy_uc: false,
      },
      ...(references.length
        ? {
            director_reference_images: references.map((image) => image.toString('base64')),
            director_reference_descriptions: references.map(() => ({
              caption: { base_caption: 'character', char_captions: [] },
              legacy_uc: false,
            })),
            director_reference_information_extracted: references.map(() => 1),
            director_reference_strength_values: references.map(() => REFERENCE_STRENGTH),
            director_reference_secondary_strength_values: references.map(() => 0),
          }
        : {}),
    },
  };
}

function imagesFrom(bytes: Buffer): NovelAIImage[] {
  const direct = detectImageMime(bytes);
  if (direct) return isValidIllustrationImage(bytes, direct) ? [{ mime: direct, bytes }] : [];
  let members: Map<string, () => Buffer>;
  try {
    members = readCardZip(bytes.length, (offset, length) =>
      bytes.subarray(offset, offset + length)
    );
  } catch {
    throw new IllustrationError('NOVELAI_RESPONSE_INVALID');
  }
  const images: NovelAIImage[] = [];
  for (const [name, read] of [...members].sort(([a], [b]) => a.localeCompare(b))) {
    if (!/\.(png|webp|jpe?g)$/iu.test(name)) continue;
    let image: Buffer;
    try {
      image = read();
    } catch {
      throw new IllustrationError('NOVELAI_RESPONSE_INVALID');
    }
    const mime = detectImageMime(image);
    if (isValidIllustrationImage(image, mime)) images.push({ mime, bytes: image });
  }
  return images;
}

// https://image.novelai.net/docs/doc.json (2026-11-20): POST /ai/generate-image responds with
// the images (image, index, seed) and no job id, and no route looks a generation up later.
export async function generateWithNovelAI(
  settings: NovelAIRenderSettings,
  prompt: NovelAIPrompt,
  options: NovelAIRequestOptions
): Promise<{ images: NovelAIImage[]; seed: number }> {
  const seed = randomInt(0, 4_294_967_295);
  const deadline = AbortSignal.timeout(settings.timeoutMs);
  const execution = { ...options, signal: AbortSignal.any([options.signal, deadline]) };
  try {
    const response = await send(
      '/ai/generate-image',
      execution,
      novelAIImageRequest(settings, prompt, seed)
    );
    if (!response.ok) throw await rejection(response, execution.signal);
    let bytes: Buffer;
    try {
      bytes = await readProviderBody(response, execution.signal, ILLUSTRATION_MAX_IMAGE_BYTES);
    } catch (error) {
      if (error instanceof ProviderBodyLimitError)
        throw new IllustrationError('NOVELAI_RESPONSE_INVALID');
      throw error;
    }
    const images = imagesFrom(bytes);
    if (!images.length) throw new IllustrationError('NOVELAI_IMAGE_INVALID');
    return { images: images.slice(0, 1), seed };
  } catch (error) {
    if (options.signal.aborted) throw new IllustrationError('ILLUSTRATION_CANCELLED');
    if (deadline.aborted) throw new IllustrationError('NOVELAI_RESULT_UNCERTAIN');
    if (error instanceof IllustrationError) throw error;
    throw new IllustrationError('NOVELAI_RESULT_UNCERTAIN');
  }
}
