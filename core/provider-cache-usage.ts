/** Only counts explicitly reported by the provider; requested cache settings never imply a hit. */
export function providerCacheUsage(
  protocol: unknown,
  value: unknown
):
  | {
      readTokens: number | null;
      writeTokens: number | null;
      write5mTokens?: number | null;
      write1hTokens?: number | null;
    }
  | undefined {
  const record = (item: unknown): Record<string, unknown> =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? (item as Record<string, unknown>)
      : {};
  const token = (item: unknown): number | null =>
    typeof item === 'number' && Number.isSafeInteger(item) && item >= 0 ? item : null;
  const raw = record(value);
  if (protocol === 'deepseek-chat-v1')
    return { readTokens: token(raw.prompt_cache_hit_tokens), writeTokens: null };
  if (protocol === 'anthropic-messages-v1') {
    const creation = record(raw.cache_creation);
    return {
      readTokens: token(raw.cache_read_input_tokens),
      writeTokens: token(raw.cache_creation_input_tokens),
      write5mTokens: token(creation.ephemeral_5m_input_tokens),
      write1hTokens: token(creation.ephemeral_1h_input_tokens),
    };
  }
  if (protocol === 'openai-responses-v1') {
    const details = record(raw.input_tokens_details);
    return {
      readTokens: token(details.cached_tokens),
      writeTokens: token(details.cache_write_tokens),
    };
  }
  if (protocol === 'openai-chat-v1' || protocol === 'vercel-chat-v1')
    return {
      readTokens: token(record(raw.prompt_tokens_details).cached_tokens),
      writeTokens: null,
    };
  if (protocol === 'vertex-gemini-v1')
    return { readTokens: token(raw.cachedContentTokenCount), writeTokens: null };
  return undefined;
}
