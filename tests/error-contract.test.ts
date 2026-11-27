import { expect, test } from 'vitest';
import {
  APP_ERROR_CODES,
  type AppErrorCode,
  type AppErrorParams,
  isAppErrorCode,
  readErrorWire,
} from '#contracts';
import { AppError, errorWire, HelperToolError } from '../server/app-errors.js';
import { HttpError } from '../server/request-validation.js';
import { UI_LOCALES } from '../core/ui-locale.js';
import { messages } from '../web/locales/index.js';
import { appErrorMessages } from '../web/api-errors.js';

const { messageArguments } = await import(
  new URL('../scripts/check-i18n.mjs', import.meta.url).href
);

type ParameterizedCode = {
  [C in AppErrorCode]: AppErrorParams[C] extends undefined ? never : C;
}[AppErrorCode];

const parameterNames = {
  INPUT_TRANSLATION_TOO_LONG: ['limit'],
} satisfies { [C in ParameterizedCode]: (keyof AppErrorParams[C])[] };

test('every catalogued code has a message in every locale whose arguments are its params', () => {
  expect(APP_ERROR_CODES.length).toBeGreaterThan(0);
  for (const code of APP_ERROR_CODES) {
    const key = appErrorMessages[code];
    expect(messages[key], `${code} → ${key}`).toBeDefined();
    const expected = [
      ...(Object.hasOwn(parameterNames, code) ? parameterNames[code as ParameterizedCode] : []),
    ].sort();
    for (const locale of UI_LOCALES) {
      const pattern = messages[key]![locale];
      expect(pattern, `${key}.${locale}`).toEqual(expect.any(String));
      expect(messageArguments(pattern, locale), `${key}.${locale}`).toEqual(expected);
    }
  }
});

test('catalog membership is exact', () => {
  expect(isAppErrorCode('INPUT_TRANSLATION_TOO_LONG')).toBe(true);
  expect(isAppErrorCode('MODEL_REQUIRED:translation')).toBe(false);
  expect(isAppErrorCode('toString')).toBe(false);
  expect(isAppErrorCode(undefined)).toBe(false);
});

test('an app error is sent as its code and params without a legacy string', () => {
  expect(errorWire(new AppError(422, 'INPUT_TRANSLATION_TOO_LONG', { limit: 4000 }), 'x')).toEqual({
    code: 'INPUT_TRANSLATION_TOO_LONG',
    params: { limit: 4000 },
  });
  expect(errorWire(new AppError(409, 'SELECTION_REVISION_STALE'), 'x')).toEqual({
    code: 'SELECTION_REVISION_STALE',
  });
});

test('unconverted errors keep the legacy error string, including helper tool diagnostics', () => {
  expect(errorWire(new HttpError(409, 'STORY_UI_STALE_SOURCE'), 'STORY_UI_STALE_SOURCE')).toEqual({
    error: 'STORY_UI_STALE_SOURCE',
  });
  expect(errorWire(new HttpError(400, 'Invalid boolean'), 'Invalid boolean')).toEqual({
    error: 'Invalid boolean',
  });
  const helper = new HelperToolError(404, 'SCENE_NOT_IN_CHAT', 'Find the scene id with chat.read.');
  expect(helper).toBeInstanceOf(HttpError);
  expect(helper.code).toBe('SCENE_NOT_IN_CHAT');
  expect(errorWire(helper, helper.message)).toEqual({
    error: 'SCENE_NOT_IN_CHAT: Find the scene id with chat.read.',
  });
  expect(errorWire(new Error('secret'), 'Request failed')).toEqual({ error: 'Request failed' });
});

test('a received payload is read as a code first, then as a legacy string', () => {
  expect(readErrorWire({ code: 'INPUT_TRANSLATION_TOO_LONG', params: { limit: 4000 } })).toEqual({
    code: 'INPUT_TRANSLATION_TOO_LONG',
    params: { limit: 4000 },
  });
  expect(readErrorWire({ code: 'SELECTION_REVISION_STALE' })).toEqual({
    code: 'SELECTION_REVISION_STALE',
  });
  expect(readErrorWire({ error: 'Revision conflict' })).toEqual({ error: 'Revision conflict' });
  expect(readErrorWire(null)).toEqual({});
});
