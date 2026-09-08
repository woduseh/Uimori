import { afterEach, expect, test, vi } from 'vitest';
import {
  readProviderHttpDiagnostic,
  PROVIDER_ERROR_BODY_LIMIT,
} from '../core/provider-http-error.js';
import {
  executeProvider,
  type ProviderConnection,
  type ProviderRequest,
} from '../core/transport.js';

afterEach(() => vi.unstubAllGlobals());
const secret = 'synthetic-secret-value';
const body = {
  error: {
    code: 'unsupported_value',
    status: 'INVALID_ARGUMENT',
    param: 'messages[2].role',
    message: `Echoed prompt ${secret}`,
    authorization: secret,
    details: [
      { fieldViolations: [{ field: 'generationConfig.responseSchema', description: secret }] },
    ],
  },
};
test('only explicit diagnostic fields survive, never provider messages or unknown fields', async () => {
  const response = new Response(JSON.stringify(body), {
    status: 400,
    headers: { 'x-request-id': 'req_123', authorization: secret },
  });
  expect(await readProviderHttpDiagnostic(response, new AbortController().signal, secret)).toEqual({
    httpStatus: 400,
    providerCode: 'unsupported_value',
    providerStatus: 'INVALID_ARGUMENT',
    requestId: 'req_123',
    fields: ['messages[2].role', 'generationConfig.responseSchema'],
    bodyState: 'parsed',
  });
  const hostile = new Response(
    JSON.stringify({
      error: {
        code: secret,
        status: secret,
        param: secret,
        type: 'arbitrary_token',
        message: secret,
      },
    }),
    { status: 400, headers: { 'x-request-id': secret } }
  );
  expect(await readProviderHttpDiagnostic(hostile, new AbortController().signal, secret)).toEqual({
    httpStatus: 400,
    bodyState: 'parsed',
  });
});

test.each(['not JSON', '[{}]', '{"error":null}'])(
  'invalid bodies preserve status without excerpts: %s',
  async (value) => {
    expect(
      await readProviderHttpDiagnostic(
        new Response(value, { status: 502 }),
        new AbortController().signal
      )
    ).toEqual({ httpStatus: 502, bodyState: 'invalid' });
  }
);

test('byte cap cancels body and never extracts from an oversized prefix', async () => {
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
        controller.enqueue(new Uint8Array(PROVIDER_ERROR_BODY_LIMIT));
      },
      cancel,
    }),
    { status: 400 }
  );
  expect(await readProviderHttpDiagnostic(response, new AbortController().signal)).toEqual({
    httpStatus: 400,
    bodyState: 'too-large',
  });
  expect(cancel).toHaveBeenCalledOnce();
});

const variants: ProviderConnection[] = [
  {
    id: 'compatible',
    protocol: 'openai-chat-v1',
    endpoint: 'https://synthetic.invalid/v1',
    credentialEnv: 'SYNTHETIC_KEY',
  },
  {
    id: 'vertex',
    protocol: 'vertex-gemini-v1',
    endpoint:
      'https://aiplatform.googleapis.com/v1/projects/synthetic/locations/global/publishers/google/models',
    credentialEnv: 'SYNTHETIC_KEY',
  },
];
const request: ProviderRequest = {
  role: 'translation',
  modelId: 'gemini-3.8-flash',
  stable: { contract: 'Synthetic translation', tools: [] },
  input: { task: 'Translate synthetic text', controls: {} },
};
test.each(variants)('$protocol retains safe HTTP diagnostics without retry', async (connection) => {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 400 }));
  vi.stubGlobal('fetch', fetch);
  const result = await executeProvider(connection, request, {
    signal: new AbortController().signal,
    resolveCredential: () => secret,
    approvedOrigins: ['https://synthetic.invalid'],
  });
  expect(result).toMatchObject({
    status: 'error',
    error: { code: 'HTTP_400', diagnostic: { httpStatus: 400, providerCode: 'unsupported_value' } },
  });
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(fetch).toHaveBeenCalledOnce();
});

test.each(
  variants.flatMap((connection) => ['cancel', 'timeout'].map((mode) => ({ connection, mode })))
)('$connection.protocol pending HTTP error body honors $mode', async ({ connection, mode }) => {
  const cancel = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 400 }))
  );
  const controller = new AbortController();
  const pending = executeProvider(connection, request, {
    signal: controller.signal,
    timeoutMs: mode === 'timeout' ? 20 : 1000,
    resolveCredential: () => secret,
    approvedOrigins: ['https://synthetic.invalid'],
  });
  if (mode === 'cancel') setTimeout(() => controller.abort(), 20);
  const result = await pending;
  expect(result).toMatchObject({
    status: mode === 'cancel' ? 'cancelled' : 'error',
    error: { code: mode === 'cancel' ? 'CANCELLED' : 'TIMEOUT' },
  });
  expect(cancel).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledOnce();
});
