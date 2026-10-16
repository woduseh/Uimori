import { expect, test } from 'vitest';
import {
  generationFromModel,
  modelCapability,
  protocolOptionKeys,
  supportedModels,
  validateModelOptions,
} from '../core/model-capabilities.js';
import { PROVIDER_PROTOCOLS, type ModelGeneration, type ModelPreset } from '../core/product.js';
import { validateRequest } from '../core/transport.js';
import { createEvaluationToolSession } from '../server/evaluation-session.js';
import { defaultEvaluationToolOptions } from '../core/evaluation-tool-config.js';

const base: ModelGeneration = { maxOutputTokens: 8192, temperature: null };

test('Gemini 4 Argon is reviewed with explicit thinking levels and implicit-only caching', () => {
  for (const protocol of ['vertex-gemini-v1', 'google-gemini-v1'] as const) {
    expect(modelCapability(protocol, 'gemini-4-argon')).toMatchObject({
      maxOutputTokens: 65_536,
      thinkingLevels: ['LOW', 'MEDIUM', 'HIGH'],
      defaultThinkingLevel: 'MEDIUM',
    });
    expect(modelCapability(protocol, 'gemini-4-argon')?.cacheModes).toBeUndefined();
  }
});

test('AI Studio reuses Gemini model hints with its own service tiers', () => {
  const capability = modelCapability('google-gemini-v1', 'gemini-3.1-pro-preview');
  expect(capability?.thinkingLevels).toEqual(['LOW', 'MEDIUM', 'HIGH']);
  expect(capability?.serviceTiers).toEqual(['standard', 'flex', 'priority']);
  expect(() =>
    validateModelOptions({ ...base, serviceTier: 'priority' }, 'google-gemini-v1')
  ).not.toThrow();
  expect(() =>
    validateModelOptions({ ...base, serviceTier: 'default' }, 'google-gemini-v1')
  ).toThrow();
});

test('validation is protocol-level: any listed or unlisted model may use every option its encoder sends', () => {
  // Unlisted values on reviewed models and reviewed values on unlisted models both pass locally.
  expect(() =>
    validateModelOptions({ ...base, thinkingLevel: 'LOW' }, 'vertex-gemini-v1')
  ).not.toThrow();
  expect(() =>
    validateModelOptions({ ...base, temperature: 1, topP: 0.5 }, 'vertex-gemini-v1')
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
    validateModelOptions({ ...base, reasoningEffort: 'high', temperature: 0.5 }, 'deepseek-chat-v1')
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
  expect(() =>
    validateModelOptions({ ...base, serviceTier: 'flex' }, 'openai-chat-v1')
  ).not.toThrow();
});

test('options the encoder cannot send and values outside the protocol vocabulary are rejected', () => {
  expect(() =>
    validateModelOptions({ ...base, maxOutputTokens: 500001 }, 'vercel-chat-v1')
  ).toThrow();
  expect(() =>
    validateModelOptions({ ...base, temperature: 0 }, 'anthropic-messages-v1')
  ).toThrow();
  expect(() => validateModelOptions({ ...base, temperature: 0 }, 'codex-app-server-v1')).toThrow();
  expect(() =>
    validateModelOptions({ ...base, structuredOutput: true }, 'vertex-gemini-v1')
  ).toThrow();
  expect(() =>
    validateModelOptions({ ...base, thinkingLevel: 'HIGH' }, 'openai-responses-v1')
  ).toThrow();
  expect(() =>
    validateModelOptions({ ...base, reasoningEffort: 'high' }, 'anthropic-messages-v1')
  ).toThrow();
  expect(() => validateModelOptions({ ...base, verbosity: 'low' }, 'openai-chat-v1')).toThrow();
  expect(() =>
    validateModelOptions(
      { ...base, thinkingMode: 'enabled' } as unknown as ModelGeneration,
      'anthropic-messages-v1'
    )
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
    [],
    { HARM_CATEGORY_HARASSMENT: 'DEFAULT' },
    { HARM_CATEGORY_HARASSMENT: null },
    { HARM_CATEGORY_UNKNOWN: 'OFF' },
  ])
    expect(() =>
      validateModelOptions(
        { ...base, safetySettings: value } as ModelGeneration,
        'vertex-gemini-v1'
      )
    ).toThrow('UNSUPPORTED_GENERATION_OPTIONS');

  const request = {
    role: 'main',
    modelId: 'gemini-3.8-flash',
    stable: { contract: 'Synthetic', tools: [] },
    input: { task: 'Synthetic', controls: {} },
    generation: configured,
    generationBinding: configured,
  };
  expect(() => validateRequest(request)).not.toThrow();
  expect(() =>
    validateRequest({
      ...request,
      generation: {
        ...configured,
        safetySettings: {
          HARM_CATEGORY_SEXUALLY_EXPLICIT: 'BLOCK_NONE' as const,
          HARM_CATEGORY_HARASSMENT: 'OFF' as const,
        },
      },
    })
  ).not.toThrow();
  expect(() =>
    validateRequest({
      ...request,
      generation: {
        ...configured,
        safetySettings: { HARM_CATEGORY_HARASSMENT: 'BLOCK_NONE' as const },
      },
    })
  ).toThrow('INVALID_GENERATION_BINDING');
});

