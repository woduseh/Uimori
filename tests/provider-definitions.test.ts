import { describe, expect, test } from 'vitest';
import { PROVIDER_DEFINITIONS, providerDefinition } from '../core/provider-definitions.js';
import { PROVIDER_PROTOCOLS, validateProviderEndpoint, type ProviderProtocol } from '../core/product.js';
import { SOL_GATEWAYS } from '../core/sol-config.js';

describe('local provider definitions (no network or provider capability inference)', () => {
  test('covers every registered protocol once without installing new protocols', () => {
    expect(PROVIDER_DEFINITIONS.map(item => item.id)).toEqual([...PROVIDER_PROTOCOLS]);
    expect(new Set(PROVIDER_DEFINITIONS.map(item => item.id)).size).toBe(7);
    for (const protocol of PROVIDER_PROTOCOLS) expect(providerDefinition(protocol).id).toBe(protocol);
    expect(() => providerDefinition('unregistered' as ProviderProtocol)).toThrow('UNSUPPORTED_PROTOCOL');
  });
  test('retains existing endpoint/environment defaults and validates every populated endpoint', () => {
    for (const item of PROVIDER_DEFINITIONS) {
      if (item.endpointDefault) expect(validateProviderEndpoint(item.id, item.endpointDefault)).toBe(item.endpointDefault);
      if (item.credentialEnvDefault) expect(item.credentialEnvDefault).toMatch(/^NARRATIVE_PROVIDER_[A-Z0-9_]+$/);
    }
    for (const protocol of ['fixture-sse-v1', 'vertex-gemini-v1', 'openai-chat-v1'] as const) expect(providerDefinition(protocol).endpointDefault).toBe('');
    expect(providerDefinition('sol-responses-v1')).toMatchObject({ endpointDefault: SOL_GATEWAYS[0].endpoint, credentialEnvDefault: SOL_GATEWAYS[0].credentialEnv });
    expect(providerDefinition('openai-responses-v1').credentialEnvDefault).toBe('NARRATIVE_PROVIDER_OPENAI');
    expect(providerDefinition('anthropic-messages-v1').credentialEnvDefault).toBe('NARRATIVE_PROVIDER_ANTHROPIC');
    expect(providerDefinition('vercel-chat-v1').credentialEnvDefault).toBe('NARRATIVE_PROVIDER_VERCEL');
    expect(providerDefinition('openai-chat-v1').credentialEnvDefault).toBe('NARRATIVE_PROVIDER_CUSTOM');
  });
  test('keeps adapter provenance separate from unknown model capabilities and prices', () => {
    for (const item of PROVIDER_DEFINITIONS) {
      expect(item.revision).toBe(1); expect(item.source).toMatchObject({ kind: 'adapter', checkedAt: '2026-09-07' });
      expect(item.source.reference).toMatch(/^core\/[a-z-]+\.ts#[A-Za-z]+$/);
      expect(item.modelCapabilities).toEqual({ tools: null, structuredOutput: null }); expect(item.price).toBe('unknown');
      expect(item.limitations.length).toBeGreaterThan(0);
      expect(new Set(item.optionKeys).size).toBe(item.optionKeys.length);
    }
    expect(PROVIDER_DEFINITIONS.filter(item => item.catalog === 'local-support').map(item => item.id)).toEqual(['vertex-gemini-v1']);
  });
  test('does not advertise provider-specific model options on incompatible adapters', () => {
    expect(providerDefinition('vertex-gemini-v1').optionKeys).toEqual(['maxOutputTokens', 'timeoutMs', 'thinkingLevel']);
    for (const item of PROVIDER_DEFINITIONS) {
      expect(item.optionKeys).not.toContain('requestTier');
      expect(item.optionKeys.includes('sol')).toBe(item.id === 'sol-responses-v1');
      expect(item.optionKeys.includes('thinkingMode')).toBe(item.id === 'anthropic-messages-v1');
      expect(item.optionKeys.includes('thinkingBudgetTokens')).toBe(item.id === 'anthropic-messages-v1');
      if (!['vertex-gemini-v1', 'fixture-sse-v1'].includes(item.id)) expect(item.optionKeys).not.toContain('thinkingLevel');
      if (['vertex-gemini-v1', 'fixture-sse-v1'].includes(item.id)) expect(item.optionKeys).not.toContain('reasoningEffort');
    }
    expect(providerDefinition('anthropic-messages-v1').auth).toBe('api-key'); expect(providerDefinition('vertex-gemini-v1').auth).toBe('adc-or-bearer');
  });
  test('callers cannot mutate shared definitions or their nested capability/option metadata', () => {
    expect(Object.isFrozen(PROVIDER_DEFINITIONS)).toBe(true);
    for (const item of PROVIDER_DEFINITIONS) for (const part of [item, item.optionKeys, item.limitations, item.source, item.modelCapabilities]) expect(Object.isFrozen(part)).toBe(true);
    expect(() => (providerDefinition('sol-responses-v1').optionKeys as string[]).push('arbitraryHeader')).toThrow();
  });
});
