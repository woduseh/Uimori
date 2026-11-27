import { expect, test } from 'vitest';
import { SOURCE_TEXT_MAX_CHARS } from '../core/content-limits.js';
import { validatePackageStarts } from '../core/package-start.js';
import { validateRisuContentSource, type RisuContentSource } from '../core/risu-native.js';
import { nativeRisuToggleItems } from '../core/risu-native-preset.js';
import { appErrorUiMessage, toUiMessage } from '../web/api-errors.js';
import { parseJsonInput } from '../web/json-input.js';
import { parseNativeRegexJson } from '../web/native-risu-regex.js';
import { editNativeSource } from '../web/native-source-edit.js';
import { checkedPresetProgram } from '../web/NativeRisuPresetEditor.js';
import { uiMessage, type UiMessage } from '../web/ui-message.js';

const native: RisuContentSource = {
  version: 1,
  card: { name: 'Fixture' },
  assets: [],
  sourceHash: 'a'.repeat(64),
};

function shown(run: () => unknown): UiMessage {
  try {
    run();
  } catch (error) {
    return toUiMessage(error);
  }
  throw new Error('expected a failure');
}

test('unparsable JSON in an authoring editor or an imported file names the problem', () => {
  const invalid = uiMessage('errors.invalidJson');
  expect(shown(() => parseNativeRegexJson('[{"in":'))).toEqual(invalid);
  for (const part of ['lore', 'regex', 'triggers', 'greetings', 'card'] as const)
    expect(shown(() => editNativeSource(native, part, '{"unfinished":'))).toEqual(invalid);
  expect(shown(() => parseJsonInput('{', 'errors.PALETTE_FILE_INVALID'))).toEqual(
    uiMessage('errors.PALETTE_FILE_INVALID')
  );
});

test('validators the editors call directly answer with their own catalog message', () => {
  const tooLong = {
    id: 'start-0',
    title: 'Opening',
    mode: 'authored',
    text: 'a'.repeat(SOURCE_TEXT_MAX_CHARS + 1),
  };
  for (const [run, expected] of [
    [
      () => validateRisuContentSource({ ...native, sourceHash: 'x' }),
      appErrorUiMessage('PACKAGE_NATIVE_RISU_INVALID'),
    ],
    [
      () => editNativeSource(native, 'card', '{"value":1e999}'),
      appErrorUiMessage('PACKAGE_NATIVE_RISU_JSON'),
    ],
    [
      () =>
        editNativeSource(
          native,
          'card',
          JSON.stringify({ extensions: { uimori: { illustrationProfiles: [{ id: '' }] } } })
        ),
      appErrorUiMessage('ILLUSTRATION_PROFILES_INVALID'),
    ],
    [
      () => nativeRisuToggleItems('same=A\nsame=B'),
      appErrorUiMessage('RISU_NATIVE_PRESET_TOGGLE_KEY'),
    ],
    [
      () => validatePackageStarts([tooLong]),
      appErrorUiMessage('PACKAGE_START_TEXT_TOO_LONG', { limit: SOURCE_TEXT_MAX_CHARS }),
    ],
  ] as const)
    expect(shown(run)).toEqual(expected);
  const program = shown(() => checkedPresetProgram({}));
  expect(program).toMatchObject({ kind: 'key', key: 'native.presetProgramInvalid' });
});
