import { expect, test } from 'vitest';
import { APP_ERROR_CODES, type AppErrorCode, type AppErrorParams } from '#contracts';
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
  INPUT_TRANSLATION_TOO_LONG: { limit: true },
  NATIVE_TRANSFER_EXPORT_TOO_LARGE: { maxBytes: true },
  NATIVE_TRANSFER_IMPORT_TOO_LARGE: { maxBytes: true },
  IMAGE_TOO_LARGE: { maxBytes: true },
  FONT_TOO_LARGE: { maxBytes: true },
  FONT_STORAGE_FULL: { maxCount: true, maxBytes: true },
  THEME_ASSET_STORAGE_FULL: { maxBytes: true },
  THEME_ASSET_MISSING: { name: true },
  OUTLINE_RELATED_TOO_MANY: { limit: true },
  OUTLINE_NODE_WRITTEN: { title: true },
  MODEL_REQUIRED: { role: true },
  MODEL_UNAVAILABLE: { role: true },
  MANUSCRIPT_TRANSLATION_MISSING: { scenes: true, total: true },
  ILLUSTRATION_REFERENCES_TOO_MANY: { limit: true },
  RISU_IMPORT_TOO_LARGE: { maxBytes: true },
  RISU_IMPORT_IMAGES_TOO_LARGE: { maxBytes: true },
  UPLOAD_TOO_LARGE: { maxBytes: true },
  RISU_NATIVE_ACTION_IMAGES_TOO_MANY: { limit: true },
  PACKAGE_START_TEXT_TOO_LONG: { limit: true },
} satisfies { [C in ParameterizedCode]: Record<keyof AppErrorParams[C], true> };

test('every catalogued code has a message in every locale whose arguments are its params', () => {
  expect(APP_ERROR_CODES.length).toBeGreaterThan(0);
  for (const code of APP_ERROR_CODES) {
    const key = appErrorMessages[code];
    expect(messages[key], `${code} → ${key}`).toBeDefined();
    const expected = Object.hasOwn(parameterNames, code)
      ? Object.keys(parameterNames[code as ParameterizedCode]).sort()
      : [];
    for (const locale of UI_LOCALES) {
      const pattern = messages[key]![locale];
      expect(pattern, `${key}.${locale}`).toEqual(expect.any(String));
      expect(messageArguments(pattern, locale), `${key}.${locale}`).toEqual(expected);
    }
  }
});
