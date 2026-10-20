import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { IntlMessageFormat } from 'intl-messageformat';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { messages } from '../web/locales/index.js';

const { scanI18nSource, messageArguments, checkI18n } = await import(
  new URL('../scripts/check-i18n.mjs', import.meta.url).href
);

let storage: Map<string, string>;
beforeEach(() => {
  vi.resetModules();
  storage = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('UI locale presentation boundary', () => {
  test('Korean remains the default and unsupported stored values fall back to Korean', async () => {
    vi.stubGlobal('navigator', { language: 'en-US', languages: ['en-US', 'ja'] });
    const initial = await import('../web/i18n.js');
    expect(initial.getLocale()).toBe('ko');
    storage.set('uimori:ui-language', 'fr');
    vi.resetModules();
    const unsupported = await import('../web/i18n.js');
    expect(unsupported.getLocale()).toBe('ko');
    expect(unsupported.supportedLocale('en-US')).toBe('ko');
  });

  test.each(['ko', 'en', 'ja', 'zh'] as const)(
    'explicit %s survives a fresh module load and writes only the UI preference',
    async (locale) => {
      storage.set('uimori:reading-language', 'original');
      storage.set('uimori:input-translation-language', 'ja');
      const before = [...storage];
      const runtime = await import('../web/i18n.js');
      expect(runtime.setLocale(locale)).toBe(true);
      expect([...storage].filter(([key]) => key !== 'uimori:ui-language')).toEqual(before);
      vi.resetModules();
      expect((await import('../web/i18n.js')).getLocale()).toBe(locale);
    }
  );

  test('blocked browser storage still permits the current session language and reports persistence failure', async () => {
    vi.stubGlobal('localStorage', {
      getItem() {
        throw new DOMException('Blocked', 'SecurityError');
      },
      setItem() {
        throw new DOMException('Blocked', 'SecurityError');
      },
    });
    const runtime = await import('../web/i18n.js');
    expect(runtime.getLocale()).toBe('ko');
    expect(runtime.setLocale('en')).toBe(false);
    expect(runtime.getLocale()).toBe('en');
  });

  test('retained app notices change language while unknown messages remain verbatim', async () => {
    const { message, setLocale, translateMessage, formatMessage } = await import('../web/i18n.js');
    const retained = message('common.uiLanguage');
    expect(translateMessage(retained)).toBe('화면 언어');
    setLocale('en');
    expect(translateMessage(retained)).toBe('Interface language');
    expect(translateMessage('사용자 원고: 그대로 남아야 해요')).toBe(
      '사용자 원고: 그대로 남아야 해요'
    );
    expect(formatMessage('unknown.explicit.key', 'ja')).toBe('unknown.explicit.key');
  });

  test('retained message identity survives identical Japanese translations and leaves literal user arguments alone', async () => {
    const { message, messageRef, setLocale, t, translateMessage } = await import('../web/i18n.js');
    setLocale('ja');
    const details = message('outside.details');
    expect(translateMessage(details)).toBe('詳細');
    expect(t('providers.m285')).toBe('詳細');
    const literalTitle = message('shared.deleteQuestion', { title: '저장' });
    const nestedError = message('chatsettings.draftError', {
      error: messageRef(message('shared.loadFailed')),
    });
    setLocale('en');
    expect(translateMessage(details)).toBe('Details');
    expect(translateMessage(literalTitle)).toBe('Delete 저장?');
    expect(translateMessage(nestedError)).toBe('Could not load. Your draft is preserved.');
    expect(t('providers.m285')).toBe('Advanced');
  });

  test('a retained Date argument roundtrips as a Date for ICU formatting', async () => {
    const { message, setLocale, translateMessage } = await import('../web/i18n.js');
    const { messages: currentMessages } = await import('../web/locales/index.js');
    const pattern = '{instant, date, short}';
    currentMessages['test.dateRoundtrip'] = { ko: pattern, en: pattern, ja: pattern, zh: pattern };
    try {
      const retained = message('test.dateRoundtrip', { instant: new Date(2026, 0, 2, 12) });
      setLocale('en');
      expect(translateMessage(retained)).toBe('1/2/26');
      setLocale('ja');
      expect(translateMessage(retained)).toBe('26/1/2');
    } finally {
      Reflect.deleteProperty(currentMessages, 'test.dateRoundtrip');
    }
  });

  test('legacy validation errors retain their Korean message while their UI and nested notice follow locale', async () => {
    const { legacyMessage, message, messageRef, setLocale, translateMessage } = await import(
      '../web/i18n.js'
    );
    setLocale('en');
    const error = new Error(legacyMessage('shared.loadFailed'));
    expect(error.message).toBe('불러오지 못했어요.');
    expect(translateMessage(error.message)).toBe('Could not load.');
    const notice = message('chatsettings.draftError', { error: messageRef(error.message) });
    expect(translateMessage(notice)).toBe('Could not load. Your draft is preserved.');
    setLocale('ja');
    expect(error.message).toBe('불러오지 못했어요.');
    expect(translateMessage(notice)).toBe(
      '読み込めませんでした。 入力した下書きは保持しています。'
    );
  });

  test.each([
    '\u001fui:broken-json',
    '\u001fui:null',
    '\u001fui:{"key":"missing.external.key"}',
    '\u001fui:{"key":"shared.close","values":{"title":null}}',
    '\u001fui:{"key":"outside.activeWork"}',
  ])(
    'external diagnostic bytes resembling a malformed message descriptor remain readable: %s',
    async (diagnostic) => {
      const { setLocale, translateMessage } = await import('../web/i18n.js');
      setLocale('en');
      expect(translateMessage(diagnostic)).toBe(diagnostic);
    }
  );

  test('ICU interpolates full sentences, plural branches and missing locale fallback', async () => {
    const { formatMessage } = await import('../web/i18n.js');
    expect(formatMessage('outside.activeWork', 'en', { count: 1 })).toBe(
      'There is 1 ongoing task.'
    );
    expect(formatMessage('outside.activeWork', 'en', { count: 2 })).toBe(
      'There are 2 ongoing tasks.'
    );
    expect(formatMessage('outside.activeWork', 'ko', { count: 2 })).toBe(
      '진행 중인 작업이 2개 있어요.'
    );
    expect(() => formatMessage('outside.activeWork', 'en')).toThrow();
    const { messages: currentMessages } = await import('../web/locales/index.js');
    const saved = currentMessages['common.uiLanguage'].ja;
    Reflect.deleteProperty(currentMessages['common.uiLanguage'], 'ja');
    try {
      expect(formatMessage('common.uiLanguage', 'ja')).toBe('화면 언어');
    } finally {
      currentMessages['common.uiLanguage'].ja = saved;
    }
  });

  test('numbers and dates follow UI locale without changing their values', async () => {
    const runtime = await import('../web/i18n.js');
    const instant = new Date('2026-01-02T03:04:05Z');
    const options: Intl.DateTimeFormatOptions = {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    };
    runtime.setLocale('en');
    expect(runtime.formatNumber(1234567.5)).toBe('1,234,567.5');
    expect(runtime.formatDate(instant, options)).toBe('January 2, 2026');
    runtime.setLocale('ja');
    expect(runtime.formatDate(instant, options)).toBe('2026年1月2日');
    expect(instant.toISOString()).toBe('2026-01-02T03:04:05.000Z');
  });

  test('legacy pending requests without a timestamp omit the date instead of crashing', async () => {
    const runtime = await import('../web/i18n.js');
    for (const locale of ['ko', 'en', 'ja', 'zh'] as const) {
      runtime.setLocale(locale);
      expect(runtime.formatDate(new Date(Number.NaN))).toBe('');
      expect(runtime.formatDate('')).toBe('');
    }
  });

  test('retained job errors format the complete title and nested error after language changes', async () => {
    const runtime = await import('../web/i18n.js');
    const notice = runtime.message('reader.jobFailure', {
      kind: 'translation',
      mode: 'original',
      error: runtime.messageRef(runtime.message('reader.couldNotCompleteTheRequest')),
    });
    for (const locale of ['ko', 'en', 'ja', 'zh'] as const) {
      runtime.setLocale(locale);
      const rendered = runtime.translateMessage(notice);
      expect(rendered).toContain(runtime.t('reader.koreanTranslation'));
      expect(rendered).toContain(runtime.t('reader.couldNotCompleteTheRequest'));
      expect(rendered).not.toContain('\u001fui:');
    }
  });
});

test('static candidate scan sees attribute names, templates, status text and module constants', async () => {
  const source =
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Source fixture must retain interpolation syntax for the parser.
    'const name = "화면 이름"; const label = `전체 ${count}개`; const view = <><input aria-label="접근성 이름" placeholder="입력해요"/><p role="status">불러오는 중이에요</p>{t("sample.count", { count })}</>;';
  const result = scanI18nSource(source);
  expect(result.candidates.map((item: { text: string }) => item.text)).toEqual(
    expect.arrayContaining([
      '화면 이름',
      '전체',
      '개',
      '접근성 이름',
      '입력해요',
      '불러오는 중이에요',
    ])
  );
  expect(result.calls).toEqual([expect.objectContaining({ key: 'sample.count', args: ['count'] })]);
  expect(scanI18nSource('t(variableKey, forwardedArguments)').dynamicCalls).toEqual([
    expect.objectContaining({ expression: 't(variableKey, forwardedArguments)' }),
  ]);
  expect(messageArguments('{count, plural, one {{name} has one} other {{name} has #}}')).toEqual([
    'count',
    'name',
  ]);
  expect(() => messageArguments('{broken')).toThrow();
});

test('catalog checker rejects duplicate and missing keys, malformed ICU and wrong call arguments', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-i18n-check-'));
  try {
    mkdirSync(join(directory, 'web/locales'), { recursive: true });
    writeFileSync(
      join(directory, 'web/locales/first.ts'),
      `export const messages = {
      good: {ko:'{count}',en:'{count}',ja:'{count}',zh:'{count}'},
      duplicate: {ko:'같음',en:'same',ja:'同じ',zh:'相同'},
      missing: {ko:'빠짐',en:'missing',ja:'不足'},
      syntax: {ko:'{broken',en:'valid',ja:'有効',zh:'有效'},
      arguments: {ko:'{name}',en:'{count}',ja:'{name}',zh:'{name}'}
    } as const;`
    );
    writeFileSync(
      join(directory, 'web/locales/second.ts'),
      `export const messages = {
      duplicate: {ko:'같음',en:'same',ja:'同じ',zh:'相同'}
    };`
    );
    writeFileSync(
      join(directory, 'web/view.tsx'),
      'import { message as uiMessage, legacyMessage as validationMessage, formatMessage as formatUi } from "./i18n.js"; t("unknown.key"); t("good", { wrong: 1 }); uiMessage("unknown.alias"); validationMessage("unknown.legacyAlias"); formatUi("good", "en", { wrong: 2 });'
    );
    const result = checkI18n(directory);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('duplicate catalog key'),
        expect.stringContaining('missing zh'),
        expect.stringContaining('invalid ICU'),
        expect.stringContaining('locale argument mismatch'),
        expect.stringContaining('unknown message unknown.key'),
        expect.stringContaining('unknown message unknown.alias'),
        expect.stringContaining('unknown message unknown.legacyAlias'),
        expect.stringContaining('good requires [count], received [wrong]'),
      ])
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('all catalog locales parse ICU and accept the same named arguments', () => {
  function argumentsOf(pattern: string, locale: string) {
    const args = new Set<string>();
    const walk = (items: ReturnType<IntlMessageFormat['getAst']>) => {
      for (const item of items) {
        if (item.type !== 0 && item.type !== 7) args.add(item.value);
        if ('options' in item) for (const option of Object.values(item.options)) walk(option.value);
        if ('children' in item) walk(item.children);
      }
    };
    walk(new IntlMessageFormat(pattern, locale, undefined, { ignoreTag: true }).getAst());
    return [...args].sort();
  }
  expect(Object.keys(messages).length).toBeGreaterThan(10);
  for (const [key, values] of Object.entries(messages)) {
    const koArguments = argumentsOf(values.ko, 'ko');
    for (const locale of ['ko', 'en', 'ja', 'zh'] as const) {
      expect(values[locale], `${key}/${locale}`).toBeTruthy();
      expect(argumentsOf(values[locale], locale), `${key}/${locale}`).toEqual(koArguments);
    }
  }
});
