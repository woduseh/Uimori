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
import { RisuPromptError } from '../core/risu-prompt.js';
import { AgentCollaborationError } from '../core/agent-collaboration.js';
import { ChatTranscriptError } from '../core/chat-transcript.js';
import { NativeTransferError } from '../core/native-transfer-validation.js';
import { shellBridgeFailure } from '../server/helper-shell.js';
import { validateRisuContent } from '../core/risu-content.js';
import type { RisuImportFindingCode, RisuImportFindingParams } from '../core/risu-import.js';
import type { RisuPresetFindingCode, RisuPresetFindingParams } from '../core/risu-preset.js';
import { IMPORT_FINDING_MESSAGES, PRESET_FINDING_MESSAGES } from '../web/risu-finding-messages.js';

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
    app.get('/api/test-risu-prompt-error', () => {
      throw new RisuPromptError('PROMPT_INVALID_FIELDS');
    });
    app.get('/api/test-risu-content-error', () => validateRisuContent({ version: 1 }));
    app.get('/api/test-agent-collaboration-error', () => {
      throw new AgentCollaborationError('AGENT_COLLABORATION_AGENT_ID');
    });
    const collaboration = await app.inject('/api/test-agent-collaboration-error');
    expect(collaboration.statusCode).toBe(400);
    expect(collaboration.json()).toEqual({ code: 'AGENT_COLLABORATION_INVALID' });
    const prompt = await app.inject('/api/test-risu-prompt-error');
    expect(prompt.statusCode).toBe(400);
    expect(prompt.json()).toEqual({ code: 'RISU_PROMPT_INVALID' });
    const content = await app.inject('/api/test-risu-content-error');
    expect(content.statusCode).toBe(400);
    expect(content.json()).toEqual({ code: 'RISU_CONTENT_INVALID' });
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

test('the helper shell bridge answers a core error with the code the app answers', () => {
  for (const [error, code] of [
    [new RisuPromptError('PROMPT_PROGRAM_LIMIT'), 'RISU_PROMPT_TOO_LARGE'],
    [new AgentCollaborationError('AGENT_COLLABORATION_AGENT_ID'), 'AGENT_COLLABORATION_INVALID'],
    [new ChatTranscriptError('CHAT_TRANSCRIPT_INVALID_TEXT'), 'CHAT_TRANSCRIPT_INVALID_TEXT'],
    [new NativeTransferError('NATIVE_TRANSFER_GRAPH'), 'NATIVE_TRANSFER_FILE_INVALID'],
  ] as const)
    expect(shellBridgeFailure(error)).toMatchObject({ status: 400, body: { code } });
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

const findingParameterNames = {
  import: {
    'lore-decorator-placement': { decorator: true },
    'lore-decorator-activation': { decorator: true },
    'lore-decorator-unknown': { names: true, more: true },
  } satisfies {
    [C in RisuImportFindingCode as RisuImportFindingParams[C] extends undefined
      ? never
      : C]: Record<keyof RisuImportFindingParams[C], true>;
  },
  preset: {
    RISU_PRESET_UNSUPPORTED_BLOCK: { position: true, type: true },
    RISU_PRESET_HOST_SETTING: { setting: true },
  } satisfies {
    [C in RisuPresetFindingCode as RisuPresetFindingParams[C] extends undefined
      ? never
      : C]: Record<keyof RisuPresetFindingParams[C], true>;
  },
};

test('every Risu import finding has a message in every locale whose arguments are its params', () => {
  for (const [table, names] of [
    [IMPORT_FINDING_MESSAGES, findingParameterNames.import],
    [PRESET_FINDING_MESSAGES, findingParameterNames.preset],
  ] as const)
    for (const [code, key] of Object.entries(table)) {
      const expected = Object.keys((names as Record<string, object>)[code] ?? {}).sort();
      for (const locale of UI_LOCALES)
        expect(messageArguments(messages[key]![locale], locale), `${key}.${locale}`).toEqual(
          expected
        );
    }
});
