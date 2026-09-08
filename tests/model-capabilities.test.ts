import { expect, test } from 'vitest';
import {
  MODEL_SUPPORT_POLICY,
  generationFromModel,
  modelCapability,
  requireSupportedModel,
  validateCapabilityRevision,
  validateModelOptions,
} from '../core/model-capabilities.js';
import { validateRequest } from '../core/transport.js';
import { createEvaluationToolSession } from '../server/evaluation-session.js';
import { defaultEvaluationToolOptions } from '../core/evaluation-tool-config.js';
import type { ModelGeneration, ModelPreset } from '../core/product.js';

const base: ModelGeneration = { maxOutputTokens: 8192, temperature: null };
test('new provider models validate their own thinking modes and output boundaries', () => {
  expect(() =>
    validateModelOptions(
      { ...base, thinkingLevel: 'MINIMAL' },
      'vertex-gemini-v1',
      'gemini-3.5-flash-lite'
    )
  ).not.toThrow();
  expect(() =>
    validateModelOptions({ ...base, temperature: 1 }, 'vertex-gemini-v1', 'gemini-3.5-flash-lite')
  ).toThrow();
  expect(() =>
    validateModelOptions(
      { ...base, thinkingLevel: 'LOW' },
      'vertex-gemini-v1',
      'gemini-3.5-flash-lite'
    )
  ).toThrow();
  expect(() =>
    validateModelOptions(
      { ...base, maxOutputTokens: 500000, reasoningEffort: 'xhigh' },
      'vercel-chat-v1',
      'spacexai/grok-4.6'
    )
  ).not.toThrow();
  expect(() =>
    validateModelOptions(
      { ...base, maxOutputTokens: 500001 },
      'vercel-chat-v1',
      'spacexai/grok-4.6'
    )
  ).toThrow();
  expect(() =>
    validateModelOptions(
      { ...base, reasoningEffort: 'none' },
      'vercel-chat-v1',
      'spacexai/grok-4.6'
    )
  ).toThrow();
  expect(() =>
    validateModelOptions(
      { ...base, maxOutputTokens: 128001 },
      'vercel-chat-v1',
      'openai/gpt-5.6-sol'
    )
  ).toThrow();
  expect(() =>
    validateModelOptions(
      { ...base, reasoningEffort: 'none' },
      'vercel-chat-v1',
      'openai/gpt-5.6-sol'
    )
  ).not.toThrow();
  expect(modelCapability('openai-chat-v1', 'spacexai/grok-4.6')).toBeUndefined();
  for (const id of ['deepseek-v4-pro', 'deepseek-v4-flash']) {
    expect(() =>
      validateModelOptions(
        { ...base, maxOutputTokens: 384000, reasoningEffort: 'max' },
        'deepseek-chat-v1',
        id
      )
    ).not.toThrow();
    expect(() =>
      validateModelOptions({ ...base, maxOutputTokens: 384001 }, 'deepseek-chat-v1', id)
    ).toThrow();
    expect(() =>
      validateModelOptions(
        { ...base, reasoningEffort: 'none', temperature: 0.5 },
        'deepseek-chat-v1',
        id
      )
    ).not.toThrow();
    expect(() =>
      validateModelOptions({ ...base, temperature: 0.5 }, 'deepseek-chat-v1', id)
    ).toThrow('INCOMPATIBLE_THINKING_SAMPLING');
    expect(() =>
      validateModelOptions({ ...base, structuredOutput: true }, 'deepseek-chat-v1', id)
    ).toThrow();
  }
});
test('exact model support differentiates efforts, thinking defaults, Fable always-on and Gemini sampling', () => {
  expect(MODEL_SUPPORT_POLICY.supportWindowMonths).toBe(6);
  expect(modelCapability('vertex-gemini-v1', 'gemini-3.1-pro-preview')?.defaultThinkingLevel).toBe(
    'HIGH'
  );
  expect(modelCapability('vertex-gemini-v1', 'gemini-3.8-flash')?.defaultThinkingLevel).toBe(
    'MEDIUM'
  );
  expect(() =>
    validateModelOptions(
      { ...base, temperature: 0, topP: 0 },
      'vertex-gemini-v1',
      'gemini-3.1-pro-preview'
    )
  ).not.toThrow();
  expect(() =>
    validateModelOptions({ ...base, temperature: 0 }, 'vertex-gemini-v1', 'gemini-3.8-flash')
  ).toThrow();
  expect(() =>
    validateModelOptions(
      { ...base, reasoningEffort: 'none', verbosity: 'low', serviceTier: 'flex' },
      'openai-responses-v1',
      'gpt-5.6-sol'
    )
  ).not.toThrow();
  expect(() =>
    validateModelOptions({ ...base, reasoningEffort: 'none' }, 'openai-responses-v1', 'gpt-6-astra')
  ).toThrow();
  expect(() =>
    validateModelOptions(
      { ...base, thinkingMode: 'disabled', outputEffort: 'high' },
      'anthropic-messages-v1',
      'claude-opus-5'
    )
  ).not.toThrow();
  expect(() =>
    validateModelOptions(
      { ...base, thinkingMode: 'disabled', outputEffort: 'xhigh' },
      'anthropic-messages-v1',
      'claude-opus-5'
    )
  ).toThrow('INCOMPATIBLE_THINKING_EFFORT');
  expect(() =>
    validateModelOptions(
      { ...base, thinkingMode: 'disabled', outputEffort: 'low' },
      'anthropic-messages-v1',
      'claude-fable-5-1'
    )
  ).toThrow();
  expect(() =>
    validateModelOptions(
      { ...base, thinkingMode: 'adaptive', outputEffort: 'max' },
      'anthropic-messages-v1',
      'claude-fable-5-1'
    )
  ).not.toThrow();
});

