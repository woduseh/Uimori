import { expect, test } from 'vitest';
import {
  acceptsMidConversationSystem,
  generationFromModel,
  helperGenerationFromModel,
  modelCapability,
  protocolOptionKeys,
  supportedModels,
  validateModelOptions,
} from '../core/model-capabilities.js';
import {
  PROVIDER_PROTOCOLS,
  type Connection,
  type ModelGeneration,
  type ModelPreset,
  type ProviderProtocol,
} from '../core/product.js';
import { type Json, type ProviderRequest } from '../core/transport.js';
import { modelHints } from '../core/model-hints.js';
import { encodeAnthropic } from '../core/anthropic-protocol.js';
import { encodeChat } from '../core/openai-chat-protocol.js';
import { encodeResponses } from '../core/openai-protocol.js';
import { encodeVertex } from '../core/vertex-protocol.js';
import { modelDraft, modelDraftError, modelPayload } from '../web/provider-model-draft.js';
import { Store } from '../server/store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base: ModelGeneration = { maxOutputTokens: 8192, temperature: null };

test('validation is protocol-level: any listed or unlisted model may use every option its encoder sends', () => {
  expect(() =>
    validateModelOptions({ ...base, thinkingLevel: 'LOW' }, 'vertex-gemini-v1')
  ).not.toThrow();
  expect(() =>
    validateModelOptions(
      { ...base, maxOutputTokens: 500000, reasoningEffort: 'max' },
      'vercel-chat-v1'
    )
  ).not.toThrow();
  expect(() =>
    validateModelOptions({ ...base, reasoningEffort: 'none', temperature: 0.5 }, 'deepseek-chat-v1')
  ).not.toThrow();
  expect(() =>
    validateModelOptions(
      { ...base, thinkingMode: 'disabled', outputEffort: 'xhigh' },
      'anthropic-messages-v1'
    )
  ).not.toThrow();
  expect(() =>
    validateModelOptions(
      { ...base, reasoningEffort: 'none', verbosity: 'low', serviceTier: 'flex' },
      'openai-responses-v1'
    )
  ).not.toThrow();
});

test('Gemini model IDs, direct or namespaced by a gateway, are treated as rejecting a mid-conversation system message', () => {
  for (const modelId of [
    'gemini-3.8-flash',
    'gemini-4-argon',
    'gemini-2.5-pro',
    'google/Gemini-3.8-flash',
    'openrouter/google/gemini-3.1-pro-preview',
  ])
    expect(acceptsMidConversationSystem(modelId)).toBe(false);
  for (const modelId of ['claude-opus-5-5', 'gpt-6.2-sol', 'gemma-3-27b', 'not-gemini-3'])
    expect(acceptsMidConversationSystem(modelId)).toBe(true);
});

test('options the encoder cannot send and values outside the protocol vocabulary are rejected', () => {
  expect(() =>
    validateModelOptions({ ...base, serviceTier: 'default' }, 'google-gemini-v1')
  ).toThrow();
  expect(() =>
    validateModelOptions({ ...base, maxOutputTokens: 500001 }, 'vercel-chat-v1')
  ).toThrow();
  expect(() =>
    validateModelOptions({ ...base, temperature: 0 }, 'anthropic-messages-v1')
  ).toThrow();
  expect(() =>
    validateModelOptions({ ...base, structuredOutput: true }, 'vertex-gemini-v1')
  ).toThrow();
  expect(() =>
    validateModelOptions({ ...base, thinkingLevel: 'HIGH' }, 'openai-responses-v1')
  ).toThrow();
  expect(() =>
    validateModelOptions({ ...base, reasoningEffort: 'high' }, 'anthropic-messages-v1')
  ).toThrow();
  expect(() =>
    validateModelOptions(
      {
        ...base,
        thinkingMode: 'adaptive',
        thinkingBudgetTokens: 2048,
      } as unknown as ModelGeneration,
      'anthropic-messages-v1'
    )
  ).toThrow();
  expect(() =>
    validateModelOptions({ ...base, thinkingLevel: 'ULTRA' as 'LOW' }, 'vertex-gemini-v1')
  ).toThrow('UNSUPPORTED_GENERATION_OPTIONS');
  for (const protocol of PROVIDER_PROTOCOLS)
    expect(protocolOptionKeys(protocol)).not.toContain('timeoutMs');
});

