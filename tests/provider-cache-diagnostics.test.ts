import { createHash } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { providerCacheBoundaries } from '../core/provider-cache-diagnostics.js';
import { encodeResponses } from '../core/openai-protocol.js';
import { encodeAnthropic } from '../core/anthropic-protocol.js';
import { executeNativeProvider } from '../core/provider-http.js';
import { AnthropicBatchRun } from '../server/anthropic-batch.js';
import type { Store } from '../server/store.js';
import { ProviderContractError } from '../core/provider-errors.js';
import type { Json, ProviderRequest, WireRecord } from '../core/transport.js';

const protocols = ['openai-responses-v1', 'anthropic-messages-v1'] as const;
type Protocol = (typeof protocols)[number];
const encode = (protocol: Protocol, request: ProviderRequest) =>
  (protocol === 'openai-responses-v1' ? encodeResponses : encodeAnthropic)(request).body;
const record = (value: Json) => value as Record<string, any>;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function request(protocol: Protocol, lore = 'Synthetic changing lore.'): ProviderRequest {
  return {
    role: 'main',
    modelId: protocol === 'openai-responses-v1' ? 'gpt-5.6-sol' : 'claude-opus-5-5',
    generation: { maxOutputTokens: 1024, temperature: null, cacheMode: 'explicit' },
    stable: {
      contract: '',
      tools: ['knowledge.read', 'story.read'].map((name) => ({
        name,
        description: 'Read a reference.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
      })),
    },
    input: { task: 'Continue.', controls: {}, source: {} },
    prompt: {
      compilerVersion: 'risu-native-prompt-2',
      values: {},
      messages: [
        { id: 'stable', role: 'system', text: 'Synthetic stable instructions.' },
        { id: 'boundary', role: 'user', text: 'Read the following context.' },
        { id: 'lore', role: 'system', text: lore },
        { id: 'prior', role: 'assistant', text: 'Earlier prose.' },
        { id: 'current', role: 'user', text: 'Continue.' },
      ].map(({ id, role, text }) => ({
        id,
        role: role as 'system' | 'user' | 'assistant',
        content: [{ type: 'text', text }],
        completion: 'complete',
        provenance: { blockId: id, origin: id === 'current' ? 'current' : 'prompt' },
      })),
      cachePlan: ['stable', 'lore'].map((id) => ({
        blockId: id,
        afterMessageId: id,
        policy: 'require',
      })),
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

test.each(protocols)(
  '%s fingerprints stop at each explicit point without retaining prose',
  (protocol) => {
    const body = encode(protocol, request(protocol));
    const original = structuredClone(body);
    const points = providerCacheBoundaries(protocol, body);
    const changed = providerCacheBoundaries(
      protocol,
      encode(protocol, request(protocol, 'Different lore.'))
    );
    expect(points.map((point) => point.path)).toEqual(
      protocol === 'openai-responses-v1'
        ? ['input[0].content[0]', 'input[2].content[0]']
        : ['system[1]', 'messages[1].content[0]']
    );
    expect(changed[0]).toEqual(points[0]);
    expect(changed[1].sha256).not.toBe(points[1].sha256);
    expect(points[1].bytes).toBeGreaterThan(points[0].bytes);
    expect(points.every((point) => /^[a-f0-9]{64}$/u.test(point.sha256))).toBe(true);
    expect(JSON.stringify(points)).not.toMatch(/Synthetic|Earlier|Continue/);
    expect(body).toEqual(original);

    const implicit = request(protocol);
    implicit.prompt!.cachePlan = [];
    implicit.generation!.cacheMode = 'automatic';
    expect(providerCacheBoundaries(protocol, encode(protocol, implicit))).toEqual([]);
    expect(providerCacheBoundaries('vertex-gemini-v1', body)).toEqual([]);
  }
);

test.each(protocols)(
  '%s fingerprints include settings, schema, tool order and earlier bootstrap',
  (protocol) => {
    const input = request(protocol);
    const body = encode(protocol, input);
    const original = providerCacheBoundaries(protocol, body);
    for (const edit of [
      (value: Record<string, any>) => {
        value.model = 'another-model';
      },
      (value: Record<string, any>) => {
        value.tools.reverse();
      },
      (value: Record<string, any>) => {
        value.tools[0].description = 'A changed tool contract.';
      },
      (value: Record<string, any>) => {
        if (protocol === 'openai-responses-v1')
          value.text = { format: { type: 'json_schema', schema: { type: 'object' } } };
        else value.output_config = { format: { type: 'json_schema', schema: { type: 'object' } } };
      },
    ]) {
      const changed = structuredClone(record(body));
      edit(changed);
      const points = providerCacheBoundaries(protocol, changed);
      expect(points.every((point, index) => point.sha256 !== original[index].sha256)).toBe(true);
    }
    input.bootstrap = [
      {
        callId: 'before-1',
        name: 'knowledge.read',
        args: {},
        result: 'First advice.',
        denied: false,
      },
    ];
    const before = providerCacheBoundaries(protocol, encode(protocol, input));
    input.bootstrap[0].result = 'Revised advice.';
    const after = providerCacheBoundaries(protocol, encode(protocol, input));
    expect(after.at(-1)!.sha256).not.toBe(before.at(-1)!.sha256);
    if (protocol === 'anthropic-messages-v1') expect(after[0]).toEqual(before[0]);
    else expect(after[0].sha256).not.toBe(before[0].sha256);
  }
);

test.each(protocols)(
  '%s keeps cache fingerprints in HTTP diagnostics and leaves the payload unchanged',
  async (protocol) => {
    const input = request(protocol);
    const expectedBody = JSON.stringify(encode(protocol, input));
    const fetch = vi.fn(
      async () =>
        new Response('{"error":{"message":"synthetic failure"}}', {
          status: 503,
          headers: { 'content-type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetch);
    let wire: WireRecord | undefined;
    await executeNativeProvider(
      {
        id: 'synthetic',
        protocol,
        endpoint:
          protocol === 'openai-responses-v1'
            ? 'https://api.openai.com/v1'
            : 'https://api.anthropic.com/v1',
        credentialRef: 'SYNTHETIC',
      },
      input,
      {
        signal: new AbortController().signal,
        resolveCredential: () => 'synthetic-key',
        onWire: (value) => {
          wire = value;
        },
      }
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body).toBe(expectedBody);
    expect(wire!.cacheBoundaries).toHaveLength(2);
    expect(wire!.body).not.toHaveProperty('cacheBoundaries');
    expect(wire!.bodySha256).toBe(sha(expectedBody));
    expect(wire!.stablePrefixSha256).toBe(sha(JSON.stringify(input.stable)));
  }
);

test('Batch emits fingerprints before submission without changing its payload hash', async () => {
  const input = request('anthropic-messages-v1');
  const { stream: _stream, ...params } = record(encodeAnthropic(input).body);
  // Stop at the real onWire boundary; no database writes or provider calls are needed.
  const store = { db: { prepare: () => ({ get: () => undefined }) } } as unknown as Store;
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  let wire: WireRecord | undefined;
  await new AnthropicBatchRun(store, 'synthetic-run').execute(
    {
      id: 'synthetic',
      protocol: 'anthropic-messages-v1',
      endpoint: 'https://api.anthropic.com/v1',
      credentialRef: 'SYNTHETIC',
    },
    input,
    {
      signal: new AbortController().signal,
      resolveCredential: () => 'synthetic-key',
      onWire: (value) => {
        wire = value;
        throw new ProviderContractError('SYNTHETIC_STOP_BEFORE_SUBMISSION');
      },
    }
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(wire!.cacheBoundaries).toHaveLength(2);
  expect(wire!.bodySha256).toBe(sha(JSON.stringify(params)));
  expect(wire!.stablePrefixSha256).toBe(sha(JSON.stringify(input.stable)));
  expect(record(wire!.body).request).not.toHaveProperty('cacheBoundaries');
});
