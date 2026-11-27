import { t } from './i18n.js';
import ko from './locales/ko.js';

export function requestFileError(error: string | null | undefined): string | undefined {
  return error && /^(?:REQUEST_FILES?_|FILE_)/u.test(error) && Object.hasOwn(ko, `errors.${error}`)
    ? t(`errors.${error}`)
    : undefined;
}
