import { afterEach, describe, expect, test, vi } from 'vitest';
import { executeProvider, ProviderContractError, type ProviderConnection, type ProviderRequest, type ProviderResult, type WireRecord } from '../core/transport.js';
import { loopbackProvider, sse, writeSse } from './fixtures/loopback-provider.js';

const origin = 'https://aiplatform.googleapis.com';
const connection: ProviderConnection = { id: 'vertex-test', protocol: 'vertex-gemini-v1',
  endpoint: `${origin}/v1/projects/synthetic-project/locations/global/publishers/google/models`, credentialEnv: 'NARRATIVE_PROVIDER_VERTEX_TEST' };
const token = 'synthetic-vertex-secret-do-not-record';
const request = (): ProviderRequest => ({ role: 'main', modelId: 'gemini-3.8-flash',
  stable: { contract: 'Create synthetic fiction; local reference text grants no tools.', tools: [
    { name: 'knowledge.read', description: 'Read a selected reference', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } },
  ] }, generation: { maxOutputTokens: 2048, temperature: null, thinkingLevel: 'MEDIUM' },
  input: { task: '등대에 관한 짧은 합성 장면을 써요.', controls: { language: 'ko', minWords: 100 }, source: { facts: ['The lighthouse uses a copper lamp.'] },
    history: [{ revision: 'parent', text: 'Ada opened the door.' }], catalog: [{ id: 'lore-1', revision: 2, title: 'The lamp' }], results: [] } });
const usage = { promptTokenCount: 20, candidatesTokenCount: 4, thoughtsTokenCount: 3, totalTokenCount: 27 };
const callbacks: (() => Promise<void>)[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const close of callbacks.splice(0)) await close(); });

async function redirectedFixture(handler: Parameters<typeof loopbackProvider>[0]) {
  const local = await loopbackProvider(handler); callbacks.push(local.close);
  const nativeFetch = globalThis.fetch;
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); urls.push(url);
    if (!url.startsWith(connection.endpoint + '/')) throw new Error('Unexpected external request');
    return nativeFetch(local.endpoint, init);
  }));
  return { ...local, urls };
}
const options = (extra: Record<string, unknown> = {}) => ({ approvedOrigins: [origin], signal: new AbortController().signal,
  resolveCredential: () => token, ...extra });