test('the hint table still describes reviewed models but never gates unlisted IDs', () => {
  expect(modelCapability('vertex-gemini-v1', 'gemini-3.1-pro-preview')?.defaultThinkingLevel).toBe(
    'HIGH'
  );
  expect(modelCapability('vertex-gemini-v1', 'gemini-3.8-flash')?.thinkingLevels).toEqual([
    'LOW',
    'MEDIUM',
    'HIGH',
  ]);
  expect(modelCapability('anthropic-messages-v1', 'claude-fable-5-1')?.thinkingModes).toEqual([
    'adaptive',
  ]);
  expect(modelCapability('anthropic-messages-v1', 'claude-opus-5-5')).toMatchObject({
    defaultOutputEffort: 'medium',
    thinkingModes: ['adaptive'],
    forcedTools: false,
    cacheModes: ['disabled', 'explicit', 'automatic'],
    cacheTtls: ['5m', '1h'],
  });
  expect(modelCapability('openai-responses-v1', 'gpt-5.6-sol-future')).toBeUndefined();
  expect(modelCapability('openai-chat-v1', 'spacexai/grok-4.6')).toBeUndefined();
  expect(supportedModels('openai-chat-v1').every((item) => item.cacheModes === undefined)).toBe(
    true
  );
  expect(generationFromModel({ ...base, modelId: 'gpt-5.6-sol' } as ModelGeneration)).toEqual(base);
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

test('opt-in economy can lower effort but cannot change cache, tier, stop strings or enable reasoning', () => {
  const selected: ModelPreset & { connection: unknown } = {
    id: 'model',
    revision: 1,
    title: 'Synthetic',
    modelId: 'claude-opus-5',
    connectionId: 'connection',
    ...base,
    maxOutputTokens: 16000,
    outputEffort: 'max',
    cacheMode: 'explicit',
    cacheTtl: '5m',
    stopSequences: ['END'],
    serviceTier: 'auto',
    evaluationTools: {
      ...defaultEvaluationToolOptions(),
      contextMode: 'preloaded',
      approvalReasoningMode: 'economized',
    },
    connection: {},
  };
  const evaluation = createEvaluationToolSession(selected)!;
  const configured = generationFromModel(selected),
    actual = evaluation.generation(configured, 0);
  expect(actual).toEqual({ ...configured, maxOutputTokens: 8000, outputEffort: 'low' });
  const request = {
    role: 'main',
    modelId: selected.modelId,
    stable: { contract: 'Synthetic', tools: [] },
    input: { task: 'Synthetic', controls: {} },
    generation: actual,
    generationBinding: configured,
  };
  expect(() => validateRequest(request)).not.toThrow();
  for (const mutation of [
    { cacheMode: 'disabled' },
    { cacheTtl: '1h' },
    { serviceTier: 'standard_only' },
    { stopSequences: ['CHANGED'] },
    { maxOutputTokens: 17000 },
  ])
    expect(() => validateRequest({ ...request, generation: { ...actual, ...mutation } })).toThrow(
      'INVALID_GENERATION_BINDING'
    );
  expect(() =>
    validateRequest({
      ...request,
      generation: { ...base, reasoningEffort: 'low' },
      generationBinding: { ...base, reasoningEffort: 'none' },
    })
  ).toThrow('INVALID_GENERATION_BINDING');
});
