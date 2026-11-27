import { appErrorTakesParams, isAppErrorCode } from '#contracts';
import { t } from './i18n.js';

const storedRequestImageErrors = new Set([
  'IMAGE_INPUT_UNSUPPORTED_MODEL',
  'IMAGE_INPUT_UNSUPPORTED_PROTOCOL',
  'IMAGE_INPUT_UNAVAILABLE',
  'IMAGE_REQUEST_TOO_LARGE',
  'RISU_NATIVE_REQUEST_IMAGE_IDENTITY',
]);

export function requestImageError(error: string | null | undefined): string | undefined {
  if (!error) return undefined;
  if (storedRequestImageErrors.has(error)) return t(`errors.${error}`);
  return error.startsWith('REQUEST_IMAGE_') && isAppErrorCode(error) && !appErrorTakesParams(error)
    ? t(`errors.${error}`)
    : undefined;
}
