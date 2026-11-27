import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { IntlMessageFormat } from 'intl-messageformat';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { messages } from '../web/locales/index.js';

const { scanI18nSource, messageArguments, checkI18n, findKoreanServerErrors } = await import(
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
async function loadedI18n() {
  const runtime = await import('../web/i18n.js');
  await Promise.all(runtime.UI_LOCALES.map(runtime.loadLocale));
  return runtime;
}

describe('UI locale presentation boundary', () => {
  test('keeps preformatted values verbatim in every language', async () => {
    const { formatMessage } = await loadedI18n();
    for (const value of ['1,234', 'Unknown'])
      for (const locale of ['ko', 'en', 'ja', 'zh'] as const)
        expect(formatMessage('reader.usingValueSceneSummaries', locale, { v0: value })).toContain(
          value
        );
  });

  test('Korean remains the default and unsupported stored values fall back to Korean', async () => {
    vi.stubGlobal('navigator', { language: 'en-US', languages: ['en-US', 'ja'] });
    const initial = await loadedI18n();
    expect(initial.getLocale()).toBe('ko');
    storage.set('uimori:ui-language', 'fr');
    vi.resetModules();
    const unsupported = await loadedI18n();
    expect(unsupported.getLocale()).toBe('ko');
    expect(unsupported.supportedLocale('en-US')).toBe('ko');
  });

  test('an explicit locale survives a fresh module load and writes only the UI preference', async () => {
    storage.set('uimori:reading-language', 'original');
    storage.set('uimori:input-translation-language', 'ja');
    const before = [...storage];
    const runtime = await loadedI18n();
    expect(runtime.setLocale('en')).toBe(true);
    expect([...storage].filter(([key]) => key !== 'uimori:ui-language')).toEqual(before);
    vi.resetModules();
    expect((await loadedI18n()).getLocale()).toBe('en');
  });

  test('a language switch applies once its catalog loads and a newer choice wins', async () => {
    const runtime = await import('../web/i18n.js');
    expect(runtime.setLocale('ja')).toBe(true);
    expect(runtime.getLocale()).toBe('ko');
    await vi.waitFor(() => expect(runtime.getLocale()).toBe('ja'));
    expect(runtime.t('common.uiLanguage')).toBe('表示言語');
    runtime.setLocale('en');
    runtime.setLocale('ko');
    await runtime.loadLocale('en');
    await new Promise((resolve) => setTimeout(resolve));
    expect(runtime.getLocale()).toBe('ko');
  });

  test('the stored language is available before the first render', async () => {
    storage.set('uimori:ui-language', 'zh');
    const runtime = await import('../web/i18n.js');
    await runtime.loadInitialLocale();
    expect(runtime.getLocale()).toBe('zh');
    expect(runtime.t('common.uiLanguage')).toBe('界面语言');
  });

  test('blocked browser storage still permits the current session language and reports persistence failure', async () => {
    vi.stubGlobal('localStorage', {
      getItem() {
        throw new DOMException('Blocked', 'SecurityError');
      },
      setItem() {
        throw new DOMException('Blocked', 'SecurityError');
      },
    });
    const runtime = await loadedI18n();
    expect(runtime.getLocale()).toBe('ko');
    expect(runtime.setLocale('en')).toBe(false);
    expect(runtime.getLocale()).toBe('en');
  });

  test('retained app notices change language while unknown messages remain verbatim', async () => {
    const { message, setLocale, translateMessage, formatMessage } = await loadedI18n();
    const retained = message('common.uiLanguage');
    expect(translateMessage(retained)).toBe('화면 언어');
    setLocale('en');
    expect(translateMessage(retained)).toBe('Interface language');
    expect(translateMessage('사용자 원고: 그대로 남아야 해요')).toBe(
      '사용자 원고: 그대로 남아야 해요'
    );
    expect(formatMessage('unknown.explicit.key', 'ja')).toBe('unknown.explicit.key');
  });

  test('all built-in layout and palette labels have translations without changing their definitions', async () => {
    const { BUILTIN_THEMES } = await import('../core/themes.js');
    const { BUILTIN_PALETTES } = await import('../core/theme-palettes.js');
    const { setLocale, translateMessage } = await loadedI18n();
    const definitions = JSON.stringify({ themes: BUILTIN_THEMES, palettes: BUILTIN_PALETTES });
    for (const locale of ['en', 'ja', 'zh'] as const) {
      setLocale(locale);
      for (const item of [...BUILTIN_THEMES, ...BUILTIN_PALETTES]) {
        expect(translateMessage(item.title)).not.toMatch(/[가-힣]/u);
        expect(translateMessage(item.description)).not.toMatch(/[가-힣]/u);
      }
    }
    expect(JSON.stringify({ themes: BUILTIN_THEMES, palettes: BUILTIN_PALETTES })).toBe(
      definitions
    );
  });

  test('retained message identity survives identical Japanese translations and leaves literal user arguments alone', async () => {
    const { message, messageRef, setLocale, t, translateMessage } = await loadedI18n();
    setLocale('ja');
    const details = message('outside.details');
    expect(translateMessage(details)).toBe('詳細');
    expect(t('providers.m285')).toBe('詳細');
    const literalTitle = message('shared.deleteQuestion', { title: '저장' });
    const nestedError = message('helpers.modelRefreshFailed', {
      error: messageRef(message('shared.loadFailed')),
    });
    setLocale('en');
    expect(translateMessage(details)).toBe('Details');
    expect(translateMessage(literalTitle)).toBe('Delete 저장?');
    expect(translateMessage(nestedError)).toBe(
      'The assistant model changed, but settings could not be refreshed: Could not load.'
    );
    expect(t('providers.m285')).toBe('Advanced');
  });

  test('a retained Date argument roundtrips as a Date for ICU formatting', async () => {
    const { message, setLocale, translateMessage } = await loadedI18n();
    const catalogs = [
      (await import('../web/locales/ko.js')).default,
      (await import('../web/locales/en.js')).default,
      (await import('../web/locales/ja.js')).default,
    ];
    for (const catalog of catalogs) catalog['test.dateRoundtrip'] = '{instant, date, short}';
    try {
      const retained = message('test.dateRoundtrip', { instant: new Date(2026, 0, 2, 12) });
      setLocale('en');
      expect(translateMessage(retained)).toBe('1/2/26');
      setLocale('ja');
      expect(translateMessage(retained)).toBe('26/1/2');
    } finally {
      for (const catalog of catalogs) Reflect.deleteProperty(catalog, 'test.dateRoundtrip');
    }
  });

  test('validation errors, the notices that nest them and joined warnings follow the locale', async () => {
    const { message, messageRef, setLocale, translateMessage } = await loadedI18n();
    setLocale('en');
    const error = new Error(message('shared.loadFailed'));
    expect(translateMessage(error.message)).toBe('Could not load.');
    const notice = message('helpers.modelRefreshFailed', { error: messageRef(error.message) });
    expect(translateMessage(notice)).toBe(
      'The assistant model changed, but settings could not be refreshed: Could not load.'
    );
    const joined = [notice, message('shared.loadFailed')].join('\n');
    setLocale('ja');
    expect(translateMessage(notice)).toBe(
      'アシスタントモデルは変更しましたが、設定を再読み込みできませんでした: 読み込めませんでした。'
    );
    expect(translateMessage(joined)).toBe(
      'アシスタントモデルは変更しましたが、設定を再読み込みできませんでした: 読み込めませんでした。\n読み込めませんでした。'
    );
    expect(translateMessage(`사용자 원고 · ${message('shared.loadFailed')}`)).toBe(
      '사용자 원고 · 読み込めませんでした。'
    );
  });

  test('external diagnostic bytes resembling a malformed message descriptor remain readable', async () => {
    const { setLocale, translateMessage } = await loadedI18n();
    setLocale('en');
    for (const diagnostic of [
      '\u001fui:broken-json',
      '\u001fui:{"key":"missing.external.key"}',
      '\u001fui:{"key":"outside.activeWork"}',
      '\u001fui:{"key":"missing.external.key"}\u001e',
    ])
      expect(translateMessage(diagnostic)).toBe(diagnostic);
  });

  test('a stray descriptor prefix leaves the next descriptor readable, and formatMessage nests in its own locale', async () => {
    const { formatMessage, message, messageRef, setLocale, translateMessage } = await loadedI18n();
    setLocale('en');
    expect(translateMessage(`\u001fui:broken ${message('shared.loadFailed')}`)).toBe(
      '\u001fui:broken Could not load.'
    );
    setLocale('ko');
    expect(
      formatMessage('helpers.modelRefreshFailed', 'en', {
        error: messageRef(message('shared.loadFailed')),
      })
    ).toBe('The assistant model changed, but settings could not be refreshed: Could not load.');
  });

  test('ICU interpolates full sentences, plural branches and missing locale fallback', async () => {
    const { formatMessage } = await loadedI18n();
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
    const { default: ja } = await import('../web/locales/ja.js');
    const saved = ja['common.uiLanguage'];
    Reflect.deleteProperty(ja, 'common.uiLanguage');
    try {
      expect(formatMessage('common.uiLanguage', 'ja')).toBe('화면 언어');
    } finally {
      ja['common.uiLanguage'] = saved;
    }
  });

  test('numbers and dates follow UI locale without changing their values', async () => {
    const runtime = await loadedI18n();
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
    const runtime = await loadedI18n();
    for (const locale of ['ko', 'en', 'ja', 'zh'] as const) {
      runtime.setLocale(locale);
      expect(runtime.formatDate(new Date(Number.NaN))).toBe('');
      expect(runtime.formatDate('')).toBe('');
    }
  });

  test('retained job errors format the complete title and nested error after language changes', async () => {
    const runtime = await loadedI18n();
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

test('server errors carrying Korean text are rejected while labels and English errors pass', () => {
  const source = [
    "throw new HttpError(409, '충돌했어요');",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Source fixture must retain interpolation syntax for the parser.
    'throw new errors.ImportError(`이름 ${name}`);',
    "new Promise((_, reject) => reject(new Error('실패')));",
    "throw '문자열';",
    "throw new HttpError(400, 'Invalid request');",
    "const label = '본문';",
    'const cast = <string>value;',
  ].join('\n');
  expect(
    findKoreanServerErrors(source, 'server/sample.ts').map((error: string) => error.split(':')[1])
  ).toEqual(['1', '2', '3', '4']);
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
      'import { message as uiMessage, t as translate, formatMessage as formatUi } from "./i18n.js"; t("unknown.key"); t("good", { wrong: 1 }); uiMessage("unknown.alias"); translate("unknown.translateAlias"); formatUi("good", "en", { wrong: 2 });'
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
        expect.stringContaining('unknown message unknown.translateAlias'),
        expect.stringContaining('good requires [count], received [wrong]'),
      ])
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('catalog checker reports only messages that no source can reach', () => {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-i18n-unused-'));
  const entry = (ko: string) => `{ko:'${ko}',en:'x',ja:'x',zh:'x'}`;
  try {
    for (const path of ['web/locales', 'server', 'tests'])
      mkdirSync(join(directory, path), { recursive: true });
    writeFileSync(
      join(directory, 'web/locales/all.ts'),
      `export const messages = {
      'view.literal': ${entry('직접')},
      'view.state.ready': ${entry('준비')},
      'view.suffixLoading': ${entry('불러오는 중')},
      'view.testOnly': ${entry('시험')},
      'view.wire': ${entry('서버가 남긴 문구예요.')},
      'errors.auxiliary.CODE.details': ${entry('파생')},
      'view.dead': ${entry('아무도 안 써요.')},
      'view.deadWithPlaceholder': ${entry('{name}')},
    };`
    );
    writeFileSync(
      join(directory, 'web/view.tsx'),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Source fixture must retain interpolation syntax for the parser.
      'const a = t("view.literal"); const b = t(`view.state.${state}`); const c = t(`view.${name}Loading`); t(`deadWithPlaceholder`);'
    );
    writeFileSync(join(directory, 'tests/view.test.ts'), "expect(t('view.testOnly')).toBe('x');");
    writeFileSync(
      join(directory, 'server/route.ts'),
      "throw new HttpError(409, '서버가 남긴 문구예요.');"
    );
    expect(checkI18n(directory).unused).toEqual(['view.dead', 'view.deadWithPlaceholder']);
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
  for (const [key, values] of Object.entries(messages)) {
    const koArguments = argumentsOf(values.ko, 'ko');
    for (const locale of ['ko', 'en', 'ja', 'zh'] as const) {
      expect(values[locale], `${key}/${locale}`).toBeTruthy();
      expect(argumentsOf(values[locale], locale), `${key}/${locale}`).toEqual(koArguments);
    }
  }
});
