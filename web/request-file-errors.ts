import ko from './locales/ko.js';
import { uiMessage, type MessageKey, type UiMessage } from './ui-message.js';

export function requestFileError(error: string | null | undefined): UiMessage | undefined {
  const key = `errors.${error}`;
  return error && /^(?:REQUEST_FILES?_|FILE_)/u.test(error) && Object.hasOwn(ko, key)
    ? uiMessage(key as MessageKey)
    : undefined;
}
