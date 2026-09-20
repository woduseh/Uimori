import { createHash } from 'node:crypto';
import { get_encoding, type Tiktoken } from 'tiktoken';
import { ProviderContractError } from './provider-errors.js';

let tokenizer: Tiktoken | undefined;
// Fixed-size keys avoid retaining sliced request strings. Cache counts, not token ID arrays.
const TOKEN_PIECE_CACHE_LIMIT = 512;
const tokenPieces = new Map<string, number>();

/** Local o200k text estimate, without JSON quoting or a safety margin.
 * 4,096-unit boundaries bound BPE work; this is not a model-specific usage count.
 * Keep this algorithm stable for the persisted o200k_base-text-v1 lore policy.
 */
export function countTextTokens(text: string): number {
  if (typeof text !== 'string') throw new ProviderContractError('INVALID_CONTEXT_INPUT');
  if (!text.length) return 0;
  tokenizer ??= get_encoding('o200k_base');
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
    const key = createHash('sha256').update(piece, 'utf16le').digest('hex');
    let count = tokenPieces.get(key);
    if (count === undefined) {
      // Authored special-token spellings are ordinary text, not tokenizer controls.
      count = tokenizer.encode(piece, [], []).length;
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
