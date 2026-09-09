import { expect, test } from 'vitest';
import { catalogEntryMetadata, geminiListEntry } from '../core/provider-catalog.js';
import { modelHints, thinkingField, thinkingWireField } from '../core/model-hints.js';
import type { Connection } from '../core/product.js';

const connection = (
  protocol: Connection['protocol'],
  catalog: Connection['catalog'] = []
): Pick<Connection, 'protocol' | 'catalog'> => ({ protocol, catalog });

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
