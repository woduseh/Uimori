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

test('non-JSON proxy errors remain available as plain text, not HTML', async () => {
  const result = await readProviderHttpDiagnostic(
    new Response('<h1>upstream connection refused</h1>', { status: 502 }),
    signal()
  );
  assert.equal(result.bodyState, 'invalid');
  assert.equal(result.message, '<h1>upstream connection refused</h1>');
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
