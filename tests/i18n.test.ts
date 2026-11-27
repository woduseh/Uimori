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
  return { ...runtime, ...(await import('../web/ui-message.js')) };
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

  test('retained app notices change language while raw text remains verbatim', async () => {
    const { uiMessage, uiText, formatUiMessage, setLocale, formatMessage } = await loadedI18n();
    const retained = uiMessage('common.uiLanguage');
    expect(formatUiMessage(retained)).toBe('화면 언어');
    setLocale('en');
    expect(formatUiMessage(retained)).toBe('Interface language');
    expect(formatUiMessage(uiText('사용자 원고: 그대로 남아야 해요'))).toBe(
      '사용자 원고: 그대로 남아야 해요'
    );
    expect(formatMessage('unknown.explicit.key', 'ja')).toBe('unknown.explicit.key');
  });

  test('built-in labels follow the interface language while the helper-facing definitions stay unchanged', async () => {
    const { BUILTIN_THEMES } = await import('../core/themes.js');
    const { BUILTIN_PALETTES } = await import('../core/theme-palettes.js');
    const { BUILTIN_ILLUSTRATION_PRESET } = await import('../core/illustration-presets.js');
    const { PROVIDER_PROTOCOLS } = await import('../core/product.js');
    const { TOKENIZER_PROFILES } = await import('../core/tokenizer-profiles.js');
    const { USAGE_KINDS } = await import('../core/usage-report.js');
    const { setLocale } = await loadedI18n();
    const labels = await import('../web/builtin-labels.js');
    const definitions = JSON.stringify({ themes: BUILTIN_THEMES, palettes: BUILTIN_PALETTES });
    const shown = () => [
      ...BUILTIN_THEMES.flatMap((item) => Object.values(labels.themeText(item))),
      ...BUILTIN_PALETTES.flatMap((item) => Object.values(labels.paletteText(item))),
      ...Object.values(labels.illustrationPresetText(BUILTIN_ILLUSTRATION_PRESET)),
      ...PROVIDER_PROTOCOLS.flatMap((id) => [
        labels.providerLabel(id),
        ...labels.providerLimitations(id),
      ]),
      ...TOKENIZER_PROFILES.map((profile) => labels.tokenizerLabel(profile.id)),
      ...USAGE_KINDS.map(labels.usageKindLabel),
    ];
    expect(shown().join('\n')).toContain('시네마틱');
    for (const locale of ['en', 'ja', 'zh'] as const) {
      setLocale(locale);
      for (const text of shown()) {
        expect(text).not.toMatch(/[가-힣]/u);
        expect(text).not.toMatch(/^[\w-]+(?:\.[\w-]+)+$/u);
      }
    }
    expect(labels.usageKindLabel('retired-kind')).toBe(labels.usageKindLabel('unclassified'));
    expect(
      labels.paletteText({ id: 'forest', title: '내 숲', description: '', revision: 1 }).title
    ).toBe('내 숲');
    expect(JSON.stringify({ themes: BUILTIN_THEMES, palettes: BUILTIN_PALETTES })).toBe(
      definitions
    );
  });

  test('retained messages survive identical Japanese translations and leave literal user arguments alone', async () => {
    const { uiMessage, uiText, formatUiMessage, setLocale, t } = await loadedI18n();
    setLocale('ja');
    const details = uiMessage('outside.details');
    expect(formatUiMessage(details)).toBe('詳細');
    expect(t('providers.m285')).toBe('詳細');
    const literalTitle = uiMessage('shared.deleteQuestion', { title: uiText('저장') });
    const plainTitle = uiMessage('shared.deleteQuestion', { title: '저장' });
    const nestedError = uiMessage('helpers.modelRefreshFailed', {
      error: uiMessage('shared.loadFailed'),
    });
    setLocale('en');
    expect(formatUiMessage(details)).toBe('Details');
    expect(formatUiMessage(literalTitle)).toBe('Delete 저장?');
    expect(formatUiMessage(plainTitle)).toBe('Delete 저장?');
    expect(formatUiMessage(nestedError)).toBe(
      'The assistant model changed, but settings could not be refreshed: Could not load.'
    );
    expect(t('providers.m285')).toBe('Advanced');
  });

  test('a retained Date argument formats in the language being shown', async () => {
    const { uiMessage, formatUiMessage, setLocale } = await loadedI18n();
    const catalogs = [
      (await import('../web/locales/ko.js')).default,
      (await import('../web/locales/en.js')).default,
      (await import('../web/locales/ja.js')).default,
    ];
    for (const catalog of catalogs) catalog['test.dateRoundtrip'] = '{instant, date, short}';
    try {
      const retained = uiMessage('test.dateRoundtrip' as never, {
        instant: new Date(2026, 0, 2, 12),
      });
      setLocale('en');
      expect(formatUiMessage(retained)).toBe('1/2/26');
      setLocale('ja');
      expect(formatUiMessage(retained)).toBe('26/1/2');
    } finally {
      for (const catalog of catalogs) Reflect.deleteProperty(catalog, 'test.dateRoundtrip');
    }
  });

  test('stored status codes follow the locale while text stored by 0.18.x stays verbatim', async () => {
    const { setLocale, translateStoredCode } = await loadedI18n();
    const keys = { BACKUP_DISK_FULL: 'settings.backupDiskFull' } as const;
    expect(translateStoredCode('BACKUP_DISK_FULL', keys)).toBe(
      '저장 공간이 부족해요. 기존 백업은 유지했어요.'
    );
    setLocale('en');
    expect(translateStoredCode('BACKUP_DISK_FULL', keys)).toBe(
      'Not enough storage space. Existing backups were kept.'
    );
    expect(translateStoredCode('예약 백업을 시작하지 못했어요.', keys)).toBe(
      '예약 백업을 시작하지 못했어요.'
    );
    expect(translateStoredCode('toString', keys)).toBe('toString');
  });

  test('thrown errors, the notices that nest them and joined warnings follow the locale', async () => {
    const { uiMessage, uiText, formatUiMessage, UiError, setLocale } = await loadedI18n();
    const { toUiMessage } = await import('../web/api-errors.js');
    setLocale('en');
    const error = toUiMessage(new UiError(uiMessage('shared.loadFailed')));
    expect(formatUiMessage(error)).toBe('Could not load.');
    const notice = uiMessage('helpers.modelRefreshFailed', { error });
    expect(formatUiMessage(notice)).toBe(
      'The assistant model changed, but settings could not be refreshed: Could not load.'
    );
    const joined = uiMessage('helpers.modelRefreshFailed', {
      error: [error, uiText('\n'), uiMessage('shared.loadFailed')],
    });
    setLocale('ja');
    expect(formatUiMessage(notice)).toBe(
      'アシスタントモデルは変更しましたが、設定を再読み込みできませんでした: 読み込めませんでした。'
    );
    expect(formatUiMessage(joined)).toBe(
      'アシスタントモデルは変更しましたが、設定を再読み込みできませんでした: 読み込めませんでした。\n読み込めませんでした。'
    );
  });

  test('a message formatted in another language nests in that language', async () => {
    const { uiMessage, formatUiMessage, setLocale } = await loadedI18n();
    setLocale('ko');
    expect(
      formatUiMessage(
        uiMessage('helpers.modelRefreshFailed', { error: uiMessage('shared.loadFailed') }),
        'en'
      )
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
    const notice = runtime.uiMessage('reader.jobFailure', {
      kind: 'translation',
      mode: 'original',
      error: runtime.uiMessage('reader.couldNotCompleteTheRequest'),
    });
    for (const locale of ['ko', 'en', 'ja', 'zh'] as const) {
      runtime.setLocale(locale);
      const rendered = runtime.formatUiMessage(notice);
      expect(rendered).toContain(runtime.t('reader.koreanTranslation'));
      expect(rendered).toContain(runtime.t('reader.couldNotCompleteTheRequest'));
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
  expect(
    scanI18nSource(
      "import { uiMessage as typed } from './ui-message.js'; typed('sample.count', { total });"
    ).calls
  ).toEqual([expect.objectContaining({ key: 'sample.count', args: ['total'] })]);
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
      'import { t as translate, formatMessage as formatUi } from "./i18n.js"; import { uiMessage as ui } from "./ui-message.js"; t("unknown.key"); t("good", { wrong: 1 }); ui("unknown.alias"); translate("unknown.translateAlias"); formatUi("good", "en", { wrong: 2 });'
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
    expect(checkI18n(directory).unused).toEqual([
      'view.wire',
      'view.dead',
      'view.deadWithPlaceholder',
    ]);
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
