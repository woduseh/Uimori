import { t } from './i18n.js';
import { messages } from './locales/errors.js';

export const requestFileErrors: Record<string, string> = Object.fromEntries(
  Object.entries(messages)
    .filter(([key]) => /^errors\.(?:REQUEST_FILES?_|FILE_)/u.test(key))
    .map(([key, value]) => [key.slice('errors.'.length), value.ko])
);

export function requestFileError(error: string | null | undefined): string | undefined {
  return error && Object.hasOwn(requestFileErrors, error) ? t(`errors.${error}`) : undefined;
}
