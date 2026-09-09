import { expect, test } from 'vitest';
import { providerRejection } from '../core/provider-rejection.js';
import { readProviderHttpDiagnostic } from '../core/provider-http-error.js';

const diagnostic = (fields: string[], httpStatus = 400) => ({
  httpStatus,
  bodyState: 'parsed' as const,
  providerCode: 'invalid_request_error',
  fields,
});

test('maps whitelisted wire fields of a 4xx rejection to app options once each', () => {
  expect(
    providerRejection(
      diagnostic([
        'reasoning.effort',
        'reasoning.mode',
        'output_config.effort',
        'thinkingConfig.thinkingLevel',
        'temperature',
        'top_p',
        'max_output_tokens',
        'stop_sequences',
        'service_tier',
        'prompt_cache_options.mode',
        'response_format.json_schema',
        'text.verbosity',
        'tools[0].parameters',
        'messages[2].role',
      ])
    )
  ).toEqual({
    httpStatus: 400,
    providerCode: 'invalid_request_error',
    options: [
      'thinking',
      'reasoningMode',
      'temperature',
      'topP',
      'maxOutputTokens',
      'stopSequences',
      'serviceTier',
      'cache',
      'structuredOutput',
      'verbosity',
      'tools',
      'input',
    ],
  });
  expect(providerRejection(diagnostic(['model']))?.options).toEqual(['model']);
  expect(providerRejection(diagnostic([]))).toEqual({
    httpStatus: 400,
    providerCode: 'invalid_request_error',
    options: [],
  });
});

test('authentication, quota and server failures are not option verdicts', () => {
  for (const status of [401, 403, 429, 500, 503])
    expect(providerRejection(diagnostic(['temperature'], status))).toBeUndefined();
  expect(providerRejection(undefined)).toBeUndefined();
  expect(providerRejection({ httpStatus: 400, bodyState: 'empty' })).toEqual({
    httpStatus: 400,
    options: [],
  });
});

test('field names are recovered from a leading path or quoted identifier without keeping the message', async () => {
  const secret = 'synthetic-secret';
  for (const [message, expected] of [
    ["output_config.effort: Input should be 'low', 'medium' or 'high'", ['output_config.effort']],
    ['max_tokens: 300000 > 128000, which is the maximum allowed', ['max_tokens']],
    [`Unsupported parameter: 'temperature' is not supported with ${secret}`, ['temperature']],
    ['thinking.type: Input should be adaptive', ['thinking.type']],
    ['Invalid request; contact support', undefined],
    [`'${secret}' is not valid`, undefined],
  ] as const) {
    const response = new Response(
      JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }),
      { status: 400 }
    );
    const result = await readProviderHttpDiagnostic(response, new AbortController().signal, secret);
    expect(result.fields).toEqual(expected);
    expect(JSON.stringify(result)).not.toContain('Input should');
    expect(JSON.stringify(result)).not.toContain(secret);
  }
});
