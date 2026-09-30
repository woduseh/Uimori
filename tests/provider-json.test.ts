import { canonicalJson } from '../core/canonical-json.js';
import { expect, test } from 'vitest';
import { redactDiagnosticJson } from '../core/provider-diagnostic-json.js';

test('diagnostic redaction handles nested fields and literal secrets without changing its input', () => {
  const input = {
    message: 'before synthetic-key after synthetic-key',
    nested: [{ authorization: 'value', 'x-api-key': 'value', password: 'value' }],
    count: 3,
    empty: null,
  };
  const original = structuredClone(input);
  expect(redactDiagnosticJson(input, 'synthetic-key')).toEqual({
    message: 'before [REDACTED] after [REDACTED]',
    nested: [{ authorization: '[REDACTED]', 'x-api-key': '[REDACTED]', password: '[REDACTED]' }],
    count: 3,
    empty: null,
  });
  expect(input).toEqual(original);
  expect(redactDiagnosticJson({ api_key: 'hidden', text: 'visible' })).toEqual({
    api_key: '[REDACTED]',
    text: 'visible',
  });
});

test('provider canonical JSON sorts nested object keys and preserves array order and scalar bytes', () => {
  expect(canonicalJson({ z: [3, { b: true, a: null }], a: '한글\n"' })).toBe(
    '{"a":"한글\\n\\"","z":[3,{"a":null,"b":true}]}'
  );
});
