import { useSyncExternalStore } from 'react';
import { IntlMessageFormat } from 'intl-messageformat';
import { messages } from './locales/index.js';

export const UI_LOCALES = ['ko', 'en', 'ja', 'zh'] as const;
export type UiLocale = (typeof UI_LOCALES)[number];
export type MessageReference = { readonly uiMessage: string };
export type MessageValues = Record<string, string | number | boolean | Date | MessageReference>;
export const UI_LANGUAGE_KEY = 'uimori:ui-language';
export const localeChangedEvent = 'uimori:ui-language-changed';
const intlLocales = { ko: 'ko-KR', en: 'en-US', ja: 'ja-JP', zh: 'zh-CN' };
export function supportedLocale(value: unknown): UiLocale {
  return UI_LOCALES.includes(value as UiLocale) ? (value as UiLocale) : 'ko';
}
function readLocale(): UiLocale {
  try {
    return supportedLocale(localStorage.getItem(UI_LANGUAGE_KEY));
  } catch {
    return 'ko';
  }
}
let current = readLocale();
const listeners = new Set<() => void>();
const formatted = new Map<string, { key: string; values?: MessageValues } | (() => string)>();
const sources = new Map<string, string>();
const normalized = (value: string) => value.replace(/\s+/gu, ' ').trim();
for (const [key, entry] of Object.entries(messages)) {
  for (const value of [entry.ko]) {
    if (typeof value === 'string' && !value.includes('{')) {
      sources.set(value, key);
      sources.set(normalized(value), key);
    }
  }
}
const cache = new Map<string, IntlMessageFormat>();
export const getLocale = (): UiLocale => current;
export const getIntlLocale = (): string => intlLocales[current];
function publish(locale: UiLocale) {
  current = locale;
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
  for (const listener of listeners) listener();
  if (typeof window !== 'undefined')
    window.dispatchEvent(new CustomEvent(localeChangedEvent, { detail: locale }));
}
/** Locale is browser presentation state. It never writes application settings or remounts editors. */
export function setLocale(value: UiLocale): boolean {
  const next = supportedLocale(value);
  let persisted = true;
  try {
    localStorage.setItem(UI_LANGUAGE_KEY, next);
  } catch {
    persisted = false;
  }
  publish(next);
  return persisted;
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
if (typeof window !== 'undefined') {
  if (typeof document !== 'undefined') document.documentElement.lang = current;
  window.addEventListener('storage', (event) => {
    if (event.key === UI_LANGUAGE_KEY || event.key === null) publish(readLocale());
  });
}
export function formatMessage(key: string, locale: UiLocale, values?: MessageValues): string {
  const entry = messages[key];
  if (!entry) return key;
  const pattern = entry[locale] ?? entry.ko;
  const identity = `${locale}:${key}:${pattern}`;
  let formatter = cache.get(identity);
  if (!formatter) {
    formatter = new IntlMessageFormat(pattern, intlLocales[locale], undefined, { ignoreTag: true });
    cache.set(identity, formatter);
  }
  const resolved =
    values &&
    Object.fromEntries(
      Object.entries(values).map(([name, value]) => [
        name,
        typeof value === 'object' && !(value instanceof Date)
          ? value.uiMessage.startsWith(messagePrefix) || formatted.has(value.uiMessage)
            ? translateMessage(value.uiMessage)
            : value.uiMessage
          : value,
      ])
    );
  return String(formatter.format(resolved));
}
export function t(key: string, values?: MessageValues): string {
  return formatMessage(key, current, values);
}
const messagePrefix = '\u001fui:';
/** A retained UI notice carries its identity, never a translated string used as an identity.
 * This value belongs only in presentation state; domain data and wire errors stay unchanged. */
export function message(key: string, values?: MessageValues): string {
  return (
    messagePrefix +
    JSON.stringify({
      key,
      values:
        values &&
        Object.fromEntries(
          Object.entries(values).map(([name, value]) => [
            name,
            value instanceof Date ? { uiDate: value.getTime() } : value,
          ])
        ),
    })
  );
}
/** Mark only app-owned nested errors/notices. Names, manuscripts and other arguments stay literal. */
export function messageRef(value: string): MessageReference {
  return { uiMessage: value };
}
/** Preserve a legacy wire/error string while attaching its presentation contract. */
export function registerMessage(
  value: string,
  key: string | (() => string),
  values?: MessageValues
): void {
  formatted.set(value, typeof key === 'function' ? key : { key, values });
}
/** Existing validation helpers retain their Korean Error.message contract. */
export function legacyMessage(key: string, values?: MessageValues): string {
  const value = formatMessage(key, 'ko', values);
  registerMessage(value, key, values);
  return value;
}
/** Re-express retained app notices/errors; callers must not pass user-authored content. */
export function translateMessage(value: string): string {
  if (value.startsWith(messagePrefix)) {
    try {
      const descriptor = JSON.parse(value.slice(messagePrefix.length)) as {
        key: string;
        values?: Record<string, string | number | boolean | MessageReference | { uiDate: number }>;
      };
      if (
        !descriptor ||
        typeof descriptor.key !== 'string' ||
        !Object.hasOwn(messages, descriptor.key)
      )
        return value;
      const values =
        descriptor.values &&
        Object.fromEntries(
          Object.entries(descriptor.values).map(([name, item]) => [
            name,
            typeof item === 'object' && 'uiDate' in item ? new Date(item.uiDate) : item,
          ])
        );
      return t(descriptor.key, values);
    } catch {
      // An external diagnostic may contain arbitrary bytes; it is not an internal descriptor.
      return value;
    }
  }
  const retained = formatted.get(value);
  if (retained)
    return typeof retained === 'function' ? retained() : t(retained.key, retained.values);
  const key = sources.get(value) ?? sources.get(normalized(value));
  return key ? t(key) : value;
}
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(getIntlLocale(), options).format(value);
}
export function formatDate(
  value: string | number | Date,
  options?: Intl.DateTimeFormatOptions
): string {
  const date = new Date(value);
  // Legacy pending requests can have no timestamp. An absent label must not crash the reader.
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat(
    getIntlLocale(),
    options ?? {
      dateStyle: 'medium',
      timeStyle: 'short',
    }
  ).format(date);
}
export function useI18n() {
  const locale = useSyncExternalStore(subscribe, getLocale, () => 'ko' as UiLocale);
  return { t, locale, setLocale };
}
