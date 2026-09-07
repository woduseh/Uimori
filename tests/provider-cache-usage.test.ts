import { expect, test } from 'vitest';
import { providerCacheUsage } from '../core/provider-cache-usage.js';

test('cache usage distinguishes a confirmed read, zero, and missing data without inferring savings',()=>{
  expect(providerCacheUsage('anthropic-messages-v1',{cache_read_input_tokens:12,cache_creation_input_tokens:5,cache_creation:{ephemeral_5m_input_tokens:0,ephemeral_1h_input_tokens:5}})).toEqual({readTokens:12,writeTokens:5,write5mTokens:0,write1hTokens:5});
  expect(providerCacheUsage('openai-responses-v1',{input_tokens_details:{cached_tokens:0,cache_write_tokens:24}})).toEqual({readTokens:0,writeTokens:24});
  expect(providerCacheUsage('vertex-gemini-v1',{cachedContentTokenCount:40})).toEqual({readTokens:40,writeTokens:null});
  expect(providerCacheUsage('openai-chat-v1',{prompt_tokens_details:{cached_tokens:9}})).toEqual({readTokens:9,writeTokens:null});
  expect(providerCacheUsage('openai-responses-v1',{input_tokens_details:{cached_tokens:-1}})).toEqual({readTokens:null,writeTokens:null});
  expect(providerCacheUsage('openai-responses-v1',null)).toEqual({readTokens:null,writeTokens:null});
  expect(providerCacheUsage('fixture-sse-v1',{cachedContentTokenCount:40})).toBeUndefined();
});
