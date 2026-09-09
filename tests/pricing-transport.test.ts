import { afterEach, expect, test, vi } from 'vitest';
import {
  executeProvider,
  type ProviderConnection,
  type ProviderRequest,
  type WireRecord,
} from '../core/transport.js';
import type { PricingSnapshot } from '../core/pricing-types.js';
import { loopbackProvider, sse, writeSse } from './fixtures/loopback-provider.js';

const close: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const cleanup of close.splice(0)) await cleanup();
});
const pricing = (protocol: PricingSnapshot['protocol'], modelId: string): PricingSnapshot => ({
  version: 1,
  protocol,
  modelId,
  source: 'manual',
  checkedAt: '2026-09-09',
  serviceTier: 'standard',
  rates: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: null },
  notes: ['HOST_ONLY_PRICING_MARKER'],
});
const request = (snapshot: PricingSnapshot): ProviderRequest => ({
  role: 'translation',
  modelId: snapshot.modelId,
  stable: { contract: 'Translate synthetic source', tools: [] },
  input: { task: 'Synthetic text', controls: {} },
  pricingSnapshot: snapshot,
});

test.each(['usage', 'earlier-content'] as const)(
  'native Chat loopback journals frozen host pricing and tier from %s, never transmits host fields',
  async (tierLocation) => {
    const local = await loopbackProvider(async (_captured, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        (tierLocation === 'earlier-content'
          ? sse({
              id: 'pricing-chat',
              choices: [
                { index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null },
              ],
              service_tier: 'default',
            })
          : '') +
          sse({
            id: 'pricing-chat',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: '합성 번역' },
                finish_reason: 'stop',
              },
            ],
            ...(tierLocation === 'usage' ? { service_tier: 'default' } : {}),
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 100,
              prompt_tokens_details: { cached_tokens: 200 },
            },
          }) +
          'data: [DONE]\r\n\r\n'
      );
    });
    close.push(local.close);
    const connection: ProviderConnection = {
      id: 'synthetic-chat',
      protocol: 'openai-chat-v1',
      endpoint: local.origin + '/v1',
    };
    const snapshot = pricing(connection.protocol, 'synthetic-model');
    const before = structuredClone(snapshot);
    const wires: WireRecord[] = [];
    const started = Date.now();
    const result = await executeProvider(connection, request(snapshot), {
      signal: new AbortController().signal,
      approvedOrigins: [local.origin],
      onWire: (wire) => {
        wires.push(wire);
      },
    });
    expect(result).toMatchObject({ status: 'completed', error: null });
    expect(result.usage.raw).toMatchObject({ service_tier: 'default' });
    expect(wires).toHaveLength(1);
    expect(wires[0].pricingSnapshot).toEqual(before);
    expect(Date.parse(wires[0].pricingStartedAt!)).toBeGreaterThanOrEqual(started);
    expect(Date.parse(wires[0].pricingStartedAt!)).toBeLessThanOrEqual(Date.now());
    snapshot.rates.input = 99;
    expect(wires[0].pricingSnapshot?.rates.input).toBe(2);
    expect(local.requests).toHaveLength(1);
    const body = JSON.parse(local.requests[0].body);
    expect(body).not.toHaveProperty('pricingSnapshot');
    expect(body).not.toHaveProperty('pricingStartedAt');
    expect(local.requests[0].body).not.toContain('HOST_ONLY_PRICING_MARKER');
    expect(body.model).toBe('synthetic-model');
  }
);

test.each(['known', 'unknown'] as const)(
  'forced Vertex Flex freezes %s Flex rates without host fields on wire',
  async (known) => {
    const local = await loopbackProvider(async (captured, response) => {
      expect(captured.headers['x-vertex-ai-llm-shared-request-type']).toBe('flex');
      await writeSse(response, [
        {
          candidates: [
            { content: { role: 'model', parts: [{ text: '합성 번역' }] }, finishReason: 'STOP' },
          ],
          usageMetadata: {
            promptTokenCount: 1000,
            candidatesTokenCount: 60,
            thoughtsTokenCount: 40,
            cachedContentTokenCount: 200,
            trafficType: 'ON_DEMAND_FLEX',
          },
        },
      ]);
    });
    close.push(local.close);
    const connection: ProviderConnection = {
      id: 'synthetic-vertex',
      protocol: 'vertex-gemini-v1',
      endpoint:
        'https://aiplatform.googleapis.com/v1/projects/synthetic/locations/global/publishers/google/models',
      credentialEnv: 'SYNTHETIC_VERTEX_TOKEN',
    };
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
        if (!String(url).startsWith(connection.endpoint + '/'))
          throw new Error('Unexpected external request');
        return nativeFetch(local.origin + '/vertex', init);
      })
    );
    const snapshot = pricing(connection.protocol, 'gemini-3.8-flash');
    const flexRates = { input: 1, output: 4, cacheRead: 0.25, cacheWrite: null };
    snapshot.standardRates = { ...snapshot.rates };
    if (known === 'known') {
      snapshot.flexRates = flexRates;
      snapshot.flexLongContext = { aboveInputTokens: 200_000, rates: { ...flexRates, input: 2 } };
    }
    const before = structuredClone(snapshot);
    const wires: WireRecord[] = [];
    const result = await executeProvider(connection, request(snapshot), {
      signal: new AbortController().signal,
      approvedOrigins: [],
      resolveCredential: () => 'synthetic-key',
      vertexRequestTier: 'flex',
      onWire: (wire) => {
        wires.push(wire);
      },
    });
    expect(result.status).toBe('completed');
    expect(wires[0].pricingSnapshot?.serviceTier).toBe('flex');
    expect(wires[0].pricingSnapshot?.rates).toEqual(
      known === 'known'
        ? flexRates
        : { input: null, output: null, cacheRead: null, cacheWrite: null }
    );
    expect(wires[0].pricingSnapshot?.longContext).toEqual(before.flexLongContext);
    expect(snapshot).toEqual(before);
    expect(local.requests).toHaveLength(1);
    expect(local.requests[0].body).not.toContain('pricingSnapshot');
    expect(local.requests[0].body).not.toContain('HOST_ONLY_PRICING_MARKER');
  }
);
