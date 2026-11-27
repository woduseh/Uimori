import type { MessageKey } from './locales/index.js';
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
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'legacy'; readonly value: string };

export function uiMessage(key: MessageKey, values?: UiMessageValues): UiMessage {
  return values ? { kind: 'key', key, values } : { kind: 'key', key };
}

export function uiText(text: string): UiMessage {
  return { kind: 'text', text };
}

export function isUiMessage(value: unknown): value is UiMessage {
  if (typeof value !== 'object' || value === null) return false;
  const { kind } = value as { kind?: unknown };
  return kind === 'key' || kind === 'text' || kind === 'legacy';
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

export function sameUiMessage(left: UiMessage | null, right: UiMessage | null): boolean {
  return left === right || (!!left && !!right && JSON.stringify(left) === JSON.stringify(right));
}

export function legacyUiMessage(value: string | null | undefined): UiMessage | null {
  return value ? { kind: 'legacy', value } : null;
}

export function formatUiMessage(value: UiMessage, locale: UiLocale = getLocale()): string {
  if (value.kind === 'text') return value.text;
  if (value.kind === 'legacy') return translateMessage(value.value, locale);
  const nested = (item: UiMessage | readonly UiMessage[]): string =>
    isUiMessage(item)
      ? formatUiMessage(item, locale)
      : item.map((part) => formatUiMessage(part, locale)).join('');
  return formatMessage(value.key, locale, value.values && mapValues(value.values, nested));
}

export function legacyMessageString(value: UiMessage): string {
  if (value.kind === 'text') return value.text;
  if (value.kind === 'legacy') return value.value;
  const nested = (item: UiMessage | readonly UiMessage[]) =>
    messageRef(
      isUiMessage(item) ? legacyMessageString(item) : item.map(legacyMessageString).join('')
    );
  return descriptor(value.key, value.values && (mapValues(value.values, nested) as MessageValues));
}

export class UiError extends Error {
  readonly uiMessage: UiMessage;
  constructor(uiMessage: UiMessage, options?: ErrorOptions) {
    super(legacyMessageString(uiMessage), options);
    this.uiMessage = uiMessage;
    this.name = 'UiError';
  }
}
