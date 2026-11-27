import { useSyncExternalStore } from 'react';
import { IntlMessageFormat } from 'intl-messageformat';
import ko from './locales/ko.js';
import type { MessageKey } from './locales/index.js';

import { supportedLocale, type UiLocale } from '../core/ui-locale.js';
import { readOptionalStorage, writeOptionalStorage } from './optional-storage.js';
import { storageKeys } from './storage-keys.js';
export { supportedLocale, UI_LOCALES, type UiLocale } from '../core/ui-locale.js';
export type MessageValues = Record<string, string | number | boolean | Date>;
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
  return String(formatter.format(values));
}
export function t(key: string, values?: MessageValues): string {
  return formatMessage(key, current, values);
}
export function translateStoredCode<Code extends string>(
  value: string,
  keys: Record<Code, MessageKey>
): string {
  return Object.hasOwn(keys, value) ? t(keys[value as Code]) : value;
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
