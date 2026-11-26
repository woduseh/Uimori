import { expect, test } from 'vitest';
import { resolveTokenizerProfile } from '../core/tokenizer-profiles.js';

test('manual selection overrides aliases and connection protocol without changing model identity', () => {
  const model = {
    modelId: 'gpt-4o',
    tokenizer: 'kimi-k2' as const,
    connection: { protocol: 'openai-chat-v1' },
  };
  expect(resolveTokenizerProfile(model)).toBe('kimi-k2');
  expect(model.modelId).toBe('gpt-4o');
});
