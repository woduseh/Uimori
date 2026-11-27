export type RequestImage = {
  hash: string;
  mime: 'image/webp';
  name: string;
  width: number;
  height: number;
  input: { hash: string; width: number; height: number };
};

export type RequestImageUpload = { uploadId: string; sha256: string; name: string };
export type RequestImagePreview = Pick<RequestImage, 'name' | 'width' | 'height'>;

export type RequestImagePart = { type: 'image'; image: RequestImage };

export const REQUEST_IMAGE_MAX_COUNT = 8;
export const STORED_REQUEST_IMAGE_ERRORS = [
  'IMAGE_INPUT_UNSUPPORTED_MODEL',
  'IMAGE_INPUT_UNSUPPORTED_PROTOCOL',
  'IMAGE_INPUT_UNAVAILABLE',
  'IMAGE_REQUEST_TOO_LARGE',
  'RISU_NATIVE_REQUEST_IMAGE_IDENTITY',
] as const;
export type StoredRequestImageError = (typeof STORED_REQUEST_IMAGE_ERRORS)[number];
const storedRequestImageErrors: ReadonlySet<string> = new Set(STORED_REQUEST_IMAGE_ERRORS);
export const isStoredRequestImageError = (value: string): value is StoredRequestImageError =>
  storedRequestImageErrors.has(value);

export type ResolvedRequestImage = {
  mime: 'image/webp';
  base64: string;
  width: number;
  height: number;
};

const hashPattern = /^[a-f0-9]{64}$/u;
const invalid = (): never => {
  throw new Error('REQUEST_IMAGES_INVALID');
};
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  if (Object.keys(value).some((key) => !keys.includes(key))) return invalid();
  return value as Record<string, unknown>;
}
function dimension(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 16383) return invalid();
  return Number(value);
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !hashPattern.test(value)) return invalid();
  return value;
}

export function validateRequestImage(value: unknown): RequestImage {
  const image = record(value, ['hash', 'mime', 'name', 'width', 'height', 'input']);
  if (
    image.mime !== 'image/webp' ||
    typeof image.name !== 'string' ||
    !image.name.length ||
    image.name.length > 300
  )
    return invalid();
  const input = record(image.input, ['hash', 'width', 'height']);
  return {
    hash: hash(image.hash),
    mime: 'image/webp',
    name: image.name,
    width: dimension(image.width),
    height: dimension(image.height),
    input: {
      hash: hash(input.hash),
      width: dimension(input.width),
      height: dimension(input.height),
    },
  };
}

export function validateRequestImages(value: unknown): RequestImage[] {
  if (!Array.isArray(value) || value.length > REQUEST_IMAGE_MAX_COUNT) return invalid();
  return value.map(validateRequestImage);
}