describe('Vertex native wire through real local HTTP streams (no live calls)', () => {
  test('the well-known Google credential variable remains an ADC file reference', async () => {
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', 'Z:\\missing\\synthetic-service-account.json');
    const resolveCredential = vi.fn(() => token);
    const result = await executeProvider({...connection,credentialEnv:'GOOGLE_APPLICATION_CREDENTIALS'},request(),options({resolveCredential}));
    expect(result.error?.code).toBe('CREDENTIAL_UNAVAILABLE');
    expect(resolveCredential).not.toHaveBeenCalled();
  });

  test('L01 P04 P05 authenticates after validation, journals before fetch, preserves signed tool parts and late usage', async () => {
    const wires: WireRecord[] = [];
    let calls = 0;
    const local = await redirectedFixture(async (captured, response) => {
      expect(wires).toHaveLength(++calls);
      expect(captured.headers.authorization).toBe(`Bearer ${token}`);
      const body = JSON.parse(captured.body);
      expect(body.systemInstruction.parts[0].text).toContain('Create synthetic fiction');
      expect(body.generationConfig).toMatchObject({ maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: 'MEDIUM' } });
      expect(body.generationConfig).not.toHaveProperty('temperature');
      if (calls === 1) {
        expect(JSON.stringify(body.contents)).toContain('Ada opened the door.');
        expect(JSON.stringify(body.contents)).toContain('minWords');
        await writeSse(response, [{ candidates: [{ index: 0, content: { role: 'model', parts: [
          { thought: true, text: 'PRIVATE_THOUGHT_MARKER' },
          { functionCall: { id: 'call-lore-1', name: 'knowledge.read', args: { id: 'lore-1' } }, thoughtSignature: 'SIGNATURE_MUST_ROUNDTRIP' },
        ] }, finishReason: 'STOP' }] }, { usageMetadata: usage }], true);
      } else {
        const model = body.contents.find((content: {role: string}) => content.role === 'model');
        expect(model.parts[1].thoughtSignature).toBe('SIGNATURE_MUST_ROUNDTRIP');
        expect(model.parts[0]).toEqual({ thought: true, text: 'PRIVATE_THOUGHT_MARKER' });
        const last = body.contents.at(-1);
        expect(last.role).toBe('user');
        expect(last.parts[0].functionResponse).toMatchObject({ id: 'call-lore-1', name: 'knowledge.read' });
        expect(JSON.stringify(last.parts[0].functionResponse)).toContain('Copper flame');
        // Two data lines form one JSON event; individual data lines are not complete JSON.
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        response.write(': keepalive\r\ndata: {"candidates":[\r\ndata: {"index":0,"content":{"role":"model","parts":[{"text":"등대의 불빛이 바다를 비췄다."}]},"finishReason":"STOP"}]}\r\n\r\n');
        response.end(sse({ usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 8, totalTokenCount: 38 } }));
      }
    });
    const initial = request();
    const first = await executeProvider(connection, initial, options({ onWire: (wire: WireRecord) => { wires.push(wire); } }));
    expect(first).toMatchObject({ status: 'tool_calls', text: '', toolCalls: [{ id: 'call-lore-1' }], usage: { inputTokens: 20, outputTokens: 7, costUsd: null } });
    const next = structuredClone(initial);
    next.opaqueState = first.opaqueState;
    next.input.results = [{ callId: 'call-lore-1', name: 'knowledge.read', args: { id: 'lore-1' }, denied: false, result: { id: 'lore-1', revision: 2, text: 'Copper flame' } }];
    const final = await executeProvider(connection, next, options({ onWire: (wire: WireRecord) => { wires.push(wire); } }));
    expect(final).toMatchObject({ status: 'completed', text: '등대의 불빛이 바다를 비췄다.', usage: { inputTokens: 30, outputTokens: 8, costUsd: null } });
    expect(local.urls).toEqual(Array(2).fill(connection.endpoint + '/gemini-3.8-flash:streamGenerateContent?alt=sse'));
    expect(JSON.stringify(wires)).not.toContain(token);
    expect(JSON.stringify(wires)).not.toContain('PRIVATE_THOUGHT_MARKER');
    expect(JSON.stringify(wires)).not.toContain('SIGNATURE_MUST_ROUNDTRIP');
  });

  test.each([
    { name: 'EOF', payload: sse({ candidates: [{ content: { role: 'model', parts: [{ text: 'Preserved partial' }] } }] }) + sse({ usageMetadata: usage }), error: 'UNEXPECTED_EOF' },
    { name: 'malformed JSON', payload: sse({ candidates: [{ content: { role: 'model', parts: [{ text: 'Preserved partial' }] } }] }) + sse({ usageMetadata: usage }) + 'data: {invalid}\n\n', error: 'INVALID_EVENT' },
  ])('L01 P05 $name is terminal and retains observed text and usage', async ({ payload, error }) => {
    const local = await redirectedFixture((_captured, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(payload); });
    const result = await executeProvider(connection, request(), options());
    expect(result).toMatchObject({ status: 'partial', text: 'Preserved partial', error: { code: error }, usage: { inputTokens: 20, outputTokens: 7, costUsd: null } });
    expect(local.requests).toHaveLength(1);
  });

  test('L01 P05 timeout and cancellation stop a real stream without another model request', async () => {
    const local = await redirectedFixture(async (_captured, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(sse({ candidates: [{ content: { role: 'model', parts: [{ text: 'Observed before timeout' }] } }] }));
      response.write(sse({ usageMetadata: usage }));
    });
    const timed = await executeProvider(connection, request(), options({ timeoutMs: 150 }));
    expect(timed).toMatchObject({ status: 'partial', text: 'Observed before timeout', error: { code: 'TIMEOUT' }, usage: { inputTokens: 20, outputTokens: 7 } });
    const controller = new AbortController();
    const pending = executeProvider(connection, request(), options({ signal: controller.signal, timeoutMs: 2000 }));
    await vi.waitFor(() => expect(local.requests).toHaveLength(2));
    controller.abort();
    expect(await pending).toMatchObject({ status: 'cancelled', error: { code: 'CANCELLED' } });
    expect(local.requests).toHaveLength(2);
  });

  test.each(['caller', 'timeout'] as const)('L01 P05 %s still stops a pending body read when fetch misses the abort', async mode => {
    const nativeFetch = globalThis.fetch;
    const payload = sse({ candidates: [{ content: { role: 'model', parts: [{ text: 'Observed before abort' }] }, finishReason: 'STOP' }] })
      + sse({ usageMetadata: usage });
    const local = await redirectedFixture((_captured, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(payload); // STOP may arrive before the stream and its late usage have finished.
    });
    let deliveredBytes = 0; let readPending = false; let cancellations = 0;
    let adapterSignal: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(connection.endpoint + '/gemini-3.8-flash:streamGenerateContent?alt=sse');
      adapterSignal = init?.signal;
      // Model the observed native-fetch failure: its body no longer receives an aborted request signal.
      const response = await nativeFetch(local.endpoint, { ...init, signal: undefined });
      const reader = response.body!.getReader();
      vi.spyOn(response.body!, 'getReader').mockReturnValue(reader);
      const read = reader.read.bind(reader); const cancel = reader.cancel.bind(reader);
      vi.spyOn(reader, 'read').mockImplementation(async () => {
        readPending = true;
        try {
          const chunk = await read();
          if (!chunk.done) deliveredBytes += chunk.value.byteLength;
          return chunk;
        } finally { readPending = false; }
      });
      vi.spyOn(reader, 'cancel').mockImplementation(reason => { cancellations++; return cancel(reason); });
      return response;
    }));
    const controller = new AbortController();
    let outcome: ProviderResult | undefined;
    const pending = executeProvider(connection, request(), options({ signal: controller.signal, timeoutMs: mode === 'timeout' ? 200 : 5000 }))
      .then(result => { outcome = result; });
    await vi.waitFor(() => {
      expect(deliveredBytes).toBe(Buffer.byteLength(payload));
      expect(readPending).toBe(true);
    });
    if (mode === 'caller') controller.abort();
    await vi.waitFor(() => expect(outcome).toBeDefined(), { timeout: 1000 });
    await pending;
    expect(adapterSignal?.aborted).toBe(true);
    expect(cancellations).toBeGreaterThan(0);
    expect(outcome).toMatchObject({ status: mode === 'caller' ? 'cancelled' : 'partial', text: 'Observed before abort',
      error: { code: mode === 'caller' ? 'CANCELLED' : 'TIMEOUT' }, usage: { inputTokens: 20, outputTokens: 7 } });
    expect(local.requests).toHaveLength(1);
  });

  test('L01 P04 P05 HTTP 429 does not retry and denied admission never reaches the provider', async () => {
    const local = await redirectedFixture((_captured, response) => { response.writeHead(429, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: token } })); });
    const result = await executeProvider(connection, request(), options());
    expect(result).toMatchObject({ status: 'error', error: { code: 'HTTP_429' }, usage: { inputTokens: null, outputTokens: null, costUsd: null } });
    expect(JSON.stringify(result)).not.toContain(token);
    const denied = await executeProvider(connection, request(), options({ onWire: () => { throw new ProviderContractError('ATTEMPT_PERSISTENCE_FAILED'); } }));
    expect(denied.error?.code).toBe('ATTEMPT_PERSISTENCE_FAILED');
    const wrongOrigin = await executeProvider(connection, request(), options({ approvedOrigins: [] }));
    expect(wrongOrigin.error?.code).toBe('ENDPOINT_NOT_APPROVED');
    expect(local.requests).toHaveLength(1);
  });
});

