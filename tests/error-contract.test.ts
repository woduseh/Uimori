import { expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_ERROR_CODES, type AppErrorCode, type AppErrorParams } from '#contracts';
import { ValidationError } from '../core/validation-error.js';
import { createApp } from '../server/app.js';
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
  ILLUSTRATION_PRESET_FIELD_TOO_LONG: { field: true, limit: true },
  THEME_OBJECT_REQUIRED: { field: true },
  THEME_FIELD_TOO_LONG: { field: true, limit: true },
  THEME_COLOR_UNSUPPORTED: { key: true },
  THEME_COLOR_INVALID: { key: true },
  THEME_ASSETS_TOO_MANY: { limit: true },
  THEME_ASSET_KIND_INVALID: { name: true },
  THEME_ASSET_HASH_INVALID: { name: true },
  THEME_ASSET_DUPLICATE: { name: true },
  THEME_FILE_ASSET_MISSING: { name: true },
  TRANSLATION_GUIDE_INSTRUCTIONS_TOO_LONG: { limit: true },
  TRANSLATION_GUIDE_TERMS_TOO_MANY: { limit: true },
  TRANSLATION_GUIDE_TERM_INVALID: { term: true, limit: true },
  TRANSLATION_GUIDE_NOTE_TOO_LONG: { term: true, limit: true },
} satisfies { [C in ParameterizedCode]: Record<keyof AppErrorParams[C], true> };

test('a core validator error thrown inside any route answers its catalogued code and status', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-error-contract-'));
  const app = await createApp({
    dbPath: join(directory, 'app.sqlite'),
    buildId: 'error-contract-test',
    testMode: true,
  });
  try {
    app.get('/api/test-validation-error', () => {
      throw new ValidationError(409, 'LORE_PINNED_BUDGET_EXCEEDED', 'Pinned sources too large.');
    });
    app.get('/api/test-validation-params', () => {
      throw new ValidationError(400, 'THEME_COLOR_INVALID', 'colors.light.accent: bad.', {
        key: 'accent',
      });
    });
    const conflict = await app.inject('/api/test-validation-error');
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ code: 'LORE_PINNED_BUDGET_EXCEEDED' });
    const invalid = await app.inject('/api/test-validation-params');
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ code: 'THEME_COLOR_INVALID', params: { key: 'accent' } });
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

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
