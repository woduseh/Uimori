import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  PROVIDER_ERROR_BODY_LIMIT,
  PROVIDER_ERROR_MESSAGE_LIMIT,
  readProviderHttpDiagnostic,
} from '../core/provider-http-error.js';

const signal = () => new AbortController().signal;
const errorResponse = (error: unknown, status = 400, headers?: HeadersInit) =>
  new Response(JSON.stringify({ error }), { status, headers });

test('keeps useful owner-facing explanations and removes the request credential', async () => {
  const key = 'sk-private-test-key';
  const result = await readProviderHttpDiagnostic(
    errorResponse(
      {
        code: 'unsupported_value',
        status: 'INVALID_ARGUMENT',
        param: 'reasoning.effort',
        message: `reasoning.effort must be low, medium or high; got xhigh. Credential ${key}`,
        authorization: key,
        debug: { request: 'not part of the diagnostic' },
      },
      400,
      { 'x-request-id': 'request_123' }
    ),
    signal(),
    key
  );
  assert.deepEqual(result, {
    httpStatus: 400,
    bodyState: 'parsed',
    requestId: 'request_123',
    providerCode: 'unsupported_value',
    providerStatus: 'INVALID_ARGUMENT',
    fields: ['reasoning.effort'],
    message: 'reasoning.effort must be low, medium or high; got xhigh. Credential [REDACTED]',
  });
  assert.ok(!JSON.stringify(result).includes(key));
  assert.ok(!JSON.stringify(result).includes('not part of the diagnostic'));
});

test('keeps bounded unknown provider codes, statuses and explicit parameter names', async () => {
  const result = await readProviderHttpDiagnostic(
    errorResponse({
      code: 'custom_backend_error',
      status: 'CUSTOM_REJECTION',
      param: 'sampling.min_p',
      message: 'min_p is not supported by this model.',
    }),
    signal()
  );
  assert.equal(result.providerCode, 'custom_backend_error');
  assert.equal(result.providerStatus, 'CUSTOM_REJECTION');
  assert.deepEqual(result.fields, ['sampling.min_p']);
  assert.equal(result.message, 'min_p is not supported by this model.');
});

test('does not expose credentials through metadata or request IDs', async () => {
  const key = 'private-test-key';
  const result = await readProviderHttpDiagnostic(
    errorResponse(
      {
        code: key,
        status: key,
        param: key,
        message: `Key: ${key}`,
      },
      400,
      { 'x-request-id': key }
    ),
    signal(),
    key
  );
  assert.equal(result.providerCode, undefined);
  assert.equal(result.providerStatus, undefined);
  assert.equal(result.requestId, undefined);
  assert.equal(result.fields, undefined);
  assert.equal(result.message, 'Key: [REDACTED]');
});

test('infers known fields from prose without interpreting quoted values as field paths', async () => {
  const result = await readProviderHttpDiagnostic(
    errorResponse({
      message: "'reasoning.effort' must be one of 'low', 'medium', 'high'; got 'xhigh'.",
    }),
    signal()
  );
  assert.deepEqual(result.fields, ['reasoning.effort']);
  assert.ok(result.message?.includes("'low', 'medium', 'high'"));
});

test('collects explicit nested field violations, preserves indices and removes duplicates', async () => {
  const result = await readProviderHttpDiagnostic(
    errorResponse({
      param: 'messages[2].role',
      details: [
        {
          fieldViolations: [
            { field: 'messages[2].role', description: 'not copied' },
            { field: 'generationConfig.custom_option2' },
          ],
        },
      ],
    }),
    signal()
  );
  assert.deepEqual(result.fields, ['messages[2].role', 'generationConfig.custom_option2']);
  assert.ok(!JSON.stringify(result).includes('not copied'));
});

test('limits field paths and rejects malformed metadata', async () => {
  const result = await readProviderHttpDiagnostic(
    errorResponse({
      code: '<html>bad</html>',
      type: 'compatible_error',
      status: 'a'.repeat(129),
      param: 'not a field',
      details: [
        { fieldViolations: Array.from({ length: 12 }, (_, n) => ({ field: `custom${n}` })) },
      ],
    }),
    signal()
  );
  assert.equal(result.providerCode, 'compatible_error');
  assert.equal(result.providerStatus, undefined);
  assert.equal(result.fields?.length, 8);
});

test('preserves numeric HTTP-like error codes', async () => {
  const result = await readProviderHttpDiagnostic(errorResponse({ code: 503 }, 503), signal());
  assert.equal(result.providerCode, 503);
});

