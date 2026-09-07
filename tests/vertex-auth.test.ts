import { afterEach, expect, test, vi } from 'vitest';
import { GoogleAuth } from 'google-auth-library';
import { vertexAccessToken } from '../core/vertex-auth.js';
import { executeProvider, type ProviderRequest } from '../core/transport.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const request: ProviderRequest = {
  role: 'main',
  modelId: 'gemini-3.8-flash',
  stable: { contract: 'Synthetic only', tools: [] },
  input: { task: 'A synthetic lamp.', controls: {} },
};
const connection = {
  id: 'adc-fixture',
  protocol: 'vertex-gemini-v1' as const,
  endpoint:
    'https://aiplatform.googleapis.com/v1/projects/synthetic-project/locations/global/publishers/google/models',
};

test('L01 P04 missing ADC and SDK auth errors cannot disclose credentials or start a model request', async () => {
  vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '');
  const getToken = vi.spyOn(GoogleAuth.prototype, 'getAccessToken');
  await expect(vertexAccessToken(new AbortController().signal)).rejects.toMatchObject({
    code: 'CREDENTIAL_UNAVAILABLE',
  });
  expect(getToken).not.toHaveBeenCalled();
  vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', 'SYNTHETIC_AUTH_KEY_PATH');
  getToken.mockRejectedValue(new Error('SYNTHETIC_PRIVATE_KEY_AND_PATH_MUST_NOT_LEAK'));
  const generation = vi.fn(() => {
    throw new Error('Unexpected model request');
  });
  vi.stubGlobal('fetch', generation);
  const onWire = vi.fn();
  const result = await executeProvider(connection, request, {
    approvedOrigins: ['https://aiplatform.googleapis.com'],
    signal: new AbortController().signal,
    onWire,
  });
  expect(result).toMatchObject({ status: 'error', error: { code: 'CREDENTIAL_UNAVAILABLE' } });
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC_');
  expect(generation).not.toHaveBeenCalled();
  expect(onWire).not.toHaveBeenCalled();
});

test('L01 P05 abort while obtaining ADC prevents late token from starting generation', async () => {
  vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', 'SYNTHETIC_AUTH_ABORT_PATH');
  let finish!: (token: string) => void;
  const token = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const getToken = vi.spyOn(GoogleAuth.prototype, 'getAccessToken').mockReturnValue(token);
  const generation = vi.fn(() => {
    throw new Error('Unexpected model request');
  });
  vi.stubGlobal('fetch', generation);
  const controller = new AbortController();
  const onWire = vi.fn();
  const pending = executeProvider(connection, request, {
    approvedOrigins: ['https://aiplatform.googleapis.com'],
    signal: controller.signal,
    onWire,
  });
  await vi.waitFor(() => expect(getToken).toHaveBeenCalledOnce());
  controller.abort(new Error('SYNTHETIC_ABORT_REASON_MUST_NOT_LEAK'));
  const result = await pending;
  expect(result).toMatchObject({ status: 'cancelled', error: { code: 'CANCELLED' } });
  finish('SYNTHETIC_LATE_TOKEN');
  await token;
  await Promise.resolve();
  expect(generation).not.toHaveBeenCalled();
  expect(onWire).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC_');
});
