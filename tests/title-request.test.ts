import { expect, test } from 'vitest';
import type { Connection, ModelPreset } from '../core/product.js';
import { titleRequest } from '../server/title-request.js';
import { encodeVertex } from '../core/vertex-protocol.js';

function fixture(protocol: Connection['protocol'] = 'openai-responses-v1') {
  const connection: Connection = {
    id: 'title-connection',
    revision: 1,
    title: 'Title connection',
    protocol,
    endpoint: 'https://example.invalid/v1/responses',
    enabled: true,
    catalog: [],
    catalogError: null,
  };
  const model: ModelPreset = {
    id: 'title-model',
    revision: 1,
    title: 'Title model',
    connectionId: connection.id,
    modelId: 'synthetic-title-model',
    maxOutputTokens: 8192,
    temperature: null,
  };
  return { connection, model };
}
const input = { contract: 'Return a short title.', task: '{"source":"A scene"}' };

test.each(['openai-responses-v1', 'anthropic-messages-v1'] as const)(
  'title request carries its own bounded text-only policy for %s',
  (protocol) => {
    const { connection, model } = fixture(protocol);
    const original = structuredClone({ connection, model });
    const request = titleRequest(model, connection, input);
    expect(request).toMatchObject({
      role: 'title',
      modelId: model.modelId,
      generation: { maxOutputTokens: model.maxOutputTokens, temperature: null },
      contextBudget: { estimator: 'model-local-v1', tokenizer: 'generic' },
      stable: { contract: input.contract, tools: [] },
      input: { task: input.task, controls: {} },
    });
    expect(request).not.toHaveProperty('providerOptions');
    expect({ connection, model }).toEqual(original);
  }
);

test('title cache policy does not rewrite saved Responses options', () => {
  const { connection, model } = fixture();
  model.reasoningEffort = 'high';
  model.verbosity = 'low';
  model.cacheMode = 'explicit';
  model.cacheTtl = '30m';
  const original = structuredClone(model);
  const request = titleRequest(model, connection, input);
  expect(request.generation).toMatchObject({
    maxOutputTokens: model.maxOutputTokens,
    reasoningEffort: 'high',
    verbosity: 'low',
    cacheMode: 'disabled',
  });
  expect(request.generation).not.toHaveProperty('cacheTtl');
  expect(model).toEqual(original);
});

test('title provider options are copied instead of sharing editable nested data', () => {
  const { connection, model } = fixture('vercel-chat-v1');
  model.providerOptions = { gateway: { order: ['example-provider'] } };
  const original = structuredClone(model.providerOptions);
  const request = titleRequest(model, connection, input);
  expect(request.providerOptions).toEqual(original);
  expect(request.providerOptions).not.toBe(model.providerOptions);
  expect(request.providerOptions?.gateway).not.toBe(model.providerOptions.gateway);
  expect(model.providerOptions).toEqual(original);
});

test.each([
  ['gemini-4-hydrogen', 'LOW'],
  ['gemini-4-carbon', 'LOW'],
] as const)('Vertex %s title requests its lowest thinking level', (modelId, level) => {
  const { connection, model } = fixture('vertex-gemini-v1');
  model.modelId = modelId;
  model.maxOutputTokens = 256;
  model.thinkingLevel = 'HIGH';
  const request = titleRequest(model, connection, input);
  expect(request.generation?.thinkingLevel).toBe(level);
  expect(
    (encodeVertex(request).body as { generationConfig: Record<string, unknown> }).generationConfig
      .thinkingConfig
  ).toEqual({ thinkingLevel: level });
  expect(model.thinkingLevel).toBe('HIGH');
});

test('title requests the lowest declared effort for reviewed Responses and Claude models', () => {
  const responses = fixture('openai-responses-v1');
  responses.model.modelId = 'gpt-6.2-astra';
  expect(titleRequest(responses.model, responses.connection, input).generation).toMatchObject({
    reasoningEffort: 'low',
  });
  const claude = fixture('anthropic-messages-v1');
  claude.model.modelId = 'claude-opus-5-5';
  expect(titleRequest(claude.model, claude.connection, input).generation).toMatchObject({
    outputEffort: 'low',
  });
});

test('title keeps saved thinking options for a model without reviewed capabilities', () => {
  const { connection, model } = fixture('vertex-gemini-v1');
  model.thinkingLevel = 'HIGH';
  expect(titleRequest(model, connection, input).generation?.thinkingLevel).toBe('HIGH');
});
