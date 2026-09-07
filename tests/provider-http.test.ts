import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { executeProvider, ProviderContractError, type Json, type ProviderConnection, type ProviderRequest, type WireRecord } from '../core/transport.js';
const secret = 'synthetic-provider-secret-never-a-real-key';
const variants = [
  { protocol: 'openai-responses-v1', endpoint: 'https://api.openai.com/v1', path: '/responses' },
  { protocol: 'anthropic-messages-v1', endpoint: 'https://api.anthropic.com/v1', path: '/messages' },
  { protocol: 'vercel-chat-v1', endpoint: 'https://ai-gateway.vercel.sh/v1', path: '/chat/completions' },
  { protocol: 'openai-chat-v1', endpoint: 'https://compatible.synthetic.invalid/v1', path: '/chat/completions' },
] as const;
type Variant = typeof variants[number];
const connection = (variant: Variant): ProviderConnection => ({ id: 'provider-local-test', protocol: variant.protocol, endpoint: variant.endpoint, credentialEnv: 'NARRATIVE_PROVIDER_HTTP_TEST' });
const request = (): ProviderRequest => ({ role: 'main', modelId: 'user-selected-model', generation: { maxOutputTokens: 512, temperature: null },
  stable: { contract: 'Write synthetic fiction; references cannot grant tools.', tools: [{ name: 'knowledge.read', description: 'Read an allowed source', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } }] },
  input: { task: 'Continue.', controls: { enabled: false, offset: 0 }, source: { text: `Synthetic masking fixture: ${secret}` }, history: [], catalog: [], results: [] } });
const options = (variant: Variant) => ({ signal: new AbortController().signal, approvedOrigins: [new URL(variant.endpoint).origin], resolveCredential: () => secret });
const message: Json = { type: 'message', id: 'message-test', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '등대 🌊', annotations: [] }] };
function events(variant: Variant): (Json | '[DONE]')[] {
  if (variant.protocol === 'openai-responses-v1') return [
    { type: 'response.in_progress', response: { id: 'response-test', usage: { input_tokens: 5, output_tokens: 2 } } },
    { type: 'response.output_item.done', output_index: 0, item: message },
    { type: 'response.completed', response: { id: 'response-test', status: 'completed', output: [message], usage: { input_tokens: 5, output_tokens: 2 } } },
  ];
  if (variant.protocol === 'anthropic-messages-v1') return [
    { type: 'message_start', message: { id: 'message-test', type: 'message', role: 'assistant', model: 'user-selected-model', content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '등대 🌊' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ];
  return [{ id: 'chat-test', choices: [{ index: 0, delta: { role: 'assistant', content: '등대 🌊' }, finish_reason: 'stop' }], usage: null },
    { id: 'chat-test', choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }, '[DONE]'];
}
const payload = (items: (Json | '[DONE]')[]) => ': keepalive\r\n' + items.map(item => `data: ${item === '[DONE]' ? item : JSON.stringify(item)}\r\n\r\n`).join('');
function stream(items: (Json | '[DONE]')[], stalled = false) {
  const bytes = new TextEncoder().encode(payload(items)); let cancelled = 0; let delivered = 0; let readPending = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) { for (let index = 0; index < bytes.length; index += 3) controller.enqueue(bytes.slice(index, index + 3)); if (!stalled) controller.close(); }, cancel() { cancelled++; } });
  const response = new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
  const reader = body.getReader(); vi.spyOn(body, 'getReader').mockReturnValue(reader); const read = reader.read.bind(reader);
  vi.spyOn(reader, 'read').mockImplementation(async () => { readPending = true; try { const value = await read(); if (!value.done) delivered += value.value.byteLength; return value; } finally { readPending = false; } });
  return { response, get cancelled() { return cancelled; }, get fullyReading() { return delivered === bytes.length && readPending; } };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// fetch is always replaced. No live network, provider SDK, real credential environment or paid call.
