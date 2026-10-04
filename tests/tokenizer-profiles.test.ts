import { expect, test } from 'vitest';
import { resolveTokenizerProfile, type TokenizerProfileId } from '../core/tokenizer-profiles.js';

test.each([
  ['openai/gpt-4o', 'openai-o200k'],
  ['gpt-5.6-sol', 'openai-o200k'],
  ['ft:gpt-4.1:personal:model', 'openai-o200k'],
  ['gpt-4-turbo', 'openai-cl100k'],
  ['o3-mini', 'openai-o200k'],
  ['google/gemini-2.5-flash', 'gemini-gemma3'],
  ['gemini-3-flash-preview', 'gemini-gemma3'],
  ['gemini-3.1-pro-preview', 'gemini-gemma4'],
  ['gemini-3.5-flash', 'gemini-gemma4'],
  ['deepseek-ai/DeepSeek-V3.2', 'deepseek-v3'],
  ['deepseek-v4-pro', 'deepseek-v4'],
  ['deepseek-flash', 'deepseek-v4.1'],
  ['deepseek-v4-flash', 'deepseek-v4.1'],
  ['zai-org/GLM-4.6', 'glm-4.7'],
  ['glm-4.7-flash', 'glm-5'],
  ['glm-5.2', 'glm-5'],
  ['moonshotai/Kimi-K2.5', 'kimi-k2'],
  ['claude-opus-5', 'claude-legacy'],
  ['xai/grok-4', 'grok-estimate'],
  ['gemini-new-shiny', 'generic'],
  ['gemini-3.8-flash', 'generic'],
  ['gemini-2.5-pro-001-unsupported', 'generic'],
  ['glm-6', 'generic'],
  ['kimi-k3', 'generic'],
  ['my-deployment-name', 'generic'],
] as [string, TokenizerProfileId][])(
  'chooses a reviewed local profile for %s',
  (modelId, expected) => {
    expect(resolveTokenizerProfile({ modelId })).toBe(expected);
  }
);

test('manual selection overrides aliases and connection protocol without changing model identity', () => {
  const model = {
    modelId: 'gpt-4o',
    tokenizer: 'kimi-k2' as const,
    connection: { protocol: 'openai-chat-v1' },
  };
  expect(resolveTokenizerProfile(model)).toBe('kimi-k2');
  expect(model.modelId).toBe('gpt-4o');
});
