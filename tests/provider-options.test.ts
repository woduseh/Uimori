import { describe, expect, test } from 'vitest';
import {
  parseProviderOptionsText,
  ProviderOptionsError,
  PROVIDER_OPTIONS_MAX_CHARS,
  validateProviderOptions,
} from '../core/provider-options.js';

describe('providerOptions JSON contract', () => {
  test('parses an optional JSON object and keeps nested values', () => {
    expect(parseProviderOptionsText('')).toBeUndefined();
    expect(parseProviderOptionsText(' {"gateway":{"only":["openai"]}} ')).toEqual({
      gateway: { only: ['openai'] },
    });
  });

  test('rejects malformed and non-object roots', () => {
    for (const text of ['{', '[]', 'null'])
      expect(() => parseProviderOptionsText(text)).toThrow(ProviderOptionsError);
  });

  test('rejects credentials and oversized values before they can be stored or sent', () => {
    expect(() => parseProviderOptionsText('{"gateway":{"apiKey":"secret"}}')).toThrow(
      'PROVIDER_OPTIONS_SENSITIVE_FIELD'
    );
    expect(() =>
      validateProviderOptions({ value: 'x'.repeat(PROVIDER_OPTIONS_MAX_CHARS) })
    ).toThrow('PROVIDER_OPTIONS_TOO_LARGE');
  });
});
