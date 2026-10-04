import { createHash } from 'node:crypto';
import { ProviderContractError } from './provider-errors.js';
import { localTokenizer, type TokenizerInfo } from './local-tokenizers.js';
import { isTokenizerProfileId, type TokenizerProfileId } from './tokenizer-profiles.js';

// Fixed-size keys avoid retaining sliced request strings. Cache counts, not token ID arrays.
const TOKEN_PIECE_CACHE_LIMIT = 512;
const tokenPieces = new Map<string, number>();

/** Local o200k text estimate, without JSON quoting or a safety margin.
 * 4,096-unit boundaries bound BPE work; this is not a model-specific usage count.
 * Keep this algorithm stable for the persisted o200k_base-text-v1 lore policy.
 */
export function countTextTokens(text: string, profile?: TokenizerProfileId): number {
  if (typeof text !== 'string') throw new ProviderContractError('INVALID_CONTEXT_INPUT');
  if (profile !== undefined && !isTokenizerProfileId(profile))
    throw new ProviderContractError('INVALID_CONTEXT_INPUT');
  if (!text.length) return 0;
  const tokenizer = localTokenizer(profile ?? 'openai-o200k');
  let tokens = 0;
  for (let start = 0; start < text.length; ) {
    let end = Math.min(text.length, start + 4096);
    if (
      end < text.length &&
      /[\uD800-\uDBFF]/u.test(text[end - 1]) &&
      /[\uDC00-\uDFFF]/u.test(text[end])
    )
      end--;
    const piece = text.slice(start, end);
    const key = `${profile ?? 'o200k_base-text-v1'}:${tokenizer.info.effective}:${tokenizer.info.fallback}:${createHash('sha256').update(piece, 'utf16le').digest('hex')}`;
    let count = tokenPieces.get(key);
    if (count === undefined) {
      // The legacy/default OpenAI counter treats special-token spellings as ordinary text.
      // Other profiles follow their published tokenizer's literal encoding rules.
      count = tokenizer.count(piece);
    } else {
      tokenPieces.delete(key);
    }
    tokenPieces.set(key, count);
    if (tokenPieces.size > TOKEN_PIECE_CACHE_LIMIT)
      tokenPieces.delete(tokenPieces.keys().next().value!);
    tokens += count;
    start = end;
  }
  return tokens;
}

/** Metadata for the same local counter used by the request estimate, including fallback. */
export function tokenizerInfo(profile?: TokenizerProfileId): TokenizerInfo {
  return localTokenizer(profile ?? 'openai-o200k').info;
}

/** A literal prefix/suffix for reference context, including any omission marker in its budget. */
export function textTokenExcerpt(
  text: string,
  maxTokens: number,
  options: { side?: 'start' | 'end'; marker?: string } = {}
): { text: string; tokens: number; truncated: boolean } {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 0)
    throw new ProviderContractError('INVALID_CONTEXT_BUDGET');
  const tokens = countTextTokens(text);
  if (tokens <= maxTokens) return { text, tokens, truncated: false };
  let marker = options.marker ?? '';
  if (countTextTokens(marker) > maxTokens) marker = '';
  const excerpt = (length: number) => {
    let at = options.side === 'end' ? text.length - length : length;
    if (
      at > 0 &&
      at < text.length &&
      /[\uD800-\uDBFF]/u.test(text[at - 1]) &&
      /[\uDC00-\uDFFF]/u.test(text[at])
    )
      at += options.side === 'end' ? 1 : -1;
    return options.side === 'end' ? marker + text.slice(at) : text.slice(0, at) + marker;
  };
  let low = 0,
    high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (countTextTokens(excerpt(middle)) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  const result = excerpt(low);
  return { text: result, tokens: countTextTokens(result), truncated: true };
}
