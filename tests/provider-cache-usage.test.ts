import { expect, test } from 'vitest';
import { providerCacheUsage } from '../core/provider-cache-usage.js';

test('cache usage distinguishes a confirmed read, zero, and missing data without inferring savings', () => {
  expect(
    providerCacheUsage('anthropic-messages-v1', {
      cache_read_input_tokens: 12,
      cache_creation_input_tokens: 5,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 5 },
    })
  ).toEqual({ readTokens: 12, writeTokens: 5, write5mTokens: 0, write1hTokens: 5 });
  expect(
    providerCacheUsage('openai-responses-v1', {
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 24 },
    })
  ).toEqual({ readTokens: 0, writeTokens: 24 });
  expect(providerCacheUsage('vertex-gemini-v1', { cachedContentTokenCount: 40 })).toEqual({
    readTokens: 40,
    writeTokens: null,
  });
  expect(
    providerCacheUsage('openai-chat-v1', { prompt_tokens_details: { cached_tokens: 9 } })
  ).toEqual({ readTokens: 9, writeTokens: null });
  expect(
    providerCacheUsage('openai-responses-v1', { input_tokens_details: { cached_tokens: -1 } })
  ).toEqual({ readTokens: null, writeTokens: null });
  expect(providerCacheUsage('openai-responses-v1', null)).toEqual({
    readTokens: null,
    writeTokens: null,
  });
  expect(providerCacheUsage('fixture-sse-v1', { cachedContentTokenCount: 40 })).toBeUndefined();
});

test('Vertex recognizes an omitted zero cache count only with valid reported prompt usage', () => {
  const raw = { promptTokenCount: 1000, candidatesTokenCount: 100, totalTokenCount: 1100 };
  expect(providerCacheUsage('vertex-gemini-v1', raw)).toEqual({
    readTokens: 0,
    writeTokens: null,
  });
  expect(raw).toEqual({ promptTokenCount: 1000, candidatesTokenCount: 100, totalTokenCount: 1100 });
  expect(providerCacheUsage('vertex-gemini-v1', { promptTokenCount: 0 })).toEqual({
    readTokens: 0,
    writeTokens: null,
  });

  for (const value of [
    null,
    undefined,
    {},
    { promptTokenCount: null },
    { promptTokenCount: -1 },
    { promptTokenCount: '1000' },
    ...[null, -1, '40'].map((cachedContentTokenCount) => ({
      promptTokenCount: 1000,
      cachedContentTokenCount,
    })),
  ]) {
    expect(providerCacheUsage('vertex-gemini-v1', value)).toEqual({
      readTokens: null,
      writeTokens: null,
    });
  }
});

test('Vercel uses the top-level cache write count without adding or replacing it with nested usage', () => {
  for (const [reported, expected] of [
    [12, 12],
    [0, 0],
    [null, null],
    [undefined, null],
    [-1, null],
    ['12', null],
  ]) {
    expect(
      providerCacheUsage('vercel-chat-v1', {
        cache_creation_input_tokens: reported,
        prompt_tokens_details: { cached_tokens: 9, cache_write_tokens: 7 },
      })
    ).toEqual({ readTokens: 9, writeTokens: expected });
  }
  expect(
    providerCacheUsage('vercel-chat-v1', {
      prompt_tokens_details: { cached_tokens: 9, cache_write_tokens: 7 },
    })
  ).toEqual({ readTokens: 9, writeTokens: 7 });
  expect(
    providerCacheUsage('openai-chat-v1', {
      cache_creation_input_tokens: 12,
      prompt_tokens_details: { cached_tokens: 9, cache_write_tokens: 7 },
    })
  ).toEqual({ readTokens: 9, writeTokens: 7 });
});