test('Gemini categories accept explicit OFF and BLOCK_NONE, but only on direct connections', () => {
  const configured: ModelGeneration = {
    ...base,
    safetySettings: {
      HARM_CATEGORY_HARASSMENT: 'OFF',
      HARM_CATEGORY_SEXUALLY_EXPLICIT: 'BLOCK_NONE',
      HARM_CATEGORY_JAILBREAK: 'BLOCK_ONLY_HIGH',
    },
  };
  for (const protocol of ['vertex-gemini-v1', 'google-gemini-v1'] as const) {
    expect(() => validateModelOptions(configured, protocol)).not.toThrow();
    expect(() => validateModelOptions({ ...base, safetySettings: {} }, protocol)).not.toThrow();
  }
  expect(generationFromModel(configured).safetySettings).toEqual(configured.safetySettings);
  expect(generationFromModel(configured).safetySettings).not.toBe(configured.safetySettings);
  for (const protocol of ['vercel-chat-v1', 'anthropic-messages-v1'] as const)
    expect(() => validateModelOptions(configured, protocol)).toThrow();
  for (const value of [
    null,
    { HARM_CATEGORY_HARASSMENT: 'DEFAULT' },
    { HARM_CATEGORY_UNKNOWN: 'OFF' },
  ])
    expect(() =>
      validateModelOptions(
        { ...base, safetySettings: value } as ModelGeneration,
        'vertex-gemini-v1'
      )
    ).toThrow('UNSUPPORTED_GENERATION_OPTIONS');
});

test('cache times are explicit, provider-specific, and incompatible with OFF', () => {
  for (const ttl of ['5m', '1h'] as const)
    expect(() =>
      validateModelOptions(
        { ...base, cacheMode: 'automatic', cacheTtl: ttl },
        'anthropic-messages-v1'
      )
    ).not.toThrow();
  expect(() =>
    validateModelOptions({ ...base, cacheMode: 'explicit', cacheTtl: '30m' }, 'openai-responses-v1')
  ).not.toThrow();
  expect(() =>
    validateModelOptions({ ...base, cacheMode: 'explicit', cacheTtl: '5m' }, 'openai-responses-v1')
  ).toThrow();
  for (const cacheMode of [undefined, 'disabled'] as const)
    expect(() =>
      validateModelOptions({ ...base, cacheMode, cacheTtl: '1h' }, 'anthropic-messages-v1')
    ).toThrow('CACHE_TTL_REQUIRES_CACHE_MODE');
  expect(() =>
    validateModelOptions({ ...base, cacheMode: 'disabled' }, 'vertex-gemini-v1')
  ).toThrow();
  expect(() =>
    validateModelOptions({ ...base, cacheMode: 'disabled' }, 'openai-chat-v1')
  ).toThrow();
});

test('a helper request caches by default only on a reviewed Claude model without a chosen cache mode', () => {
  const claude = { ...base, modelId: 'claude-opus-5-5' };
  expect(helperGenerationFromModel(claude, 'anthropic-messages-v1').cacheMode).toBe('automatic');
  expect(
    helperGenerationFromModel({ ...claude, cacheMode: 'disabled' }, 'anthropic-messages-v1')
      .cacheMode
  ).toBe('disabled');
  expect(
    helperGenerationFromModel({ ...claude, cacheMode: 'explicit' }, 'anthropic-messages-v1')
      .cacheMode
  ).toBe('explicit');
  expect(
    helperGenerationFromModel({ ...base, modelId: 'unreviewed-model' }, 'anthropic-messages-v1')
      .cacheMode
  ).toBeUndefined();
  expect(
    helperGenerationFromModel({ ...base, modelId: 'gpt-5.5' }, 'openai-responses-v1').cacheMode
  ).toBeUndefined();
});

