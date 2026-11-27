import type { MessageKey } from './locales/index.js';
import ko from './locales/ko.js';
import {
  formatMessage,
  getLocale,
  message as descriptor,
  messageRef,
  translateMessage,
  type MessageValues,
  type UiLocale,
} from './i18n.js';

export type { MessageKey };
export type UiMessageValue = string | number | boolean | Date | UiMessage | readonly UiMessage[];
export type UiMessageValues = Readonly<Record<string, UiMessageValue>>;
export type UiMessage =
  | { readonly kind: 'key'; readonly key: MessageKey; readonly values?: UiMessageValues }
  | { readonly kind: 'text'; readonly text: string };
export type DisplayMessage = UiMessage | string;

export function uiMessage(key: MessageKey, values?: UiMessageValues): UiMessage {
  return values ? { kind: 'key', key, values } : { kind: 'key', key };
}

export function uiText(text: string): UiMessage {
  return { kind: 'text', text };
}

export function isUiMessage(value: unknown): value is UiMessage {
  if (typeof value !== 'object' || value === null) return false;
  const { kind } = value as { kind?: unknown };
  return kind === 'key' || kind === 'text';
}

function mapValues<T>(
  values: UiMessageValues,
  nested: (value: UiMessage | readonly UiMessage[]) => T
): Record<string, string | number | boolean | Date | T> {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      Array.isArray(value) || isUiMessage(value)
        ? nested(value as UiMessage | readonly UiMessage[])
        : (value as string | number | boolean | Date),
    ])
  );
}

export function formatUiMessage(value: UiMessage, locale: UiLocale = getLocale()): string {
  if (value.kind === 'text') return value.text;
  const nested = (item: UiMessage | readonly UiMessage[]): string =>
    isUiMessage(item)
      ? formatUiMessage(item, locale)
      : item.map((part) => formatUiMessage(part, locale)).join('');
  return formatMessage(value.key, locale, value.values && mapValues(value.values, nested));
}

export function displayMessage(value: DisplayMessage): string {
  return typeof value === 'string' ? translateMessage(value) : formatUiMessage(value);
}

export function legacyMessageString(value: UiMessage): string {
  if (value.kind === 'text') return value.text;
  const nested = (item: UiMessage | readonly UiMessage[]) =>
    messageRef(
      isUiMessage(item) ? legacyMessageString(item) : item.map(legacyMessageString).join('')
    );
  return descriptor(value.key, value.values && (mapValues(value.values, nested) as MessageValues));
}

const legacyPrefix = '\u001fui:';
const legacyEnd = '\u001e';
type LegacyValue = string | number | boolean | { uiDate: number } | { uiMessage: string };

function parseLegacyValue(value: LegacyValue): UiMessageValue | null {
  if (typeof value !== 'object' || value === null) return value;
  if ('uiDate' in value) return new Date(value.uiDate);
  if (typeof value.uiMessage !== 'string') return null;
  return value.uiMessage.includes(legacyPrefix)
    ? parseLegacyMessage(value.uiMessage)
    : uiText(value.uiMessage);
}

export function parseLegacyMessage(text: string): UiMessage | null {
  if (
    !text.startsWith(legacyPrefix) ||
    !text.endsWith(legacyEnd) ||
    text.indexOf(legacyEnd) !== text.length - 1
  )
    return null;
  try {
    const parsed = JSON.parse(text.slice(legacyPrefix.length, -1)) as {
      key?: unknown;
      values?: Record<string, LegacyValue>;
    };
    if (typeof parsed?.key !== 'string' || !Object.hasOwn(ko, parsed.key)) return null;
    const key = parsed.key as MessageKey;
    if (!parsed.values) return uiMessage(key);
    const values: Record<string, UiMessageValue> = {};
    for (const [name, value] of Object.entries(parsed.values)) {
      const item = parseLegacyValue(value);
      if (item === null) return null;
      values[name] = item;
    }
    return uiMessage(key, values);
  } catch {
    return null;
  }
}

export function legacyErrorMessage(cause: unknown): UiMessage | null {
  return cause instanceof Error ? parseLegacyMessage(cause.message) : null;
}

export class UiError extends Error {
  readonly uiMessage: UiMessage;
  constructor(uiMessage: UiMessage, options?: ErrorOptions) {
    super(legacyMessageString(uiMessage), options);
    this.uiMessage = uiMessage;
    this.name = 'UiError';
  }
}
