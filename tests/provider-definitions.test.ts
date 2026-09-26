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
    for (const protocol of PROVIDER_PROTOCOLS) {
      const definition = providerDefinition(protocol);
      expect(definition.id).toBe(protocol);
      expect(new Set(definition.optionKeys).size).toBe(definition.optionKeys.length);
    }
    expect(() => providerDefinition('unregistered' as ProviderProtocol)).toThrow(
      'UNSUPPORTED_PROTOCOL'
    );
  });
  test('retains existing endpoint/environment defaults and validates every populated endpoint', () => {
    for (const item of PROVIDER_DEFINITIONS) {
      if (item.endpointDefault)
        expect(validateProviderEndpoint(item.id, item.endpointDefault)).toBe(item.endpointDefault);
      if (item.credentialRefDefault)
        expect(item.credentialRefDefault).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/u);
    }
    for (const protocol of ['fixture-sse-v1', 'vertex-gemini-v1', 'openai-chat-v1'] as const)
      expect(providerDefinition(protocol).endpointDefault).toBe('');
    expect(providerDefinition('openai-responses-v1').credentialRefDefault).toBe('OPENAI_API_KEY');
    expect(providerDefinition('anthropic-messages-v1').credentialRefDefault).toBe(
      'ANTHROPIC_API_KEY'
    );
    expect(providerDefinition('vercel-chat-v1').credentialRefDefault).toBe('VERCEL_API_KEY');
    expect(providerDefinition('openai-chat-v1').credentialRefDefault).toBe('PROVIDER_API_KEY');
  });
  test('keeps direct adapters provider-specific while the Vercel gateway advertises selectable family options', () => {
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
      expect(item.optionKeys.includes('thinkingMode')).toBe(
        item.id === 'anthropic-messages-v1' || item.id === 'vercel-chat-v1'
      );
      expect(item.optionKeys).not.toContain('thinkingBudgetTokens');
      if (!['vertex-gemini-v1', 'fixture-sse-v1', 'vercel-chat-v1'].includes(item.id))
        expect(item.optionKeys).not.toContain('thinkingLevel');
      if (['vertex-gemini-v1', 'fixture-sse-v1'].includes(item.id))
        expect(item.optionKeys).not.toContain('reasoningEffort');
      if (item.id !== 'anthropic-messages-v1' && item.id !== 'vercel-chat-v1')
        expect(item.optionKeys).not.toContain('outputEffort');
      if (item.id !== 'openai-responses-v1' && item.id !== 'vercel-chat-v1')
        expect(item.optionKeys).not.toContain('verbosity');
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
