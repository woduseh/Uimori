import { appErrorTakesParams, isAppErrorCode } from '#contracts';
import { t } from './i18n.js';
import { isStoredRequestImageError } from '../core/request-images.js';

export function requestImageError(error: string | null | undefined): string | undefined {
  if (!error) return undefined;
  if (isStoredRequestImageError(error)) return t(`errors.${error}`);
  return error.startsWith('REQUEST_IMAGE_') && isAppErrorCode(error) && !appErrorTakesParams(error)
    ? t(`errors.${error}`)
    : undefined;
}
