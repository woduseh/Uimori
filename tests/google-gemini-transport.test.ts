import { afterEach, expect, test, vi } from 'vitest';
import { estimateContextTokens } from '../core/context-budget.js';
import { encodeVertex } from '../core/vertex-protocol.js';
import * as vertexPdf from '../core/vertex-pdf.js';
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

test('Studio PDF keeps signed native tool continuation and transient budget evidence through pricing', async () => {
  const input = request();
  input.generation!.pdfInput = true;
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
  const prepared = encodeVertex(input, 'google-gemini-v1');
  const signed: Json[] = [
    { thought: true, text: 'PRIVATE_THOUGHT' },
    {
      functionCall: { id: 'studio-call', name: 'knowledge.read', args: { id: 'lore' } },
      thoughtSignature: 'opaque+/=',
    },
  ];
  const bodies: any[] = [],
    wires: WireRecord[] = [],
    evidenceBodies: (Json | undefined)[] = [];
  const local = await localProvider(async (captured, response) => {
    bodies.push(JSON.parse(captured.body));
    await writeSse(response, [
      resultEvent(bodies.length === 1 ? signed : [{ text: 'After PDF and tool.' }]),
    ]);
  });
  const onWire = (wire: WireRecord, _resume?: string, evidence?: { contextBody?: Json }) => {
    wires.push(wire);
    evidenceBodies.push(evidence?.contextBody);
  };
  const first = await executeProvider(connection, input, { ...options(), onWire });
  expect(first.status).toBe('tool_calls');
  expect(first.toolCalls).toHaveLength(1);
  const pdf = bodies[0].contents[0].parts[0].inlineData;
  expect(pdf.mimeType).toBe('application/pdf');
  expect(Buffer.from(pdf.data, 'base64').subarray(0, 8).toString()).toBe('%PDF-1.7');
  expect(bodies[0].toolConfig.functionCallingConfig).toEqual({
    mode: 'ANY',
    allowedFunctionNames: ['knowledge.read'],
  });
  expect(bodies[0].generationConfig).not.toHaveProperty('pdfInput');
  expect(evidenceBodies[0]).toEqual(prepared.contextBody);
  expect(wires[0].requestContext?.estimatedInputTokens).toBe(
    estimateContextTokens(prepared.contextBody, input.contextBudget)
  );
  expect(wires[0].pricingSnapshot).toEqual(input.pricingSnapshot);
  expect(wires[0]).not.toHaveProperty('contextBody');
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
  expect(second.text).toBe('After PDF and tool.');
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
  input.generation!.pdfInput = true;
  input.input.source = { text: '원문 한도 보호. '.repeat(10000) };
  const createPdf = vi.spyOn(vertexPdf, 'createVertexPdf');
  const large = await executeProvider(connection, input, {
    ...options(),
    resolveCredential,
    onWire,
  });
  expect(large.error?.code).toBe('INPUT_CONTEXT_LIMIT_EXCEEDED');
  expect(createPdf).not.toHaveBeenCalled();
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
