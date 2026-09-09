import { createHash } from 'node:crypto';
import type { SourceSegmentPolicy } from './source-segments.js';

export type SourceHistoryItem = {
  revision: string;
  text: string;
  contentHash?: string;
  sourceSegments?: SourceSegmentPolicy;
};
/** Exact ordered original-source ancestry, supplied by the host. */
export type SourceScope = { chatId: string; history: readonly SourceHistoryItem[] };
export type SourceEvidence = {
  revision: string;
  hash: string;
  start: number;
  end: number;
  quote: string;
};
export const sourceHash = (text: string): string => createHash('sha256').update(text).digest('hex');
const fail = (code: string): never => {
  throw new Error(`STORY_${code}`);
};
export function validateSourceHistory(scope: SourceScope) {
  if (!scope.chatId?.trim() || !Array.isArray(scope.history)) return fail('INVALID_SCOPE');
  const seen = new Set<string>();
  return scope.history.map((item) => {
    if (!item.revision?.trim() || typeof item.text !== 'string' || seen.has(item.revision))
      return fail('INVALID_HISTORY');
    seen.add(item.revision);
    const contentHash = sourceHash(item.text);
    if (item.contentHash !== undefined && item.contentHash !== contentHash)
      fail('SOURCE_HASH_MISMATCH');
    return { ...item, contentHash };
  });
}
const limitValue = (value: number | undefined, fallback: number, max: number) => {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1 || n > max) return fail('INVALID_LIMIT');
  return n;
};
export function readStorySource(
  scope: SourceScope,
  request: { revision: string; offset?: number; limit?: number }
) {
  const source = validateSourceHistory(scope).find((item) => item.revision === request.revision);
  if (!source) return fail('OUT_OF_SCOPE');
  const start = request.offset ?? 0,
    limit = limitValue(request.limit, 4000, 16000);
  if (!Number.isSafeInteger(start) || start < 0 || start > source.text.length)
    fail('INVALID_OFFSET');
  const end = Math.min(source.text.length, start + limit),
    quote = source.text.slice(start, end);
  return {
    text: quote,
    source: { revision: source.revision, hash: source.contentHash, start, end, quote },
    totalChars: source.text.length,
    truncated: end < source.text.length,
    nextOffset: end < source.text.length ? end : null,
  };
}
export function searchStorySources(
  scope: SourceScope,
  request: { query: string; offset?: number; limit?: number; excerptChars?: number }
) {
  if (!request.query?.trim()) return fail('QUERY_REQUIRED');
  const offset = request.offset ?? 0,
    limit = limitValue(request.limit, 10, 100),
    excerptChars = limitValue(request.excerptChars, 240, 4000);
  if (!Number.isSafeInteger(offset) || offset < 0) fail('INVALID_OFFSET');
  const matches = validateSourceHistory(scope).filter((item) => item.text.includes(request.query));
  const results = matches.slice(offset, offset + limit).map((item) => {
    const start = Math.max(0, item.text.indexOf(request.query) - Math.floor(excerptChars / 4)),
      end = Math.min(item.text.length, start + excerptChars),
      quote = item.text.slice(start, end);
    return {
      revision: item.revision,
      text: quote,
      source: { revision: item.revision, hash: item.contentHash, start, end, quote },
      truncated: start > 0 || end < item.text.length,
      nextOffset: end < item.text.length ? end : null,
    };
  });
  return {
    results,
    total: matches.length,
    nextOffset: offset + results.length < matches.length ? offset + results.length : null,
  };
}
