import { expect, test } from 'vitest';
import { catalogEntryMetadata, catalogPricing, geminiListEntry } from '../core/provider-catalog.js';
import { modelHints, thinkingField, thinkingWireField } from '../core/model-hints.js';
import type { Connection } from '../core/product.js';

const connection = (
  protocol: Connection['protocol'],
  catalog: Connection['catalog'] = []
): Pick<Connection, 'protocol' | 'catalog'> => ({ protocol, catalog });

const gatewayPricing = () => ({
  input: '0.000002',
  output: '0.00001',
  input_cache_read: '0.0000002',
  input_cache_write: '0.0000025',
  input_tiers: [
    { cost: '0.000002', min: 0, max: 272000 },
    { cost: '0.000004', min: 272000 },
  ],
  output_tiers: [
    { cost: '0.00001', min: 0, max: 272000 },
    { cost: '0.000015', min: 272000 },
  ],
  input_cache_read_tiers: [
    { cost: '0.0000002', min: 0, max: 272000 },
    { cost: '0.0000004', min: 272000 },
  ],
  input_cache_write_tiers: [
    { cost: '0.0000025', min: 0, max: 272000 },
    { cost: '0.000005', min: 272000 },
  ],
  service_tiers: {
    flex: {
      input: '0.000001',
      output: '0.000005',
      input_cache_read: '0.0000001',
      long_context: {
        threshold: 272000,
        input: '0.000002',
        output: '0.0000075',
        input_cache_read: '0.0000002',
      },
    },
  },
  varies_by_provider: true,
});

test('Gateway public snake-case prices preserve cache buckets, context tiers and explicit Flex rates', () => {
  expect(catalogPricing(gatewayPricing())).toEqual({
    rates: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    longContext: {
      aboveInputTokens: 272000,
      rates: { input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 },
    },
    serviceTiers: {
      flex: {
        rates: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: null },
        longContext: {
          aboveInputTokens: 272000,
          rates: { input: 2, output: 7.5, cacheRead: 0.2, cacheWrite: null },
        },
      },
    },
  });
  const metadata = catalogEntryMetadata('vercel-chat-v1', {
    pricing: gatewayPricing(),
    tags: ['tool-use'],
    max_tokens: 128000,
  });
  expect(metadata.pricing).toEqual(catalogPricing(gatewayPricing()));
  expect(metadata.capabilities.tools).toBe(true);
  expect(
    catalogPricing({
      input: '0.000002',
      output: '0.000006',
      input_cache_read: '0.0000005',
      input_tiers: [
        { min: 0, max: 200000, cost: '0.000002' },
        { min: 200001, cost: '0.000004' },
      ],
    })
  ).toMatchObject({ longContext: { aboveInputTokens: 200000, rates: { input: 4 } } });
});

test('Gateway malformed or complex pricing is omitted without losing other model metadata', () => {
  for (const bad of ['', ' ', '-1', '0x10', 'Infinity', 2, Infinity, NaN, {}, true]) {
    expect(catalogPricing({ input: bad, output: '0.01' })).toBeUndefined();
  }
  expect(catalogPricing({ input: '0', output: '0' })?.rates).toEqual({
    input: 0,
    output: 0,
    cacheRead: null,
    cacheWrite: null,
  });
  const conflicting = gatewayPricing();
  conflicting.output_tiers[0].max = 300000;
  conflicting.output_tiers[1].min = 300000;
  expect(catalogPricing(conflicting)).toBeUndefined();
  const complex = gatewayPricing();
  complex.input_tiers.push({ min: 500000, cost: '0.000006' });
  expect(catalogPricing(complex)).toBeUndefined();
  const metadata = catalogEntryMetadata('vercel-chat-v1', {
    pricing: conflicting,
    tags: ['tool-use'],
    max_tokens: 128000,
  });
  expect(metadata).toEqual({
    capabilities: { tools: true, structuredOutput: null },
    limits: { maxOutputTokens: 128000 },
  });
});

test('Anthropic list metadata yields supported effort levels, adaptive thinking and limits; zero means unknown', () => {
  expect(
    catalogEntryMetadata('anthropic-messages-v1', {
      capabilities: {
        effort: { supported: true, low: { supported: true }, max: { supported: true }, high: {} },
        thinking: {
          supported: true,
          types: { adaptive: { supported: true }, enabled: { supported: true } },
        },
        structured_outputs: { supported: false },
      },
      max_tokens: 64000,
      max_input_tokens: 0,
    })
  ).toEqual({
    capabilities: { tools: null, structuredOutput: false },
    limits: { maxOutputTokens: 64000 },
    options: { thinking: ['low', 'max'], thinkingModes: ['adaptive'] },
  });
  expect(catalogEntryMetadata('anthropic-messages-v1', { capabilities: null })).toEqual({
    capabilities: { tools: null, structuredOutput: null },
  });
});

