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
/** A display locator in one frozen ancestry, never a replacement for source identity. */
export type SourceSceneAnchor = { sceneNumber: number; revision: string; hash: string };
export function sourceSceneScope(scope: SourceScope) {
  const head = scope.history.at(-1);
  return {
    chatId: scope.chatId,
    headRevision: head?.revision ?? null,
    headHash: head ? (head.contentHash ?? sourceHash(head.text)) : null,
    numbering: 'source-ancestry-1-based' as const,
  };
}
/** Includes authored starts; compaction, result pagination and hidden spans never renumber sources. */
export function sourceSceneAnchors(scope: SourceScope): SourceSceneAnchor[] {
  return scope.history.map((source, index) => ({
    sceneNumber: index + 1,
    revision: source.revision,
    hash: source.contentHash ?? sourceHash(source.text),
  }));
}
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
const fold = (text: string) => text.normalize('NFKC').toLocaleLowerCase('en');
/** Whitespace-separated terms, matched case-insensitively; every term must occur in the span. */
export function searchTerms(query: string): string[] {
  return fold(query).split(/\s+/u).filter(Boolean);
}
/** UTF-16 offset of the first term's first occurrence when all terms occur, otherwise -1.
 * Folding keeps offsets aligned for the common case; only exact-length folds are trusted for excerpts. */
export function matchSourceSpan(text: string, terms: readonly string[]): number {
  if (!terms.length) return -1;
  const folded = fold(text);
  if (!terms.every((term) => folded.includes(term))) return -1;
  const index = folded.indexOf(terms[0]);
  return folded.length === text.length ? index : Math.max(0, text.indexOf(terms[0]));
}
export function searchStorySources(
  scope: SourceScope,
  request: { query: string; offset?: number; limit?: number; excerptChars?: number }
) {
  if (!request.query?.trim()) return fail('QUERY_REQUIRED');
  const offset = request.offset ?? 0,
    limit = limitValue(request.limit, 10, 100),
    excerptChars = limitValue(request.excerptChars, 240, 4000),
    terms = searchTerms(request.query);
  if (!Number.isSafeInteger(offset) || offset < 0) fail('INVALID_OFFSET');
  const matches = validateSourceHistory(scope).flatMap((item) => {
    const index = matchSourceSpan(item.text, terms);
    return index < 0 ? [] : [{ item, index }];
  });
  const results = matches.slice(offset, offset + limit).map(({ item, index }) => {
    const start = Math.max(0, index - Math.floor(excerptChars / 4)),
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
