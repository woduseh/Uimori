import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { emptyTheme, validateTheme } from '../core/themes.js';
import { api, ApiError } from '../web/api.js';
import { errorDescriptor, toUiMessage } from '../web/api-errors.js';
import { DismissibleError } from '../web/DismissibleError.js';
import { loadLocale, message, setLocale, t, translateMessage, UI_LOCALES } from '../web/i18n.js';
import { LoadingState } from '../web/LoadingState.js';
import { NoticeBanner } from '../web/NoticeBanner.js';
import {
  formatUiMessage,
  legacyMessageString,
  UiError,
  uiMessage,
  uiText,
} from '../web/ui-message.js';

beforeAll(() => Promise.all(UI_LOCALES.map(loadLocale)));

afterEach(() => {
  vi.restoreAllMocks();
  setLocale('ko');
});

test("an error's own text never becomes the shown message", () => {
  const unexpected = uiMessage('errors.unexpected');
  for (const cause of [
    new TypeError('Failed to fetch'),
    new Error('The model refused: content policy'),
    new Error('\u001fui:{"key":"no.such.key"}\u001e'),
    new Error(`${message('shared.loadFailed')} trailing English`),
    'raw text',
    null,
    { message: 'not an error' },
  ])
    expect(toUiMessage(cause)).toEqual(unexpected);
  expect(toUiMessage(new Error('x'), 'shared.loadFailed')).toEqual(uiMessage('shared.loadFailed'));
  const shown = translateMessage(errorDescriptor(new TypeError('Failed to fetch')));
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
  expect(translateMessage((rejected as ApiError).message)).toBe(formatUiMessage(fromApi));
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

test('only a UiError carries its catalog message; a descriptor in a plain Error does not', () => {
  const scene = uiMessage('errors.scene', { scene: 3 });
  expect(toUiMessage(new Error(message('errors.scene', { scene: 3 })))).toEqual(
    uiMessage('errors.unexpected')
  );
  const listed = uiMessage('shared.deleteQuestion', {
    title: [scene, uiText(', '), uiMessage('errors.firstMessage'), uiText(', …')],
  });
  for (const value of [
    scene,
    uiMessage('shared.deleteQuestion', { title: uiText('Alice') }),
    uiMessage('shared.deleteQuestion', { title: scene }),
    listed,
  ]) {
    const error = new UiError(value);
    expect(toUiMessage(error)).toBe(value);
    for (const locale of ['ko', 'en'] as const) {
      setLocale(locale);
      expect(translateMessage(error.message)).toBe(formatUiMessage(value));
    }
  }
});

test('nested and listed values format in the language being shown', () => {
  const listed = uiMessage('shared.deleteQuestion', {
    title: [
      uiMessage('errors.firstMessage'),
      uiText(', '),
      uiMessage('errors.scene', { scene: 2 }),
    ],
  });
  const korean = formatUiMessage(listed);
  expect(korean).toContain('첫 메시지, 장면 2');
  expect(translateMessage(legacyMessageString(listed))).toBe(korean);
  setLocale('en');
  expect(formatUiMessage(listed)).toContain('First message, Scene 2');
  expect(formatUiMessage(uiText('\u001fui:{"key":"shared.loadFailed"}\u001e'))).toBe(
    '\u001fui:{"key":"shared.loadFailed"}\u001e'
  );
});

test('shared components render a UiMessage and a legacy descriptor in the language being shown', () => {
  const failed = uiMessage('shared.loadFailed');
  const banner = { tone: 'error' as const, label: failed, children: failed };
  const render = () =>
    renderToStaticMarkup(
      createElement(
        'div',
        null,
        createElement(NoticeBanner, banner),
        createElement(LoadingState, { error: failed, errorLabel: message('shared.loadFailed') }),
        createElement(DismissibleError, { error: failed, onDismiss: () => {} })
      )
    );
  const korean = render();
  expect(korean.split(t('shared.loadFailed')).length - 1).toBe(5);
  setLocale('en');
  const english = render();
  expect(english.split('Could not load.').length - 1).toBe(5);
  expect(english).not.toContain('불러오지 못했어요');
  expect(english).not.toContain('\u001f');
});
