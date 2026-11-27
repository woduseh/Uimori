import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { emptyTheme, validateTheme } from '../core/themes.js';
import { api, ApiError } from '../web/api.js';
import { toUiMessage } from '../web/api-errors.js';
import { DismissibleError } from '../web/DismissibleError.js';
import { loadLocale, setLocale, t, UI_LOCALES } from '../web/i18n.js';
import { LoadingState } from '../web/LoadingState.js';
import { NoticeBanner } from '../web/NoticeBanner.js';
import { formatUiMessage, UiError, uiMessage, uiText } from '../web/ui-message.js';

beforeAll(() => Promise.all(UI_LOCALES.map(loadLocale)));

afterEach(() => {
  vi.restoreAllMocks();
  setLocale('ko');
});

const hangul = /[가-힣]/u;

test("an error's own text never becomes the shown message", () => {
  const unexpected = uiMessage('errors.unexpected');
  for (const cause of [
    new TypeError('Failed to fetch'),
    new Error('The model refused: content policy'),
    new Error('shared.loadFailed'),
    'raw text',
    null,
    { message: 'not an error' },
  ])
    expect(toUiMessage(cause)).toEqual(unexpected);
  expect(toUiMessage(new Error('x'), 'shared.loadFailed')).toEqual(uiMessage('shared.loadFailed'));
  const shown = formatUiMessage(toUiMessage(new TypeError('Failed to fetch')));
  expect(shown).toBe(t('errors.unexpected'));
  expect(shown).not.toContain('Failed to fetch');
});

test('thrown UI, API and core validation errors keep their catalog message across a switch', async () => {
  const own = uiMessage('shared.loadFailed');
  expect(toUiMessage(new UiError(own))).toBe(own);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ code: 'INPUT_TRANSLATION_TOO_LONG', params: { limit: 1234 } }), {
      status: 422,
    })
  );
  const rejected = await api('/synthetic', {}).catch((error: unknown) => error);
  expect(rejected).toBeInstanceOf(ApiError);
  const fromApi = toUiMessage(rejected);
  expect(fromApi).toBe((rejected as ApiError).uiMessage);
  let invalid: unknown;
  try {
    validateTheme({ ...emptyTheme('Long'), appCss: 'x'.repeat(1_000_001) });
  } catch (error) {
    invalid = error;
  }
  const fromCore = toUiMessage(invalid);
  expect(formatUiMessage(fromApi)).toContain('1,234자');
  expect(formatUiMessage(fromCore)).toBe('앱 CSS: 최대 1,000,000자의 문자열을 입력해 주세요.');
  setLocale('en');
  expect(formatUiMessage(fromApi)).toContain('1,234 characters');
  expect(formatUiMessage(fromCore)).toBe('App CSS: Enter text of up to 1,000,000 characters.');
});

test("a UiError's own message is a diagnostic in no interface language", () => {
  const scene = uiMessage('errors.scene', { scene: 3 });
  const listed = uiMessage('shared.deleteQuestion', {
    title: [scene, uiText(', '), uiMessage('errors.firstMessage'), uiText(', …')],
  });
  for (const value of [scene, uiMessage('shared.deleteQuestion', { title: scene }), listed]) {
    const error = new UiError(value);
    expect(toUiMessage(error)).toBe(value);
    expect(error.message).toContain(value.kind === 'key' ? value.key : '');
    expect(error.message).not.toMatch(hangul);
    expect(error.message).not.toBe(formatUiMessage(value, 'en'));
  }
});

test('nested and listed values format in the language being shown, and raw text stays verbatim', () => {
  const listed = uiMessage('shared.deleteQuestion', {
    title: [
      uiMessage('errors.firstMessage'),
      uiText(', '),
      uiMessage('errors.scene', { scene: 2 }),
    ],
  });
  const manuscript = uiMessage('helpers.modelRefreshFailed', {
    error: [uiText('사용자 원고 · '), uiMessage('shared.loadFailed')],
  });
  expect(formatUiMessage(listed)).toContain('첫 메시지, 장면 2');
  setLocale('en');
  expect(formatUiMessage(listed)).toContain('First message, Scene 2');
  expect(formatUiMessage(manuscript)).toBe(
    'The assistant model changed, but settings could not be refreshed: 사용자 원고 · Could not load.'
  );
  expect(formatUiMessage(uiText('The model refused: 원고를 거절했어요'))).toBe(
    'The model refused: 원고를 거절했어요'
  );
});

test('shared components render a UiMessage in the language being shown', () => {
  const failed = uiMessage('shared.loadFailed');
  const banner = { tone: 'error' as const, label: failed, children: failed };
  const render = () =>
    renderToStaticMarkup(
      createElement(
        'div',
        null,
        createElement(NoticeBanner, banner),
        createElement(LoadingState, { error: failed, errorLabel: failed }),
        createElement(DismissibleError, { error: failed, onDismiss: () => {} })
      )
    );
  const korean = render();
  expect(korean.split(t('shared.loadFailed')).length - 1).toBe(5);
  setLocale('en');
  const english = render();
  expect(english.split('Could not load.').length - 1).toBe(5);
  expect(english).not.toContain('불러오지 못했어요');
});

test('no error or notice shows when there is none', () => {
  const markup = renderToStaticMarkup(
    createElement(
      'div',
      null,
      createElement(LoadingState, { loading: false, error: null }),
      createElement(DismissibleError, { error: null, onDismiss: () => {} })
    )
  );
  expect(markup).toBe('<div></div>');
});
