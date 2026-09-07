import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { providerFetchOptions, transportFailureCode } from '../core/provider-fetch.js';
import { executeProvider, type ProviderConnection, type ProviderRequest, type WireRecord } from '../core/transport.js';
import { loopbackProvider, sse } from './fixtures/loopback-provider.js';

const exec = promisify(execFile);
const secret = 'synthetic-provider-timeout-secret-never-a-real-key';
const close: (() => Promise<void>)[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const cleanup of close.splice(0)) await cleanup(); });

const variants: ProviderConnection[] = [
  { id: 'vertex-timeout', protocol: 'vertex-gemini-v1', endpoint: 'https://aiplatform.googleapis.com/v1/projects/synthetic-project/locations/global/publishers/google/models', credentialEnv: 'NARRATIVE_PROVIDER_TIMEOUT_TEST' },
  { id: 'chat-timeout', protocol: 'openai-chat-v1', endpoint: 'https://compatible.synthetic.invalid/v1', credentialEnv: 'NARRATIVE_PROVIDER_TIMEOUT_TEST' },
];
const request = (connection: ProviderConnection): ProviderRequest => ({ role: 'main', modelId: connection.protocol === 'vertex-gemini-v1' ? 'gemini-3.8-flash' : 'synthetic-model',
  stable: { contract: 'Write synthetic fiction.', tools: [] }, generation: { maxOutputTokens: 512, temperature: null },
  input: { task: 'Continue.', controls: {}, source: { facts: [] }, history: [], catalog: [], results: [] } });
const partial = (connection: ProviderConnection) => connection.protocol === 'vertex-gemini-v1'
  ? sse({ candidates: [{ content: { role: 'model', parts: [{ text: 'Observed before the deadline.' }] } }] }) + sse({ usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 } })
  : sse({ id: 'chat-timeout', choices: [{ index: 0, delta: { role: 'assistant', content: 'Observed before the deadline.' }, finish_reason: null }], usage: null }) + sse({ id: 'chat-timeout', choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } });

describe('provider-specific HTTP dispatcher and safe failure codes', () => {
  test.each(['headers', 'body'])('native Node fetch crosses the actual Undici 300s %s boundary using virtual time', async phase => {
    const result = await exec(process.execPath, [fileURLToPath(new URL('./fixtures/provider-timeout-clock.mjs', import.meta.url)), phase], { timeout: 8000, maxBuffer: 32_768 });
    expect(JSON.parse(result.stdout)).toEqual({ phase, beforeSeconds: 295, afterSeconds: 315, baselineCode: phase === 'headers' ? 'UND_ERR_HEADERS_TIMEOUT' : 'UND_ERR_BODY_TIMEOUT', fixedStatus: 'completed', requests: 2, requestRetries: 0, globalDispatcherUnchanged: true, secretLeaked: false });
  });

  test.each(variants.flatMap(connection => ['headers', 'body'].flatMap(phase => ['timeout', 'cancel'].map(mode => ({ connection, phase, mode })))))('$connection.protocol $phase $mode closes the native local request without retry', async ({ connection, phase, mode }) => {
    let responseClosed = false; let readingBody = false;
    const local = await loopbackProvider((_captured, response) => {
      response.once('close', () => { responseClosed = true; });
      if (phase === 'body') { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(partial(connection)); }
    }); close.push(local.close);
    const nativeFetch = globalThis.fetch;
    const send = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input).startsWith(connection.endpoint + '/')).toBe(true);
      expect(init).toMatchObject({ redirect: 'error', method: 'POST' });
      expect((init as ReturnType<typeof providerFetchOptions>).dispatcher).toBeDefined();
      const response = await nativeFetch(local.endpoint, init);
      if (response.body) {
        const reader = response.body.getReader(); const read = reader.read.bind(reader);
        vi.spyOn(response.body, 'getReader').mockReturnValue(reader);
        vi.spyOn(reader, 'read').mockImplementation(async () => { const value = await read(); if (!value.done) readingBody = true; return value; });
      }
      return response;
    }); vi.stubGlobal('fetch', send);
    const controller = new AbortController(); const wires: WireRecord[] = [];
    const pending = executeProvider(connection, request(connection), { signal: controller.signal, timeoutMs: mode === 'timeout' ? 400 : 5000, approvedOrigins: [new URL(connection.endpoint).origin], resolveCredential: () => secret, onWire: wire => { wires.push(wire); } });
    await vi.waitFor(() => { expect(local.requests).toHaveLength(1); if (phase === 'body') expect(readingBody).toBe(true); });
    if (mode === 'cancel') controller.abort(new Error(secret));
    const result = await pending;
    expect(result.status).toBe(mode === 'cancel' ? 'cancelled' : phase === 'body' ? 'partial' : 'error');
    expect(result.error).toEqual({ code: mode === 'cancel' ? 'CANCELLED' : 'TIMEOUT' });
    expect(result.text).toBe(phase === 'body' ? 'Observed before the deadline.' : '');
    if (phase === 'body') expect(result.usage).toMatchObject({ inputTokens: 5, outputTokens: 2 });
    await vi.waitFor(() => expect(responseClosed).toBe(true));
    expect(send).toHaveBeenCalledTimes(1); expect(local.requests).toHaveLength(1); expect(wires).toHaveLength(1);
    expect(JSON.stringify({ result, wires })).not.toContain(secret);
  });

  test.each(variants.flatMap(connection => ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].map(code => ({ connection, code }))))('$connection.protocol exposes only allowlisted cause $code', async ({ connection, code }) => {
    const send = vi.fn(async () => { throw new TypeError(secret, { cause: Object.assign(new Error(secret), { code, headers: { authorization: secret }, body: secret, url: `https://${secret}.invalid` }) }); }); vi.stubGlobal('fetch', send);
    const result = await executeProvider(connection, request(connection), { signal: new AbortController().signal, approvedOrigins: [new URL(connection.endpoint).origin], resolveCredential: () => secret });
    expect(result.error).toEqual({ code }); expect(send).toHaveBeenCalledTimes(1); expect(JSON.stringify(result)).not.toContain(secret);
  });

  test('unknown, cyclic and throwing diagnostic properties never disclose arbitrary error data', () => {
    const cyclic: { code: string; cause?: unknown } = { code: secret }; cyclic.cause = cyclic;
    for (const error of [new Error(secret), { code: secret, cause: { message: secret } }, cyclic, { get code() { throw new Error(secret); } }, secret]) expect(transportFailureCode(error)).toBe('TRANSPORT_ERROR');
    expect(transportFailureCode({ cause: { cause: { code: 'UND_ERR_SOCKET', message: secret } } })).toBe('UND_ERR_SOCKET');
  });
});