test('non-JSON proxy errors remain available as plain text, not HTML', async () => {
  const result = await readProviderHttpDiagnostic(
    new Response('<h1>upstream connection refused</h1>', { status: 502 }),
    signal()
  );
  assert.equal(result.bodyState, 'invalid');
  assert.equal(result.message, '<h1>upstream connection refused</h1>');
});

test('accepts a bounded top-level message without copying arbitrary JSON', async () => {
  const result = await readProviderHttpDiagnostic(
    new Response(JSON.stringify({ message: 'Proxy unavailable', debug: 'private request' }), {
      status: 502,
    }),
    signal()
  );
  assert.equal(result.message, 'Proxy unavailable');
  assert.ok(!JSON.stringify(result).includes('private request'));
});

for (const body of ['[{}]', '{"error":null}', '{}']) {
  test(`does not turn a JSON document without an error message into freeform detail: ${body}`, async () => {
    assert.deepEqual(
      await readProviderHttpDiagnostic(new Response(body, { status: 400 }), signal()),
      {
        httpStatus: 400,
        bodyState: 'invalid',
      }
    );
  });
}

test('keeps empty responses empty', async () => {
  assert.deepEqual(
    await readProviderHttpDiagnostic(new Response(null, { status: 503 }), signal()),
    {
      httpStatus: 503,
      bodyState: 'empty',
    }
  );
});

test('rejects invalid UTF-8 without manufacturing replacement text', async () => {
  const result = await readProviderHttpDiagnostic(
    new Response(new Uint8Array([0xff, 0xfe]), { status: 400 }),
    signal()
  );
  assert.deepEqual(result, { httpStatus: 400, bodyState: 'invalid' });
});

test('removes credentials before clipping the displayed message', async () => {
  const key = 'secret-that-crosses-the-display-cut';
  const result = await readProviderHttpDiagnostic(
    errorResponse({
      message: 'a'.repeat(PROVIDER_ERROR_MESSAGE_LIMIT - 3) + key + ' trailing text',
    }),
    signal(),
    key
  );
  assert.equal(result.message?.length, PROVIDER_ERROR_MESSAGE_LIMIT);
  assert.ok(result.message?.endsWith('…'));
  assert.ok(!result.message?.includes('secret'));
  assert.ok(!result.message?.includes(key));
});

test('masks authorization-shaped values and strips control characters', async () => {
  const result = await readProviderHttpDiagnostic(
    errorResponse({
      message: 'Authorization: Bearer another-secret\ninvalid\u0000 option',
    }),
    signal()
  );
  assert.equal(result.message, 'Authorization: Bearer [REDACTED]\ninvalid option');
});

test('does not return any partial body when the byte limit is exceeded', async () => {
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(PROVIDER_ERROR_BODY_LIMIT + 1));
    },
    cancel() {
      cancelled++;
    },
  });
  const result = await readProviderHttpDiagnostic(new Response(body, { status: 400 }), signal());
  assert.deepEqual(result, { httpStatus: 400, bodyState: 'too-large' });
  assert.equal(cancelled, 1);
});

test('the byte limit includes all chunks, not only a content-length header', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ error: { message: 'too big' } }));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.enqueue(new Uint8Array(PROVIDER_ERROR_BODY_LIMIT));
    },
  });
  const result = await readProviderHttpDiagnostic(
    new Response(body, { status: 400, headers: { 'content-length': '1' } }),
    signal()
  );
  assert.equal(result.bodyState, 'too-large');
  assert.equal(result.message, undefined);
});

test('honors an already aborted signal', async () => {
  const controller = new AbortController();
  const reason = new Error('cancel test');
  controller.abort(reason);
  await assert.rejects(
    readProviderHttpDiagnostic(errorResponse({ message: 'ignored' }), controller.signal),
    (error) => error === reason
  );
});

test('cancellation terminates a pending body read without waiting for the producer', async () => {
  const controller = new AbortController();
  const reason = new Error('cancel pending');
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      return new Promise<void>(() => {});
    },
  });
  const pending = readProviderHttpDiagnostic(
    new Response(body, { status: 400 }),
    controller.signal
  );
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
});

test('body read errors are unavailable rather than successful diagnostics', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error('stream failed'));
    },
  });
  const result = await readProviderHttpDiagnostic(new Response(body, { status: 500 }), signal());
  assert.deepEqual(result, { httpStatus: 500, bodyState: 'unavailable' });
});
