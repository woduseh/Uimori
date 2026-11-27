import { beforeAll, expect, test } from 'vitest';
import { ApiError } from '../web/api.js';
import { appErrorUiMessage } from '../web/api-errors.js';
import { caughtErrorState } from '../web/caught-error.js';
import { loadLocale, t, translateMessage, UI_LOCALES } from '../web/i18n.js';
import { formatUiMessage, UiError, uiMessage } from '../web/ui-message.js';

beforeAll(() => Promise.all(UI_LOCALES.map(loadLocale)));

const shown = (cause: unknown, fallback?: Parameters<typeof caughtErrorState>[1]) => {
  const state = caughtErrorState(cause, fallback);
  return { text: translateMessage(state.message), code: state.code };
};

test("a network failure shows the action's own message, not the generic one", () => {
  expect(shown(new TypeError('Failed to fetch'), 'main.story13')).toEqual({
    text: t('main.story13'),
    code: null,
  });
  expect(shown('raw', 'main.story23').text).toBe(t('main.story23'));
  expect(shown(new TypeError('Failed to fetch')).text).toBe(t('errors.unexpected'));
});

test('an API failure keeps its own message and its code for the follow-up action', () => {
  const failure = new ApiError(
    appErrorUiMessage('MODEL_REQUIRED', { role: 'main' }),
    409,
    'MODEL_REQUIRED'
  );
  expect(shown(failure, 'main.story13')).toEqual({
    text: formatUiMessage(failure.uiMessage),
    code: 'MODEL_REQUIRED',
  });
  expect(shown(new UiError(uiMessage('main.story24')), 'main.story13')).toEqual({
    text: t('main.story24'),
    code: null,
  });
});
