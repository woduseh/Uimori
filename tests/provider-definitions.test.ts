import { describe, expect, test } from 'vitest';
import { PROVIDER_DEFINITIONS, providerDefinition } from '../core/provider-definitions.js';
import {
  PROVIDER_PROTOCOLS,
  validateProviderEndpoint,
  type ProviderProtocol,
} from '../core/product.js';

describe('local provider definitions (no network or provider capability inference)', () => {
  test('covers every registered protocol once without installing new protocols', () => {
    expect(new Set(PROVIDER_DEFINITIONS.map((item) => item.id))).toEqual(
      new Set(PROVIDER_PROTOCOLS)
    );
    expect(new Set(PROVIDER_DEFINITIONS.map((item) => item.id)).size).toBe(
      PROVIDER_DEFINITIONS.length
    );
    for (const protocol of PROVIDER_PROTOCOLS)
      expect(providerDefinition(protocol).id).toBe(protocol);
    expect(() => providerDefinition('unregistered' as ProviderProtocol)).toThrow(
      'UNSUPPORTED_PROTOCOL'
    );
  });
  test('retains existing endpoint/environment defaults and validates every populated endpoint', () => {
    for (const item of PROVIDER_DEFINITIONS) {
      if (item.endpointDefault)
        expect(validateProviderEndpoint(item.id, item.endpointDefault)).toBe(item.endpointDefault);
      if (item.credentialEnvDefault)
        expect(item.credentialEnvDefault).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/u);
    }
    for (const protocol of ['fixture-sse-v1', 'vertex-gemini-v1', 'openai-chat-v1'] as const)
      expect(providerDefinition(protocol).endpointDefault).toBe('');
    expect(providerDefinition('openai-responses-v1').credentialEnvDefault).toBe('OPENAI_API_KEY');
    expect(providerDefinition('anthropic-messages-v1').credentialEnvDefault).toBe(
      'ANTHROPIC_API_KEY'
    );
    expect(providerDefinition('vercel-chat-v1').credentialEnvDefault).toBe('VERCEL_API_KEY');
    expect(providerDefinition('openai-chat-v1').credentialEnvDefault).toBe('PROVIDER_API_KEY');
  });
  test('keeps adapter provenance separate from unknown model capabilities and prices', () => {
    for (const item of PROVIDER_DEFINITIONS) {
      expect(Number.isInteger(item.revision) && item.revision > 0).toBe(true);
      expect(item.source.kind).toBe('adapter');
      expect(item.source.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(item.source.checkedAt).toISOString().slice(0, 10)).toBe(
        item.source.checkedAt
      );
      expect(item.source.reference).toMatch(/^core\/[a-z-]+\.ts#[A-Za-z]+$/);
      expect(item.modelCapabilities).toEqual({ tools: null, structuredOutput: null });
      expect(item.price).toBe('unknown');
      expect(item.limitations.length).toBeGreaterThan(0);
      expect(new Set(item.optionKeys).size).toBe(item.optionKeys.length);
    }
    expect(
      PROVIDER_DEFINITIONS.filter((item) => item.catalog === 'local-support').map((item) => item.id)
    ).toEqual(['vertex-gemini-v1']);
  });
  test('does not advertise provider-specific model options on incompatible adapters', () => {
    expect(providerDefinition('vertex-gemini-v1').optionKeys).toEqual([
      'maxOutputTokens',
      'temperature',
      'timeoutMs',
      'thinkingLevel',
      'topP',
      'stopSequences',
      'serviceTier',
    ]);
    for (const item of PROVIDER_DEFINITIONS) {
      expect(item.optionKeys).not.toContain('requestTier');
      expect(item.optionKeys).not.toContain('sol');
      expect(item.optionKeys).not.toContain('evaluationTools');
      for (const settingField of ['connectionRevision', 'revision', 'expectedRevision'])
        expect(item.optionKeys).not.toContain(settingField);
      expect(item.optionKeys.includes('thinkingMode')).toBe(item.id === 'anthropic-messages-v1');
      expect(item.optionKeys).not.toContain('thinkingBudgetTokens');
      if (!['vertex-gemini-v1', 'fixture-sse-v1'].includes(item.id))
        expect(item.optionKeys).not.toContain('thinkingLevel');
      if (['vertex-gemini-v1', 'fixture-sse-v1'].includes(item.id))
        expect(item.optionKeys).not.toContain('reasoningEffort');
    }
    expect(providerDefinition('anthropic-messages-v1').auth).toBe('api-key');
    expect(providerDefinition('vertex-gemini-v1').auth).toBe('adc-or-bearer');
  });
  test('callers cannot mutate shared definitions or their nested capability/option metadata', () => {
    expect(Object.isFrozen(PROVIDER_DEFINITIONS)).toBe(true);
    for (const item of PROVIDER_DEFINITIONS)
      for (const part of [
        item,
        item.optionKeys,
        item.limitations,
        item.source,
        item.modelCapabilities,
      ])
        expect(Object.isFrozen(part)).toBe(true);
    expect(() =>
      (providerDefinition('openai-responses-v1').optionKeys as string[]).push('arbitraryHeader')
    ).toThrow();
  });
});
