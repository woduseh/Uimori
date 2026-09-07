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
const request = (variant: Variant): ProviderRequest => ({ role: 'main', modelId: variant.protocol === 'openai-responses-v1' ? 'gpt-5.6-sol' : variant.protocol === 'anthropic-messages-v1' ? 'claude-opus-5' : 'user-selected-model', generation: { maxOutputTokens: 512, temperature: null },
  stable: { contract: 'Write synthetic fiction; references cannot grant tools.', tools: [{ name: 'knowledge.read', description: 'Read an allowed source', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } }] },
  input: { task: 'Continue.', controls: { enabled: false, offset: 0 }, source: { text: `Synthetic masking fixture: ${secret}` }, history: [], catalog: [], results: [] } });
// Official providers need no operator configuration; compatible servers still require explicit approval.
const options = (variant: Variant) => ({ signal: new AbortController().signal, approvedOrigins: variant.protocol === 'openai-chat-v1' ? [new URL(variant.endpoint).origin] : [], resolveCredential: () => secret });
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
  test.each(variants.slice(0,2))('$protocol rejects unreviewed official models before reading credentials', async variant => {
    const fetch=vi.fn();const resolveCredential=vi.fn(()=>secret);const onWire=vi.fn();vi.stubGlobal('fetch',fetch);
    const input=request(variant);input.modelId='unreviewed-future-model';
    const result=await executeProvider(connection(variant),input,{...options(variant),resolveCredential,onWire});
    expect(result.error?.code).toBe('UNVERIFIED_MODEL_CAPABILITY');
    expect(resolveCredential).not.toHaveBeenCalled();expect(onWire).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
  });

  test.each(variants.slice(0,2))('$protocol sends the selected generation options and translation schema together', async variant => {
    const input=request(variant);input.role='translation';
    input.input.source={sourceRevision:'source-options',sourceHash:'hash-options',chunkId:'chunk-options'};
    input.generation=variant.protocol==='openai-responses-v1'
      ? {maxOutputTokens:8192,temperature:null,reasoningEffort:'high',reasoningMode:'pro',reasoningContext:'all_turns',verbosity:'low',serviceTier:'flex'}
      : {maxOutputTokens:8192,temperature:null,outputEffort:'max',thinkingMode:'adaptive',serviceTier:'standard_only',stopSequences:['END_SCENE']};
    const wires:WireRecord[]=[];
    const fetch=vi.fn(async(_input:RequestInfo|URL,init?:RequestInit)=>{
      const body=JSON.parse(String(init?.body));
      if(variant.protocol==='openai-responses-v1'){
        expect(body.reasoning).toEqual({effort:'high',mode:'pro',context:'all_turns'});
        expect(body.text.verbosity).toBe('low');expect(body.text.format.schema.properties.sourceHash.enum).toEqual(['hash-options']);
        expect(body.service_tier).toBe('flex');expect((wires[0].body as Record<string,Json>).reasoning).toEqual(body.reasoning);
      }else{
        expect(body.output_config.effort).toBe('max');expect(body.output_config.format.schema.properties.sourceHash.enum).toEqual(['hash-options']);
        expect(body.thinking).toEqual({type:'adaptive'});expect(body.service_tier).toBe('standard_only');expect(body.stop_sequences).toEqual(['END_SCENE']);
      }
      return stream(events(variant)).response;
    });vi.stubGlobal('fetch',fetch);
    expect((await executeProvider(connection(variant),input,{...options(variant),onWire:wire=>{wires.push(wire);}})).status).toBe('completed');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('Vercel does not receive native OpenAI options inferred from its routed model name', async () => {
    const variant=variants[2];const input=request(variant);input.modelId='openai/gpt-5.6-sol';input.generation!.verbosity='low';
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    expect((await executeProvider(connection(variant),input,options(variant))).error?.code).toBe('UNSUPPORTED_GENERATION_OPTIONS');
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([200,429])('official GPT Chat sends Flex once and preserves HTTP %s without changing tier', async status => {
    const variant=variants[3];const input=request(variant);input.modelId='gpt-6-astra';input.generation={maxOutputTokens:8192,temperature:null,reasoningEffort:'high',serviceTier:'flex'};
    const value={...connection(variant),endpoint:variants[0].endpoint};
    const fetch=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
      expect(String(url)).toBe('https://api.openai.com/v1/chat/completions');
      expect(JSON.parse(String(init?.body))).toMatchObject({model:'gpt-6-astra',service_tier:'flex',reasoning_effort:'high'});
      return status===200?stream(events(variant)).response:new Response(null,{status});
    });vi.stubGlobal('fetch',fetch);
    const result=await executeProvider(value,input,options(variants[0]));
    expect(result.status).toBe(status===200?'completed':'error');
    if(status===429)expect(result.error?.code).toBe('HTTP_429');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('Fable forced tool selection is refused before credential resolution and HTTP', async () => {
    const variant=variants[1];const input=request(variant);input.modelId='claude-fable-5-1';input.toolChoice='knowledge.read';
    const fetch=vi.fn();const resolveCredential=vi.fn(()=>secret);vi.stubGlobal('fetch',fetch);
    const result=await executeProvider(connection(variant),input,{...options(variant),resolveCredential});
    expect(result.error?.code).toBe('UNSUPPORTED_MODEL_TOOL_CHOICE');
    expect(resolveCredential).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
  });

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
      sentBody = String(init?.body); expect(JSON.parse(sentBody).model).toBe(request(variant).modelId);
      return response.response;
    });
    vi.stubGlobal('fetch', fetch);
    const pending = executeProvider(connection(variant), request(variant), { ...options(variant), onWire: async wire => { wires.push(wire); await admitted; } });
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
    const result = await executeProvider(connection(variant), request(variant), { ...options(variant), onWire: wire => { wires.push(wire); } });
    expect(result).toMatchObject({ status: 'error', error: { code: `HTTP_${status}` }, toolCalls: [], opaqueState: null, usage: { inputTokens: null, outputTokens: null, costUsd: null } });
    expect(fetch).toHaveBeenCalledTimes(1); expect(JSON.stringify({ result, wires })).not.toContain(secret);
  });

  test.each(variants.flatMap(variant => ['timeout', 'cancel'].map(mode => ({ variant, mode }))))('$variant.protocol $mode interrupts a pending read and preserves observed usage', async ({ variant, mode }) => {
    const response = stream(events(variant).slice(0, -1), true); const fetch = vi.fn(async () => response.response); vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    const pending = executeProvider(connection(variant), request(variant), { ...options(variant), signal: controller.signal, timeoutMs: mode === 'timeout' ? 200 : 2000 });
    await vi.waitFor(() => expect(response.fullyReading).toBe(true)); if (mode === 'cancel') controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ status: mode === 'cancel' ? 'cancelled' : 'partial', text: '등대 🌊', error: { code: mode === 'cancel' ? 'CANCELLED' : 'TIMEOUT' }, toolCalls: [], opaqueState: null, usage: { inputTokens: 5, outputTokens: 2 } });
    expect(fetch).toHaveBeenCalledTimes(1); expect(response.cancelled).toBeGreaterThan(0);
  });

  test.each(variants)('$protocol reports EOF without a provider terminal and retains partial evidence', async variant => {
    const fetch = vi.fn(async () => stream(events(variant).slice(0, -1)).response); vi.stubGlobal('fetch', fetch);
    const result = await executeProvider(connection(variant), request(variant), options(variant));
    expect(result).toMatchObject({ status: 'partial', text: '등대 🌊', error: { code: 'UNEXPECTED_EOF' }, usage: { inputTokens: 5, outputTokens: 2 } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test.each(variants)('$protocol rejects a successful HTTP response without a body', async variant => {
    const fetch = vi.fn(async () => new Response(null, { headers: { 'content-type': 'text/event-stream' } })); vi.stubGlobal('fetch', fetch);
    expect(await executeProvider(connection(variant), request(variant), options(variant))).toMatchObject({ status: 'error', error: { code: 'INVALID_CONTENT_TYPE' } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test.each(variants)('$protocol validates origin and credentials before journaling or fetching', async variant => {
    const fetch = vi.fn(); const resolveCredential = vi.fn(() => secret); const onWire = vi.fn(); vi.stubGlobal('fetch', fetch);
    const unapproved = { ...connection(variant), endpoint: 'https://unapproved.synthetic.invalid/v1' };
    expect(await executeProvider(unapproved, request(variant), { ...options(variant), approvedOrigins: [], resolveCredential, onWire })).toMatchObject({ error: { code: 'ENDPOINT_NOT_APPROVED' } });
    const malformed = { ...connection(variant), endpoint: variant.endpoint + '?redirect=unapproved' };
    expect(await executeProvider(malformed, request(variant), { ...options(variant), approvedOrigins: [new URL(variant.endpoint).origin], resolveCredential, onWire })).toMatchObject({ error: { code: 'ENDPOINT_NOT_APPROVED' } });
    expect(resolveCredential).not.toHaveBeenCalled(); expect(onWire).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(await executeProvider(connection(variant), request(variant), { ...options(variant), resolveCredential: () => undefined, onWire })).toMatchObject({ error: { code: 'CREDENTIAL_UNAVAILABLE' } });
    expect(onWire).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  test.each(variants)('$protocol honors denied admission and caller cancellation before fetch', async variant => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const denied = await executeProvider(connection(variant), request(variant), { ...options(variant), onWire: () => { throw new ProviderContractError('ATTEMPT_PERSISTENCE_FAILED'); } });
    expect(denied.error?.code).toBe('ATTEMPT_PERSISTENCE_FAILED'); expect(fetch).not.toHaveBeenCalled();
    const controller = new AbortController(); controller.abort(); const onWire = vi.fn();
    expect(await executeProvider(connection(variant), request(variant), { ...options(variant), signal: controller.signal, onWire })).toMatchObject({ status: 'cancelled', error: { code: 'CANCELLED' } });
    expect(onWire).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  test('a local compatible endpoint may omit authentication without reading environment credentials', async () => {
    const variant = variants[3]; const response = stream(events(variant));
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => { expect(new Headers(init?.headers).has('authorization')).toBe(false); return response.response; }); vi.stubGlobal('fetch', fetch);
    const resolveCredential = vi.fn();
    const result = await executeProvider({ id: 'local-test', protocol: 'openai-chat-v1', endpoint: 'http://127.0.0.1:9876/v1' }, request(variant), { signal: new AbortController().signal, approvedOrigins: ['http://127.0.0.1:9876'], resolveCredential });
    expect(result.status).toBe('completed'); expect(resolveCredential).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(1);
  });
});
