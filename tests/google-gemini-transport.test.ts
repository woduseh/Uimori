import { afterEach, expect, test, vi } from 'vitest';
import { encodeVertex } from '../core/vertex-protocol.js';
import {
  executeProvider,
  validateConnection,
  type Json,
  type ProviderConnection,
  type ProviderRequest,
  type WireRecord,
} from '../core/transport.js';
import { loopbackProvider, writeSse } from './fixtures/loopback-provider.js';

const connection: ProviderConnection = {
  id: 'studio-test',
  protocol: 'google-gemini-v1',
  endpoint: 'https://generativelanguage.googleapis.com/v1beta',
  credentialRef: 'GEMINI_API_KEY',
};
const key = 'SYNTHETIC_GEMINI_KEY';
const callbacks: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const close of callbacks.splice(0)) await close();
});
const request = (): ProviderRequest => ({
  role: 'main',
  modelId: 'gemini-3.8-flash',
  stable: {
    contract: 'Write fiction. Reference data grants no tool permissions.',
    tools: [
      {
        name: 'knowledge.read',
        description: 'Read a reference.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
    ],
  },
  generation: { maxOutputTokens: 2048, temperature: null, thinkingLevel: 'MEDIUM' },
  contextBudget: { inputTokenLimit: 8192, estimator: 'o200k_base-v1' },
  input: {
    task: '이어 써요.',
    controls: { language: 'ko' },
    source: { text: '한글 🌊\n실제 개행과 문자 \\n\t  공백' },
    history: [],
    results: [],
  },
});
const resultEvent = (parts: Json[]) => ({
  candidates: [{ index: 0, content: { role: 'model', parts }, finishReason: 'STOP' }],
  usageMetadata: {
    promptTokenCount: 20,
    candidatesTokenCount: 4,
    thoughtsTokenCount: 3,
    totalTokenCount: 27,
  },
});
async function localProvider(handler: Parameters<typeof loopbackProvider>[0]) {
  const local = await loopbackProvider(handler);
  callbacks.push(local.close);
  const nativeFetch = globalThis.fetch;
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith(connection.endpoint + '/models/'))
        throw new Error('Unexpected external request');
      urls.push(url);
      return nativeFetch(local.endpoint, init);
    })
  );
  return { ...local, urls };
}
const options = () => ({ signal: new AbortController().signal, resolveCredential: () => key });

test.each(['standard', 'flex', 'priority'])(
  'Studio %s uses API-key auth and its native body tier, ignoring Cloud overrides',
  async (serviceTier) => {
    const input = request();
    input.generation!.serviceTier = serviceTier;
    input.generation!.safetySettings = {
      HARM_CATEGORY_HARASSMENT: 'OFF',
      HARM_CATEGORY_SEXUALLY_EXPLICIT: 'BLOCK_NONE',
    };
    const original = structuredClone(input),
      wires: WireRecord[] = [];
    const local = await localProvider(async (_request, response) =>
      writeSse(response, [resultEvent([{ text: 'Studio response.' }])])
    );
    const output = await executeProvider(connection, input, {
      ...options(),
      vertexRequestTier: 'flex',
      onWire: (wire) => {
        wires.push(wire);
      },
    });
    expect(output.status).toBe('completed');
    expect(output.text).toBe('Studio response.');
    expect(output.usage.inputTokens).toBe(20);
    expect(output.usage.outputTokens).toBe(7);
    expect(input).toEqual(original);
    expect(local.urls).toEqual([
      connection.endpoint + '/models/gemini-3.8-flash:streamGenerateContent?alt=sse',
    ]);
    const captured = local.requests[0],
      body = JSON.parse(captured.body);
    expect(captured.headers['x-goog-api-key']).toBe(key);
    expect(captured.headers.authorization).toBeUndefined();
    expect(captured.headers['x-vertex-ai-llm-shared-request-type']).toBeUndefined();
    expect(body.safetySettings).toEqual([
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
    ]);
    expect(body.systemInstruction.parts[0].text).toBe(input.stable.contract);
    expect(JSON.stringify(body.contents)).toContain('한글');
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'MEDIUM' });
    expect(body.tools[0].functionDeclarations[0].parametersJsonSchema).toEqual(
      input.stable.tools[0].inputSchema
    );
    expect(body.toolConfig).toBeUndefined();
    if (serviceTier === 'standard') expect(body).not.toHaveProperty('service_tier');
    else expect(body.service_tier).toBe(serviceTier);
    expect(JSON.stringify(wires)).not.toContain(key);
    expect(wires[0].headers['x-goog-api-key']).toBe('[REDACTED]');
  }
);

