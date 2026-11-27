import { tryParseJson } from './json.js';
import { UiError, uiMessage, type MessageKey, type UiMessage } from './ui-message.js';

type InvalidJson = MessageKey | UiMessage;

const unreadable = Symbol('unreadable JSON');

function invalidJson(invalid: InvalidJson) {
  return new UiError(typeof invalid === 'string' ? uiMessage(invalid) : invalid);
}

export function parseJsonInput(text: string, invalid: InvalidJson = 'errors.invalidJson'): unknown {
  const value = tryParseJson(text, unreadable);
  if (value === unreadable) throw invalidJson(invalid);
  return value;
}

export async function readJsonFile(
  file: Blob,
  invalid: InvalidJson = 'errors.invalidJson'
): Promise<unknown> {
  const text = await file.text().catch(() => {
    throw invalidJson(invalid);
  });
  return parseJsonInput(text, invalid);
}
