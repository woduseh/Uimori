import { tryParseJson } from './json.js';
import { useSyncExternalStore } from 'react';
import { IntlMessageFormat } from 'intl-messageformat';
import ko from './locales/ko.js';

import { supportedLocale, type UiLocale } from '../core/ui-locale.js';
import { readOptionalStorage, writeOptionalStorage } from './optional-storage.js';
import { storageKeys } from './storage-keys.js';
export { supportedLocale, UI_LOCALES, type UiLocale } from '../core/ui-locale.js';
export type MessageReference = { readonly uiMessage: string };
export type MessageValues = Record<string, string | number | boolean | Date | MessageReference>;
const UI_LANGUAGE_KEY = storageKeys.uiLanguage;
export const localeChangedEvent = 'uimori:ui-language-changed';
const intlLocales = { ko: 'ko-KR', en: 'en-US', ja: 'ja-JP', zh: 'zh-CN' };
function readLocale(): UiLocale {
  return supportedLocale(readOptionalStorage('local', UI_LANGUAGE_KEY));
}
const catalogs: Partial<Record<UiLocale, Record<string, string>>> = { ko };
const catalogLoaders = {
  en: () => import('./locales/en.js'),
  ja: () => import('./locales/ja.js'),
  zh: () => import('./locales/zh.js'),
};
export async function loadLocale(locale: UiLocale): Promise<void> {
  if (locale !== 'ko') catalogs[locale] ??= (await catalogLoaders[locale]()).default;
}
let current = readLocale();
let requested = current;
const listeners = new Set<() => void>();
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
function applyLocale(locale: UiLocale) {
  requested = locale;
  if (catalogs[locale]) publish(locale);
  else
    void loadLocale(locale).then(() => {
      if (requested === locale) publish(locale);
    });
}
export function loadInitialLocale(): Promise<void> {
  return loadLocale(current).catch(() => applyLocale('ko'));
}
export function setLocale(value: UiLocale): boolean {
  const next = supportedLocale(value);
  const persisted = writeOptionalStorage('local', UI_LANGUAGE_KEY, next);
  applyLocale(next);
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
    if (event.key === UI_LANGUAGE_KEY || event.key === null) applyLocale(readLocale());
  });
}
export function formatMessage(key: string, locale: UiLocale, values?: MessageValues): string {
  if (!Object.hasOwn(ko, key)) return key;
  const pattern = catalogs[locale]?.[key] ?? ko[key];
  if (!/[{}']/u.test(pattern)) return pattern;
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
        typeof value === 'object' && value !== null && !(value instanceof Date)
          ? decodeMessages(value.uiMessage, locale)
          : value,
      ])
    );
  return String(formatter.format(resolved));
}
export function t(key: string, values?: MessageValues): string {
  return formatMessage(key, current, values);
}
const messagePrefix = '\u001fui:';
const messageEnd = '\u001e';
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
    }) +
    messageEnd
  );
}
export function messageRef(value: string): MessageReference {
  return { uiMessage: value };
}
function decodeDescriptor(json: string, locale: UiLocale): string | null {
  try {
    const descriptor = tryParseJson(json, null) as {
      key: string;
      values?: Record<string, string | number | boolean | MessageReference | { uiDate: number }>;
    } | null;
    if (!descriptor || typeof descriptor.key !== 'string' || !Object.hasOwn(ko, descriptor.key))
      return null;
    const values =
      descriptor.values &&
      Object.fromEntries(
        Object.entries(descriptor.values).map(([name, item]) => [
          name,
          typeof item === 'object' && item !== null && 'uiDate' in item
            ? new Date(item.uiDate)
            : item,
        ])
      );
    return formatMessage(descriptor.key, locale, values);
  } catch {
    return null;
  }
}
function decodeMessages(value: string, locale: UiLocale = current): string {
  let decoded = '';
  let index = 0;
  for (;;) {
    const start = value.indexOf(messagePrefix, index);
    if (start < 0) return decoded + value.slice(index);
    const next = value.indexOf(messagePrefix, start + messagePrefix.length);
    const end = value.indexOf(messageEnd, start);
    const text =
      end < 0 || (next >= 0 && next < end)
        ? null
        : decodeDescriptor(value.slice(start + messagePrefix.length, end), locale);
    if (text === null) {
      const resume = next < 0 ? value.length : next;
      decoded += value.slice(index, resume);
      index = resume;
      continue;
    }
    decoded += value.slice(index, start) + text;
    index = end + 1;
  }
}
export function translateStoredCode<Code extends string>(
  value: string,
  keys: Record<Code, string>
): string {
  return Object.hasOwn(keys, value) ? t(keys[value as Code]) : value;
}
export function translateMessage(value: string): string {
  return value.includes(messagePrefix) ? decodeMessages(value) : value;
}
const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();
function cachedFormat<Format>(
  formats: Map<string, Format>,
  options: object | undefined,
  create: (locale: string) => Format
): Format {
  const locale = getIntlLocale();
  const identity = `${locale}:${JSON.stringify(options)}`;
  let format = formats.get(identity);
  if (!format) {
    format = create(locale);
    formats.set(identity, format);
  }
  return format;
}
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return cachedFormat(
    numberFormats,
    options,
    (locale) => new Intl.NumberFormat(locale, options)
  ).format(value);
}
export function formatDate(
  value: string | number | Date,
  options?: Intl.DateTimeFormatOptions
): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const resolved = options ?? { dateStyle: 'medium', timeStyle: 'short' };
  return cachedFormat(
    dateFormats,
    resolved,
    (locale) => new Intl.DateTimeFormat(locale, resolved)
  ).format(date);
}
export function useI18n() {
  const locale = useSyncExternalStore(subscribe, getLocale, () => 'ko' as UiLocale);
  return { t, locale, setLocale };
}
