import { UiError, uiMessage, type MessageKey, type UiMessage } from './ui-message.js';

export function parseJsonInput(
  text: string,
  invalid: MessageKey | UiMessage = 'errors.invalidJson'
): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new UiError(typeof invalid === 'string' ? uiMessage(invalid) : invalid, { cause });
  }
}