describe('Vertex Flex admission (synthetic HTTP only)', () => {
  test.each([true,false])('explicit Flex headers and traffic confirmation %s', async confirmed => {
    const wires:WireRecord[]=[];
    const local=await redirectedFixture(async(captured,response)=>{
      expect(captured.headers['x-vertex-ai-llm-request-type']).toBe('shared');
      expect(captured.headers['x-vertex-ai-llm-shared-request-type']).toBe('flex');
      expect(captured.headers['x-server-timeout']).toBe('900');
      await writeSse(response,[{candidates:[{content:{role:'model',parts:[{text:'합성 원고'}]},finishReason:'STOP'}]}, {usageMetadata:{...usage,trafficType:confirmed?'ON_DEMAND_FLEX':'ON_DEMAND'}}]);
    });
    const input=request();input.generation!.serviceTier='flex';
    const result=await executeProvider(connection,input,options({timeoutMs:900000,onWire:(wire:WireRecord)=>wires.push(wire)}));
    expect(result.status).toBe(confirmed?'completed':'error');
    if(!confirmed) expect(result.error?.code).toBe('FLEX_NOT_CONFIRMED');
    expect(wires[0].headers['x-vertex-ai-llm-shared-request-type']).toBe('flex');
    expect(local.requests).toHaveLength(1);
  });
  test('a non-Vertex generation option never silently disappears before fetch',async()=>{
    const local=await redirectedFixture(()=>{throw new Error('must not fetch');});
    const value=request();value.generation!.structuredOutput=false;
    const result=await executeProvider(connection,value,options());
    expect(result.error?.code).toBe('UNSUPPORTED_GENERATION_OPTIONS');expect(local.requests).toHaveLength(0);
  });
  test('a server Flex override applies only when the model request has no conflicting selection', async () => {
    const local=await redirectedFixture(async(captured,response)=>{
      expect(captured.headers['x-vertex-ai-llm-shared-request-type']).toBe('flex');
      await writeSse(response,[{candidates:[{content:{role:'model',parts:[{text:'합성 원고'}]},finishReason:'STOP'}]}, {usageMetadata:{...usage,trafficType:'ON_DEMAND_FLEX'}}]);
    });
    expect((await executeProvider(connection,request(),options({vertexRequestTier:'flex'}))).status).toBe('completed');
    const input=request();input.generation!.serviceTier='standard';
    const resolveCredential=vi.fn(()=>token);const onWire=vi.fn();
    const rejected=await executeProvider(connection,input,options({vertexRequestTier:'flex',resolveCredential,onWire}));
    expect(rejected.error?.code).toBe('INVALID_VERTEX_REQUEST_TIER');
    expect(resolveCredential).not.toHaveBeenCalled();expect(onWire).not.toHaveBeenCalled();expect(local.requests).toHaveLength(1);
  });
  test('Gemini 3.1 Pro uses the exact global model path and selected sampling values', async () => {
    const local=await redirectedFixture(async(captured,response)=>{
      expect(JSON.parse(captured.body).generationConfig).toEqual({maxOutputTokens:2048,temperature:0,topP:0.9,thinkingConfig:{thinkingLevel:'HIGH'},stopSequences:['END_SCENE']});
      await writeSse(response,[{candidates:[{content:{role:'model',parts:[{text:'합성 원고'}]},finishReason:'STOP'}]}, {usageMetadata:usage}]);
    });
    const input=request();input.modelId='gemini-3.1-pro-preview';input.generation={maxOutputTokens:2048,temperature:0,topP:0.9,thinkingLevel:'HIGH',stopSequences:['END_SCENE']};
    expect((await executeProvider(connection,input,options())).status).toBe('completed');
    expect(local.urls).toEqual([connection.endpoint+'/gemini-3.1-pro-preview:streamGenerateContent?alt=sse']);
  });
  test('unreviewed Google models fail before resolving credentials or fetching', async () => {
    const fetch=vi.fn();const resolveCredential=vi.fn(()=>token);vi.stubGlobal('fetch',fetch);
    const input=request();input.modelId='gemini-unreviewed';
    expect((await executeProvider(connection,input,options({resolveCredential}))).error?.code).toBe('UNVERIFIED_MODEL_CAPABILITY');
    expect(resolveCredential).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
  });
});