test('Vercel list metadata keeps vocabulary effort values, tool tags and both limits', () => {
  expect(
    catalogEntryMetadata('vercel-chat-v1', {
      context_window: 1000000,
      max_tokens: 64000,
      tags: ['file-input', 'tool-use', 'reasoning'],
      reasoning_options: [
        { type: 'budget_tokens', min: 1024 },
        { type: 'effort', values: ['low', 'high', 'ultra', 5] },
      ],
    })
  ).toEqual({
    capabilities: { tools: true, structuredOutput: null },
    limits: { maxOutputTokens: 64000, inputTokenLimit: 1000000 },
    options: { thinking: ['low', 'high'] },
  });
  expect(catalogEntryMetadata('openai-responses-v1', { max_tokens: 1000 })).toEqual({
    capabilities: { tools: null, structuredOutput: null },
  });
});

test('hints prefer list metadata, fall back to the reviewed table, and always carry the protocol vocabulary', () => {
  expect(thinkingField('vertex-gemini-v1')).toBe('thinkingLevel');
  expect(thinkingField('anthropic-messages-v1')).toBe('outputEffort');
  expect(thinkingField('deepseek-chat-v1')).toBe('reasoningEffort');
  const reviewed = modelHints(connection('anthropic-messages-v1'), 'claude-opus-5');
  expect(reviewed).toMatchObject({
    source: 'reviewed',
    maxOutputTokens: 128000,
    thinking: {
      field: 'outputEffort',
      known: ['low', 'medium', 'high', 'xhigh', 'max'],
      all: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    thinkingModes: { known: ['adaptive', 'disabled'], all: ['disabled', 'adaptive'] },
  });
  const listed = modelHints(
    connection('anthropic-messages-v1', [
      {
        id: 'claude-opus-5',
        name: 'Opus',
        capabilities: {},
        priceRevision: null,
        limits: { maxOutputTokens: 64000, inputTokenLimit: 200000 },
        options: { thinking: ['low', 'high'] },
      },
    ]),
    'claude-opus-5'
  );
  expect(listed).toMatchObject({
    source: 'catalog',
    maxOutputTokens: 64000,
    inputTokenLimit: 200000,
    thinking: { known: ['low', 'high'] },
    thinkingModes: { known: ['adaptive', 'disabled'] },
  });
  const unknown = modelHints(connection('openai-responses-v1'), 'gpt-7');
  expect(unknown.source).toBe('none');
  expect(unknown.maxOutputTokens).toBeUndefined();
  expect(unknown.thinking).toEqual({
    field: 'reasoningEffort',
    wire: 'reasoning.effort',
    gateway: false,
    known: undefined,
    all: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  });
  // Gateways receive their own field and map it onto the model provider's parameter.
  expect(
    modelHints(connection('vercel-chat-v1'), 'anthropic/claude-opus-5').thinking
  ).toMatchObject({ field: 'reasoningEffort', wire: 'reasoning_effort', gateway: true });
  expect(thinkingWireField('anthropic-messages-v1')).toBe('output_config.effort');
  expect(thinkingWireField('vertex-gemini-v1')).toBe(
    'generationConfig.thinkingConfig.thinkingLevel'
  );
  expect(unknown.thinkingModes).toBeUndefined();
  expect(modelHints(connection('codex-app-server-v1'), 'codex').thinking?.field).toBe(
    'reasoningEffort'
  );
});

test('Gemini Developer API list entries keep generation models only, drop the models/ prefix and carry both limits', () => {
  expect(
    geminiListEntry({
      name: 'models/gemini-3.8-flash',
      displayName: 'Gemini 3.8 Flash',
      inputTokenLimit: 1048576,
      outputTokenLimit: 65536,
      supportedGenerationMethods: ['generateContent', 'countTokens'],
    })
  ).toEqual({
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    capabilities: { tools: null, structuredOutput: null },
    priceRevision: null,
    limits: { maxOutputTokens: 65536, inputTokenLimit: 1048576 },
  });
  expect(
    geminiListEntry({
      name: 'models/gemini-3.9-pro',
      supportedGenerationMethods: ['generateContent'],
    })
  ).toEqual({
    id: 'gemini-3.9-pro',
    name: 'gemini-3.9-pro',
    capabilities: { tools: null, structuredOutput: null },
    priceRevision: null,
  });
  for (const raw of [
    { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemini-image', supportedGenerationMethods: ['predict'] },
    { name: 'tunedModels/gemini-x', supportedGenerationMethods: ['generateContent'] },
    { displayName: 'no name' },
  ])
    expect(geminiListEntry(raw)).toBeUndefined();
});
