import { expect, test } from 'vitest';
import { resolveTokenizerProfile, type TokenizerProfileId } from '../core/tokenizer-profiles.js';

test('chooses a reviewed local profile from model aliases and falls back to generic', () => {
  for (const [modelId, expected] of [
    ['openai/gpt-4o', 'openai-o200k'],
    ['ft:gpt-4.1:personal:model', 'openai-o200k'],
    ['gpt-4-turbo', 'openai-cl100k'],
    ['google/gemini-2.5-flash', 'gemini-gemma3'],
    ['gemini-3.1-pro-preview', 'gemini-gemma4'],
    ['deepseek-ai/DeepSeek-V3.2', 'deepseek-v3'],
    ['deepseek-v4-pro', 'deepseek-v4'],
    ['deepseek-flash', 'deepseek-v4.1'],
    ['deepseek-v4-flash', 'deepseek-v4.1'],
    ['zai-org/GLM-4.6', 'glm-4.7'],
    ['glm-4.7-flash', 'glm-5'],
    ['moonshotai/Kimi-K2.5', 'kimi-k2'],
    ['claude-fable-5-2', 'claude-legacy'],
    ['xai/grok-4', 'grok-estimate'],
    ['gemini-4-hydrogen', 'generic'],
    ['gemini-3.8-flash', 'generic'],
    ['glm-6', 'generic'],
    ['my-deployment-name', 'generic'],
  ] as [string, TokenizerProfileId][])
    expect(resolveTokenizerProfile({ modelId }), modelId).toBe(expected);
});

test('manual selection overrides aliases and connection protocol without changing model identity', () => {
  const model = {
    modelId: 'gpt-4o',
    tokenizer: 'kimi-k2' as const,
    connection: { protocol: 'openai-chat-v1' },
  };
  expect(resolveTokenizerProfile(model)).toBe('kimi-k2');
  expect(model.modelId).toBe('gpt-4o');
});
