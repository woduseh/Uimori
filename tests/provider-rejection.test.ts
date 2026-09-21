import assert from 'node:assert/strict';
import { test } from 'vitest';
import { providerRejection } from '../core/provider-rejection.js';
import { readProviderHttpDiagnostic } from '../core/provider-http-error.js';

for (const [field, option] of [
  ['reasoning.effort', 'thinking'],
  ['reasoning.mode', 'reasoningMode'],
  ['reasoning.context', 'reasoningContext'],
  ['text.verbosity', 'verbosity'],
  ['temperature', 'temperature'],
  ['top_p', 'topP'],
  ['max_tokens', 'maxOutputTokens'],
  ['stop_sequences', 'stopSequences'],
  ['service_tier', 'serviceTier'],
  ['prompt_cache_options.mode', 'cache'],
  ['cache_control.type', 'cache'],
  ['response_format.json_schema.schema', 'structuredOutput'],
  ['model', 'model'],
  ['tools', 'tools'],
  ['messages[2].role', 'input'],
] as const) {
  test(`maps ${field} to ${option}`, () => {
    assert.deepEqual(
      providerRejection({ httpStatus: 400, bodyState: 'parsed', fields: [field] })?.options,
      [option]
    );
  });
}
test('keeps a provider explanation without inventing an app option for unknown fields', () => {
  assert.deepEqual(
    providerRejection({
      httpStatus: 400,
      bodyState: 'parsed',
      providerCode: 'custom_rejection',
      fields: ['min_p'],
      message: 'min_p is unavailable; omit it.',
    }),
    {
      httpStatus: 400,
      providerCode: 'custom_rejection',
      options: [],
      unmappedFields: ['min_p'],
      message: 'min_p is unavailable; omit it.',
    }
  );
});
test('deduplicates option groups', () => {
  assert.deepEqual(
    providerRejection({
      httpStatus: 400,
      bodyState: 'parsed',
      fields: ['thinkingConfig.thinkingBudget', 'reasoning.effort', 'temperature'],
    })?.options,
    ['thinking', 'temperature']
  );
});
for (const httpStatus of [200, 401, 403, 429, 500, 503]) {
  test(`does not call HTTP ${httpStatus} an option rejection`, () => {
    assert.equal(
      providerRejection({ httpStatus, bodyState: 'parsed', message: 'not an option verdict' }),
      undefined
    );
  });
}
test('an absent diagnostic has no rejection', () =>
  assert.equal(providerRejection(undefined), undefined));
test('propagates only the redacted detail from the HTTP boundary', async () => {
  const key = 'private-test-key';
  const diagnostic = await readProviderHttpDiagnostic(
    new Response(
      JSON.stringify({
        error: {
          code: 'unsupported_value',
          param: 'reasoning.effort',
          message: `Input should be 'low', 'medium', or 'high'. Request key ${key}`,
        },
      }),
      { status: 400 }
    ),
    new AbortController().signal,
    key
  );
  const rejection = providerRejection(diagnostic);
  assert.deepEqual(rejection?.options, ['thinking']);
  assert.ok(rejection?.message?.includes("Input should be 'low', 'medium', or 'high'"));
  assert.ok(!JSON.stringify(rejection).includes(key));
});