test('unreviewed IDs do not inherit official capabilities and a saved capability revision is required', () => {
  const id = 'gpt-5.6-sol',
    protocol = 'openai-responses-v1',
    revision = modelCapability(protocol, id)!.revision;
  expect(modelCapability(protocol, id + '-future')).toBeUndefined();
  expect(() =>
    requireSupportedModel({ protocol, endpoint: 'https://api.openai.com/v1' }, id + '-future')
  ).toThrow('UNVERIFIED_MODEL_CAPABILITY');
  expect(() =>
    requireSupportedModel({ protocol, endpoint: 'https://synthetic.invalid/v1' }, 'custom-model')
  ).not.toThrow();
  expect(() => validateCapabilityRevision({ modelId: id }, protocol)).toThrow(
    'MODEL_CAPABILITY_REVISION_MISMATCH'
  );
  expect(() =>
    validateCapabilityRevision({ modelId: id, capabilityRevision: 'future' }, protocol)
  ).toThrow();
  expect(() =>
    validateCapabilityRevision({ modelId: id, capabilityRevision: revision }, protocol)
  ).not.toThrow();
  expect(
    generationFromModel({ ...base, modelId: id, capabilityRevision: revision }, protocol)
  ).toEqual(base);
});

test('cache times are explicit, provider-specific, and incompatible with OFF', () => {
  for (const ttl of ['5m', '1h'] as const)
    expect(() =>
      validateModelOptions(
        { ...base, cacheMode: 'automatic', cacheTtl: ttl },
        'anthropic-messages-v1',
        'claude-fable-5-1'
      )
    ).not.toThrow();
  expect(() =>
    validateModelOptions(
      { ...base, cacheMode: 'explicit', cacheTtl: '30m' },
      'openai-responses-v1',
      'gpt-5.6-luna'
    )
  ).not.toThrow();
  expect(() =>
    validateModelOptions(
      { ...base, cacheMode: 'explicit', cacheTtl: '5m' },
      'openai-responses-v1',
      'gpt-5.6-luna'
    )
  ).toThrow();
  for (const cacheMode of [undefined, 'disabled'] as const)
    expect(() =>
      validateModelOptions(
        { ...base, cacheMode, cacheTtl: '1h' },
        'anthropic-messages-v1',
        'claude-opus-5'
      )
    ).toThrow('CACHE_TTL_REQUIRES_CACHE_MODE');
  expect(() =>
    validateModelOptions({ ...base, cacheMode: 'disabled' }, 'vertex-gemini-v1', 'gemini-3.8-flash')
  ).toThrow();
  expect(() =>
    validateModelOptions({ ...base, serviceTier: 'flex' }, 'openai-chat-v1', 'gpt-6-astra')
  ).not.toThrow();
  expect(() =>
    validateModelOptions({ ...base, cacheMode: 'disabled' }, 'openai-chat-v1', 'gpt-6-astra')
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
