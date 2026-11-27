import { describe, expect, it } from 'vitest';
import { auxiliaryErrorDiagnostic } from '../web/auxiliary-error.js';
import { formatUiMessage } from '../web/ui-message.js';

describe('safe auxiliary error diagnostics', () => {
  it('does not expose raw remote text, unrecognized codes or inherited object keys', () => {
    for (const error of [
      null,
      undefined,
      {},
      'constructor',
      '__proto__',
      'AUXILIARY_PROVIDER_PRIVATE_SECRET',
      'AUXILIARY_PROVIDER_HTTP_401 https://private.example/key',
      '<script>secret</script>',
      'TRANSLATION_REFUSAL_CHECK_FAILED PRIVATE_RESPONSE_TEXT',
      { code: 'TRANSLATION_REFUSAL_UNCERTAIN', response: 'PRIVATE_RESPONSE_TEXT' },
    ]) {
      const diagnostic = auxiliaryErrorDiagnostic(error);
      expect(diagnostic.code).toBeNull();
      expect(diagnostic).toEqual(auxiliaryErrorDiagnostic(undefined));
    }
  });
});

it('names an automatic translation that could not be prepared', () => {
  const diagnostic = auxiliaryErrorDiagnostic('AUTO_TRANSLATION_PREPARE_FAILED');
  expect(diagnostic.code).toBe('AUTO_TRANSLATION_PREPARE_FAILED');
  expect(formatUiMessage(diagnostic.summary)).toBe('자동 번역을 준비하지 못했어요.');
});