const savedConnection = (protocol: ProviderProtocol): Connection => ({
  id: `connection-${protocol}`,
  revision: 1,
  title: protocol,
  protocol,
  endpoint: 'http://127.0.0.1:9/v1',
  enabled: true,
  catalog: [],
  catalogError: null,
});
const wireOf = (encoded: { body: Json }) => encoded.body as Record<string, any>;
const removedModels: {
  protocol: ProviderProtocol;
  modelId: string;
  options: Partial<ModelGeneration>;
  wire: (request: ProviderRequest) => Record<string, any>;
  expected: Record<string, unknown>;
}[] = [
  {
    protocol: 'vertex-gemini-v1',
    modelId: 'gemini-4-argon',
    options: { thinkingLevel: 'MEDIUM', serviceTier: 'flex', stopSequences: ['END'] },
    wire: (request) => wireOf(encodeVertex(request)).generationConfig,
    expected: { thinkingConfig: { thinkingLevel: 'MEDIUM' }, stopSequences: ['END'] },
  },
  {
    protocol: 'vertex-gemini-v1',
    modelId: 'gemini-3.8-flash',
    options: { temperature: 0.7, topP: 0.9, thinkingLevel: 'LOW' },
    wire: (request) => wireOf(encodeVertex(request)).generationConfig,
    expected: { temperature: 0.7, topP: 0.9, thinkingConfig: { thinkingLevel: 'LOW' } },
  },
  {
    protocol: 'anthropic-messages-v1',
    modelId: 'claude-mythos-5-2',
    options: {
      outputEffort: 'xhigh',
      thinkingMode: 'adaptive',
      serviceTier: 'standard_only',
      cacheMode: 'automatic',
      cacheTtl: '1h',
      stopSequences: ['END'],
    },
    wire: (request) => wireOf(encodeAnthropic(request)),
    expected: {
      output_config: { effort: 'xhigh' },
      thinking: { type: 'adaptive' },
      service_tier: 'standard_only',
      cache_control: { type: 'ephemeral', ttl: '1h' },
      stop_sequences: ['END'],
    },
  },
  {
    protocol: 'openai-responses-v1',
    modelId: 'gpt-5.6-terra',
    options: {
      reasoningEffort: 'xhigh',
      verbosity: 'low',
      reasoningContext: 'all_turns',
      serviceTier: 'flex',
      cacheMode: 'explicit',
      cacheTtl: '30m',
    },
    wire: (request) => wireOf(encodeResponses(request)),
    expected: {
      reasoning: { effort: 'xhigh', context: 'all_turns' },
      text: { verbosity: 'low' },
      service_tier: 'flex',
      prompt_cache_options: { mode: 'explicit', ttl: '30m' },
    },
  },
  {
    protocol: 'deepseek-chat-v1',
    modelId: 'deepseek-v4-flash',
    options: { reasoningEffort: 'none', temperature: 0.4 },
    wire: (request) => wireOf(encodeChat(request, 'deepseek-chat-v1')),
    expected: { temperature: 0.4, thinking: { type: 'disabled' } },
  },
];

test.each(removedModels)(
  'a saved $modelId removed from the table loads, saves and sends its options as an unlisted model',
  ({ protocol, modelId, options, wire, expected }) => {
    const connection = savedConnection(protocol);
    expect(modelCapability(protocol, modelId)).toBeUndefined();
    expect(supportedModels(protocol).map((item) => item.id)).not.toContain(modelId);
    expect(modelHints(connection, modelId).source).toBe('none');
    const preset: ModelPreset = {
      id: 'saved',
      revision: 3,
      title: 'Saved before the table changed',
      connectionId: connection.id,
      modelId,
      ...base,
      ...options,
    };
    const draft = modelDraft(preset);
    expect(modelDraftError(draft, connection)).toBeNull();
    const resaved = modelPayload({ ...draft, title: 'Renamed' }, connection) as ModelPreset;
    expect(generationFromModel(resaved)).toEqual(generationFromModel(preset));
    const generation = generationFromModel(preset);
    expect(() => validateModelOptions(generation, protocol)).not.toThrow();
    const request: ProviderRequest = {
      role: 'main',
      modelId,
      stable: { contract: 'Synthetic', tools: [] },
      input: { task: 'Synthetic', controls: {} },
      generation,
    };
    expect(wire(request)).toMatchObject(expected);
  }
);

test('a stored model with a removed ID survives an unrelated settings save and builds the same request', () => {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-removed-model-'));
  const store = new Store(join(directory, 'story.sqlite'));
  try {
    const connection = store.product.connection({
      title: 'Compatible',
      protocol: 'openai-chat-v1',
      endpoint: 'http://127.0.0.1:9999/v1',
      enabled: true,
    }) as Connection;
    const options = { reasoningEffort: 'xhigh', serviceTier: 'flex', temperature: 0.3 } as const;
    const saved = store.product.model({
      title: 'Terra',
      connectionId: connection.id,
      modelId: 'gpt-5.6-terra',
      maxOutputTokens: 4096,
      ...options,
    }) as ModelPreset;
    const renamed = store.product.model(
      {
        title: 'Terra, renamed',
        connectionId: connection.id,
        modelId: saved.modelId,
        ...generationFromModel(saved),
        expectedRevision: saved.revision,
      },
      saved.id
    ) as ModelPreset;
    expect(generationFromModel(renamed)).toEqual(generationFromModel(saved));
    const snapshot = store.product.modelSnapshot(renamed.id, undefined, false);
    const body = wireOf(
      encodeChat({
        role: 'main',
        modelId: snapshot.modelId,
        stable: { contract: 'Synthetic', tools: [] },
        input: { task: 'Synthetic', controls: {} },
        generation: generationFromModel(snapshot),
      })
    );
    expect(body).toMatchObject({
      model: 'gpt-5.6-terra',
      reasoning_effort: 'xhigh',
      service_tier: 'flex',
      temperature: 0.3,
    });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