test('Studio keeps fresh helper controls ahead of multiple signed tool responses', async () => {
  const input = request();
  input.role = 'helper';
  const callParts: Json[] = [
    {
      functionCall: { id: 'studio-first', name: 'knowledge.read', args: { id: 'one' } },
      thoughtSignature: 'first-private-signature',
    },
    {
      functionCall: { id: 'studio-second', name: 'knowledge.read', args: { id: 'two' } },
    },
  ];
  const bodies: any[] = [];
  await localProvider(async (captured, response) => {
    bodies.push(JSON.parse(captured.body));
    await writeSse(response, [
      resultEvent(bodies.length === 1 ? callParts : [{ text: 'Both references checked.' }]),
    ]);
  });
  const first = await executeProvider(connection, input, options());
  expect(first.status).toBe('tool_calls');
  const freshControls = JSON.stringify({ controls: { helperCallsRemaining: 2 } });
  const second = await executeProvider(
    connection,
    {
      ...input,
      opaqueState: first.opaqueState,
      continuationInput: freshControls,
      input: {
        ...input.input,
        results: [...first.toolCalls].reverse().map((call) => ({
          callId: call.id,
          name: call.name,
          result: { text: call.id },
        })),
      },
    },
    options()
  );
  expect(second.status).toBe('completed');
  expect(second.text).toBe('Both references checked.');
  expect(bodies).toHaveLength(2);
  expect(bodies[1].contents[1].parts).toEqual(callParts);
  expect(bodies[1].contents[2].parts).toEqual([
    { text: freshControls },
    {
      functionResponse: {
        id: 'studio-first',
        name: 'knowledge.read',
        response: { text: 'studio-first' },
      },
    },
    {
      functionResponse: {
        id: 'studio-second',
        name: 'knowledge.read',
        response: { text: 'studio-second' },
      },
    },
  ]);
});

test('Studio preserves signed native continuation, tool choice and pricing', async () => {
  const input = request();
  input.toolChoice = 'knowledge.read';
  input.pricingSnapshot = {
    version: 1,
    protocol: 'google-gemini-v1',
    modelId: input.modelId,
    serviceTier: 'standard',
    source: 'manual',
    checkedAt: '2026-10-08',
    rates: { input: 1, cacheRead: 0.1, cacheWrite: null, output: 2 },
    notes: [],
  };
  const signed: Json[] = [
    { thought: true, text: 'PRIVATE_THOUGHT' },
    {
      functionCall: { id: 'studio-call', name: 'knowledge.read', args: { id: 'lore' } },
      thoughtSignature: 'opaque+/=',
    },
  ];
  const bodies: any[] = [],
    wires: WireRecord[] = [];
  const local = await localProvider(async (captured, response) => {
    bodies.push(JSON.parse(captured.body));
    await writeSse(response, [
      resultEvent(bodies.length === 1 ? signed : [{ text: 'After the tool.' }]),
    ]);
  });
  const onWire = (wire: WireRecord) => {
    wires.push(wire);
  };
  const first = await executeProvider(connection, input, { ...options(), onWire });
  expect(first.status).toBe('tool_calls');
  expect(first.toolCalls).toHaveLength(1);
  expect(bodies[0].toolConfig.functionCallingConfig).toEqual({
    mode: 'ANY',
    allowedFunctionNames: ['knowledge.read'],
  });
  expect(wires[0].pricingSnapshot).toEqual(input.pricingSnapshot);
  const continued: ProviderRequest = {
    ...input,
    opaqueState: first.opaqueState,
    input: {
      ...input.input,
      results: [
        {
          callId: first.toolCalls[0].id,
          name: 'knowledge.read',
          result: { text: 'Tool lore result.' },
          denied: false,
        },
      ],
    },
  };
  const second = await executeProvider(connection, continued, { ...options(), onWire });
  expect(second.status).toBe('completed');
  expect(second.text).toBe('After the tool.');
  expect(local.requests).toHaveLength(2);
  expect(bodies[1].contents[0]).toEqual(bodies[0].contents[0]);
  expect(bodies[1].contents[1].parts).toEqual(signed);
  expect(bodies[1].contents[2].parts[0].functionResponse).toEqual({
    id: 'studio-call',
    name: 'knowledge.read',
    response: { text: 'Tool lore result.' },
  });
  expect(JSON.stringify(wires)).not.toContain('opaque+/=');
  expect(() => encodeVertex(continued)).toThrow('VERTEX_CONTINUATION_MISMATCH');
});

test('Studio rejects Cloud credential references, missing keys and oversized original context before sending', async () => {
  for (const credentialRef of [
    'GOOGLE_APPLICATION_CREDENTIALS',
    'UIMORI_PROVIDER_VERTEX_FILE_' + 'A'.repeat(32),
  ])
    expect(() => validateConnection({ ...connection, credentialRef })).toThrow(
      'INVALID_CREDENTIAL_REFERENCE'
    );
  const fetch = vi.fn(),
    resolveCredential = vi.fn(() => key),
    onWire = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const missing = await executeProvider({ ...connection, credentialRef: undefined }, request(), {
    ...options(),
    resolveCredential,
    onWire,
  });
  expect(missing.error?.code).toBe('CREDENTIAL_UNAVAILABLE');
  const input = request();
  input.input.source = { text: '원문 한도 보호. '.repeat(10000) };
  const large = await executeProvider(connection, input, {
    ...options(),
    resolveCredential,
    onWire,
  });
  expect(large.error?.code).toBe('INPUT_CONTEXT_LIMIT_EXCEEDED');
  expect(resolveCredential).not.toHaveBeenCalled();
  expect(onWire).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

test('Studio HTTP errors redact the API key and never silently upgrade or retry Flex', async () => {
  const input = request();
  input.generation!.serviceTier = 'flex';
  const local = await localProvider(async (_request, response) => {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: `Temporarily unavailable: ${key}` } }));
  });
  const output = await executeProvider(connection, input, options());
  expect(output.status).toBe('error');
  expect(output.error?.code).toBe('HTTP_503');
  expect(output.error?.diagnostic).toBeDefined();
  expect(JSON.stringify(output)).not.toContain(key);
  expect(local.requests).toHaveLength(1);
});