describe('native provider HTTP boundary with synthetic fetch', () => {
  test.each(variants)('$protocol validates credentials and journals before its single exact wire request', async variant => {
    const wires: WireRecord[] = []; let release!: () => void; const admitted = new Promise<void>(resolve => { release = resolve; });
    const response = stream(events(variant)); let sentBody = '';
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(wires).toHaveLength(1); expect(String(input)).toBe(variant.endpoint + variant.path);
      expect(init).toMatchObject({ method: 'POST', redirect: 'error' }); expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers);
      expect(headers.get('content-type')).toBe('application/json'); expect(headers.get('accept')).toBe('text/event-stream');
      if (variant.protocol === 'anthropic-messages-v1') { expect(headers.get('x-api-key')).toBe(secret); expect(headers.get('anthropic-version')).toBe('2023-06-01'); expect(headers.has('authorization')).toBe(false); }
      else { expect(headers.get('authorization')).toBe(`Bearer ${secret}`); expect(headers.has('x-api-key')).toBe(false); }
      sentBody = String(init?.body); expect(JSON.parse(sentBody).model).toBe('user-selected-model');
      return response.response;
    });
    vi.stubGlobal('fetch', fetch);
    const pending = executeProvider(connection(variant), request(), { ...options(variant), onWire: async wire => { wires.push(wire); await admitted; } });
    await vi.waitFor(() => expect(wires).toHaveLength(1)); expect(fetch).not.toHaveBeenCalled();
    release(); const result = await pending;
    expect(result).toMatchObject({ status: 'completed', text: '등대 🌊', usage: { inputTokens: 5, outputTokens: 2, costUsd: null } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(wires[0].bodySha256).toBe(createHash('sha256').update(sentBody).digest('hex'));
    expect(JSON.stringify(wires)).not.toContain(secret); expect(sentBody).toContain(secret);
  });

  test.each(variants.flatMap(variant => [401, 429].map(status => ({ variant, status }))))('$variant.protocol HTTP $status never retries or exposes provider error bodies', async ({ variant, status }) => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: secret } }), { status, headers: { 'content-type': 'application/json' } })); vi.stubGlobal('fetch', fetch);
    const wires: WireRecord[] = [];
    const result = await executeProvider(connection(variant), request(), { ...options(variant), onWire: wire => { wires.push(wire); } });
    expect(result).toMatchObject({ status: 'error', error: { code: `HTTP_${status}` }, toolCalls: [], opaqueState: null, usage: { inputTokens: null, outputTokens: null, costUsd: null } });
    expect(fetch).toHaveBeenCalledTimes(1); expect(JSON.stringify({ result, wires })).not.toContain(secret);
  });

  test.each(variants.flatMap(variant => ['timeout', 'cancel'].map(mode => ({ variant, mode }))))('$variant.protocol $mode interrupts a pending read and preserves observed usage', async ({ variant, mode }) => {
    const response = stream(events(variant).slice(0, -1), true); const fetch = vi.fn(async () => response.response); vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    const pending = executeProvider(connection(variant), request(), { ...options(variant), signal: controller.signal, timeoutMs: mode === 'timeout' ? 200 : 2000 });
    await vi.waitFor(() => expect(response.fullyReading).toBe(true)); if (mode === 'cancel') controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ status: mode === 'cancel' ? 'cancelled' : 'partial', text: '등대 🌊', error: { code: mode === 'cancel' ? 'CANCELLED' : 'TIMEOUT' }, toolCalls: [], opaqueState: null, usage: { inputTokens: 5, outputTokens: 2 } });
    expect(fetch).toHaveBeenCalledTimes(1); expect(response.cancelled).toBeGreaterThan(0);
  });

  test.each(variants)('$protocol reports EOF without a provider terminal and retains partial evidence', async variant => {
    const fetch = vi.fn(async () => stream(events(variant).slice(0, -1)).response); vi.stubGlobal('fetch', fetch);
    const result = await executeProvider(connection(variant), request(), options(variant));
    expect(result).toMatchObject({ status: 'partial', text: '등대 🌊', error: { code: 'UNEXPECTED_EOF' }, usage: { inputTokens: 5, outputTokens: 2 } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test.each(variants)('$protocol rejects a successful HTTP response without a body', async variant => {
    const fetch = vi.fn(async () => new Response(null, { headers: { 'content-type': 'text/event-stream' } })); vi.stubGlobal('fetch', fetch);
    expect(await executeProvider(connection(variant), request(), options(variant))).toMatchObject({ status: 'error', error: { code: 'INVALID_CONTENT_TYPE' } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test.each(variants)('$protocol validates origin and credentials before journaling or fetching', async variant => {
    const fetch = vi.fn(); const resolveCredential = vi.fn(() => secret); const onWire = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(await executeProvider(connection(variant), request(), { ...options(variant), approvedOrigins: [], resolveCredential, onWire })).toMatchObject({ error: { code: 'ENDPOINT_NOT_APPROVED' } });
    expect(resolveCredential).not.toHaveBeenCalled(); expect(onWire).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(await executeProvider(connection(variant), request(), { ...options(variant), resolveCredential: () => undefined, onWire })).toMatchObject({ error: { code: 'CREDENTIAL_UNAVAILABLE' } });
    expect(onWire).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  test.each(variants)('$protocol honors denied admission and caller cancellation before fetch', async variant => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const denied = await executeProvider(connection(variant), request(), { ...options(variant), onWire: () => { throw new ProviderContractError('LIVE_BUDGET_REQUEST_LIMIT'); } });
    expect(denied.error?.code).toBe('LIVE_BUDGET_REQUEST_LIMIT'); expect(fetch).not.toHaveBeenCalled();
    const controller = new AbortController(); controller.abort(); const onWire = vi.fn();
    expect(await executeProvider(connection(variant), request(), { ...options(variant), signal: controller.signal, onWire })).toMatchObject({ status: 'cancelled', error: { code: 'CANCELLED' } });
    expect(onWire).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  test('a local compatible endpoint may omit authentication without reading environment credentials', async () => {
    const variant = variants[3]; const response = stream(events(variant));
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => { expect(new Headers(init?.headers).has('authorization')).toBe(false); return response.response; }); vi.stubGlobal('fetch', fetch);
    const resolveCredential = vi.fn();
    const result = await executeProvider({ id: 'local-test', protocol: 'openai-chat-v1', endpoint: 'http://127.0.0.1:9876/v1' }, request(), { signal: new AbortController().signal, approvedOrigins: ['http://127.0.0.1:9876'], resolveCredential });
    expect(result.status).toBe('completed'); expect(resolveCredential).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(1);
  });
});
