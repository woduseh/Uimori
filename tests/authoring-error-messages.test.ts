import { expect, test } from 'vitest';
import type { RisuContentSource } from '../core/risu-native.js';
import { toUiMessage } from '../web/api-errors.js';
import { parseJsonInput } from '../web/json-input.js';
import { parseNativeRegexJson } from '../web/native-risu-regex.js';
import { editNativeSource } from '../web/native-source-edit.js';
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
