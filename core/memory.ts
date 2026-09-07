import { createHash } from 'node:crypto';
import {
  parseSourceSegments,
  type SegmentRange,
  type SourceSegmentPolicy,
} from './source-segments.js';

export type MemoryHistoryItem = {
  revision: string;
  text: string;
  contentHash?: string;
  sourceSegments?: SourceSegmentPolicy;
};
/** The host supplies the exact ordered source ancestry, ending at the request's source time. */
export type MemoryScope = { chatId: string; history: readonly MemoryHistoryItem[] };
export type MemorySourceRef = {
  revision: string;
  hash: string;
  start: number;
  end: number;
  quote: string;
};
export type MemoryKnowledge = {
  readerVisible: true;
  worldStatus: 'unspecified';
  knownByActorIds: null;
  segments: {
    sourceRevision: string;
    sourceHash: string;
    segmentId: string;
    kind: 'aside' | 'annotation';
    range: SegmentRange;
  }[];
};
type MemoryBase = {
  id: string;
  chatId: string;
  atRevision: string | null;
  atHash: string | null;
  text: string;
  knowledge?: MemoryKnowledge;
};
export type MemoryEntry = MemoryBase &
  (
    | { kind: 'author-canon'; declaration: { author: string; text: string } }
    | { kind: 'observed-story' | 'derived-summary' | 'preference'; sources: MemorySourceRef[] }
    | { kind: 'character-belief' | 'hypothesis'; actor: string; sources: MemorySourceRef[] }
  );
export type MemoryCheckpoint = { chatId: string; indexed: { revision: string; hash: string }[] };
export const memoryHash = (text: string): string => createHash('sha256').update(text).digest('hex');
const fail = (code: string): never => {
  throw new Error(`MEMORY_${code}`);
};
function object(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return fail('INVALID_OBJECT');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail('UNKNOWN_FIELD');
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function history(scope: MemoryScope) {
  if (!text(scope.chatId) || !Array.isArray(scope.history)) return fail('INVALID_SCOPE');
  const seen = new Set<string>();
  return scope.history.map((item) => {
    if (!text(item.revision) || typeof item.text !== 'string' || seen.has(item.revision))
      return fail('INVALID_HISTORY');
    seen.add(item.revision);
    const contentHash = memoryHash(item.text);
    if (item.contentHash !== undefined && item.contentHash !== contentHash)
      fail('SOURCE_HASH_MISMATCH');
    return {
      revision: item.revision,
      text: item.text,
      contentHash,
      ...(item.sourceSegments ? { sourceSegments: item.sourceSegments } : {}),
    };
  });
}

export function validateMemoryEntry(value: unknown, scope: MemoryScope): MemoryEntry {
  const entry = object(value);
  const items = history(scope);
  const canon = entry.kind === 'author-canon';
  const belief = entry.kind === 'character-belief' || entry.kind === 'hypothesis';
  if (
    ![
      'author-canon',
      'observed-story',
      'derived-summary',
      'preference',
      'character-belief',
      'hypothesis',
    ].includes(String(entry.kind))
  )
    fail('INVALID_KIND');
  keys(entry, [
    'id',
    'chatId',
    'atRevision',
    'atHash',
    'text',
    'kind',
    'knowledge',
    ...(canon ? ['declaration'] : belief ? ['actor', 'sources'] : ['sources']),
  ]);
  if (!text(entry.id) || !text(entry.text) || entry.chatId !== scope.chatId) fail('INVALID_ENTRY');
  const anchor = items.findIndex(
    (item) => item.revision === entry.atRevision && item.contentHash === entry.atHash
  );
  if (anchor < 0 && !(canon && entry.atRevision === null && entry.atHash === null))
    fail('OUT_OF_SCOPE');
  if (canon) {
    const declaration = object(entry.declaration);
    keys(declaration, ['author', 'text']);
    if (!text(declaration.author) || !text(declaration.text) || declaration.text !== entry.text)
      fail('INVALID_DECLARATION');
  } else {
    if (belief && !text(entry.actor)) fail('ACTOR_REQUIRED');
    if (!Array.isArray(entry.sources) || !entry.sources.length) fail('SOURCE_REQUIRED');
    for (const raw of entry.sources as unknown[]) {
      const ref = object(raw);
      keys(ref, ['revision', 'hash', 'start', 'end', 'quote']);
      const index = items.findIndex(
        (item) => item.revision === ref.revision && item.contentHash === ref.hash
      );
      if (index < 0 || index > anchor) fail('OUT_OF_SCOPE');
      if (
        !integer(ref.start) ||
        !integer(ref.end) ||
        ref.end <= ref.start ||
        ref.end > items[index].text.length ||
        typeof ref.quote !== 'string' ||
        items[index].text.slice(ref.start, ref.end) !== ref.quote
      )
        fail('INVALID_SOURCE_RANGE');
    }
  }
  const segments: MemoryKnowledge['segments'] = [];
  if (!canon)
    for (const raw of entry.sources as MemorySourceRef[]) {
      const source = items.find((item) => item.revision === raw.revision)!;
      if (!source.sourceSegments) continue;
      const parsed = parseSourceSegments(
        { sourceRevision: source.revision, sourceHash: source.contentHash, text: source.text },
        source.sourceSegments
      );
      if (parsed.diagnostics.some((d) => d.severity === 'error'))
        fail('SEGMENT_EVIDENCE_UNCERTAIN');
      for (const segment of parsed.segments)
        if (
          segment.kind !== 'main' &&
          segment.range.start < raw.end &&
          raw.start < segment.range.end &&
          !segments.some((s) => s.sourceRevision === source.revision && s.segmentId === segment.id)
        )
          segments.push({
            sourceRevision: source.revision,
            sourceHash: source.contentHash,
            segmentId: segment.id,
            kind: segment.kind,
            range: { ...segment.range },
          });
    }
  const knowledge: MemoryKnowledge | undefined = segments.length
    ? { readerVisible: true, worldStatus: 'unspecified', knownByActorIds: null, segments }
    : undefined;
  if (entry.knowledge !== undefined) {
    // Canonical field order makes equality independent of the caller's JSON key order.
    const supplied = object(entry.knowledge);
    keys(supplied, ['readerVisible', 'worldStatus', 'knownByActorIds', 'segments']);
    if (
      !knowledge ||
      supplied.readerVisible !== true ||
      supplied.worldStatus !== 'unspecified' ||
      supplied.knownByActorIds !== null ||
      !Array.isArray(supplied.segments) ||
      supplied.segments.length !== segments.length
    )
      fail('SEGMENT_KNOWLEDGE_MISMATCH');
    for (const [index, raw] of (supplied.segments as unknown[]).entries()) {
      const s = object(raw);
      keys(s, ['sourceRevision', 'sourceHash', 'segmentId', 'kind', 'range']);
      const range = object(s.range);
      keys(range, ['start', 'end']);
      const expected = segments[index];
      if (
        s.sourceRevision !== expected.sourceRevision ||
        s.sourceHash !== expected.sourceHash ||
        s.segmentId !== expected.segmentId ||
        s.kind !== expected.kind ||
        range.start !== expected.range.start ||
        range.end !== expected.range.end
      )
        fail('SEGMENT_KNOWLEDGE_MISMATCH');
    }
  }
  return { ...structuredClone(value as MemoryEntry), ...(knowledge ? { knowledge } : {}) };
}

export function visibleMemoryEntries(
  scope: MemoryScope,
  entries: readonly MemoryEntry[]
): MemoryEntry[] {
  history(scope); // Scope errors must never become an apparently empty successful result.
  return entries.flatMap((entry) => {
    try {
      return [validateMemoryEntry(entry, scope)];
    } catch {
      return [];
    }
  });
}

export function validateMemoryCheckpoint(value: unknown): MemoryCheckpoint {
  const checkpoint = object(value);
  keys(checkpoint, ['chatId', 'indexed']);
  if (!text(checkpoint.chatId) || !Array.isArray(checkpoint.indexed)) fail('INVALID_CHECKPOINT');
  const seen = new Set<string>();
  for (const raw of checkpoint.indexed as unknown[]) {
    const ref = object(raw);
    keys(ref, ['revision', 'hash']);
    if (
      !text(ref.revision) ||
      typeof ref.hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(ref.hash) ||
      seen.has(ref.revision)
    )
      fail('INVALID_CHECKPOINT');
    seen.add(ref.revision as string);
  }
  return structuredClone(value) as MemoryCheckpoint;
}

export function resolveMemoryCheckpoint(scope: MemoryScope, checkpoint?: MemoryCheckpoint | null) {
  const items = history(scope);
  const checked = checkpoint
    ? validateMemoryCheckpoint(checkpoint)
    : { chatId: scope.chatId, indexed: [] };
  const refs = new Map(
    checked.chatId === scope.chatId ? checked.indexed.map((item) => [item.revision, item.hash]) : []
  );
  let indexedCount = 0;
  while (
    indexedCount < items.length &&
    refs.get(items[indexedCount].revision) === items[indexedCount].contentHash
  )
    indexedCount++;
  return {
    watermark: indexedCount ? items[indexedCount - 1].revision : null,
    indexedCount,
    totalSources: items.length,
  };
}

export function markMemoryIndexed(
  scope: MemoryScope,
  checkpoint: MemoryCheckpoint | null | undefined,
  revision: string
): MemoryCheckpoint {
  const items = history(scope);
  const source = items.find((item) => item.revision === revision);
  if (!source) return fail('OUT_OF_SCOPE');
  const checked = checkpoint
    ? validateMemoryCheckpoint(checkpoint)
    : { chatId: scope.chatId, indexed: [] };
  if (checked.chatId !== scope.chatId) fail('OUT_OF_SCOPE');
  // Keep other branches' receipts: visibility and contiguous progress are resolved against the current scope.
  return {
    chatId: scope.chatId,
    indexed: [
      ...checked.indexed.filter((item) => item.revision !== revision),
      { revision, hash: source.contentHash },
    ],
  };
}

function bound(value: number | undefined, fallback: number, max: number) {
  const resolved = value ?? fallback;
  if (!integer(resolved) || resolved < 1 || resolved > max) return fail('INVALID_LIMIT');
  return resolved;
}

export function planMemoryContext(input: {
  scope: MemoryScope;
  entries: readonly MemoryEntry[];
  checkpoint?: MemoryCheckpoint | null;
  recentCount?: number;
  maxPacketChars?: number;
}) {
  const items = history(input.scope);
  const checkpoint = resolveMemoryCheckpoint(input.scope, input.checkpoint);
  const recentCount = bound(input.recentCount, 2, 1000);
  const maxPacketChars = bound(input.maxPacketChars, 24000, 2000000);
  const start = Math.min(checkpoint.indexedCount, Math.max(0, items.length - recentCount));
  const recentHistory = items.slice(start);
  const visible = visibleMemoryEntries(input.scope, input.entries);
  const packet = {
    watermark: checkpoint.watermark,
    recentHistory,
    memories: visible.filter((entry) => entry.kind === 'author-canon') as MemoryEntry[],
  };
  // Authored declarations and required source tail are mandatory. The caller must inspect ready before sending.
  let omittedMemories = 0;
  for (const entry of [...visible].reverse().filter((entry) => entry.kind !== 'author-canon')) {
    const trial = { ...packet, memories: [entry, ...packet.memories] };
    if (JSON.stringify(trial).length <= maxPacketChars) packet.memories.unshift(entry);
    else omittedMemories++;
  }
  const packetChars = JSON.stringify(packet).length;
  const ready = packetChars <= maxPacketChars;
  return {
    ...packet,
    indexedCount: checkpoint.indexedCount,
    totalSources: items.length,
    unprocessedCount: items.length - checkpoint.indexedCount,
    visibleMemoryCount: visible.length,
    omittedMemories,
    packetChars,
    maxPacketChars,
    ready,
    diagnostics: [
      ...(!ready ? ['MANDATORY_CONTEXT_EXCEEDS_CONTEXT_BUDGET'] : []),
      ...(JSON.stringify({ ...packet, memories: [] }).length > maxPacketChars
        ? ['UNPROCESSED_TAIL_EXCEEDS_CONTEXT_BUDGET']
        : []),
      ...(omittedMemories ? ['MEMORIES_OMITTED_USE_SCOPED_SEARCH'] : []),
    ],
  };
}
export type MemoryContextPlan = ReturnType<typeof planMemoryContext>;

export function readMemorySource(
  scope: MemoryScope,
  request: { revision: string; offset?: number; limit?: number }
) {
  const source = history(scope).find((item) => item.revision === request.revision);
  if (!source) return fail('OUT_OF_SCOPE');
  const start = request.offset ?? 0;
  const limit = bound(request.limit, 4000, 16000);
  if (!integer(start) || start > source.text.length) fail('INVALID_OFFSET');
  const end = Math.min(source.text.length, start + limit);
  const quote = source.text.slice(start, end);
  return {
    text: quote,
    source: { revision: source.revision, hash: source.contentHash, start, end, quote },
    totalChars: source.text.length,
    truncated: end < source.text.length,
    nextOffset: end < source.text.length ? end : null,
  };
}

export function searchMemorySources(
  scope: MemoryScope,
  request: { query: string; offset?: number; limit?: number; excerptChars?: number }
) {
  if (!text(request.query)) return fail('QUERY_REQUIRED');
  const offset = request.offset ?? 0;
  const limit = bound(request.limit, 10, 100);
  const excerptChars = bound(request.excerptChars, 240, 4000);
  if (!integer(offset)) fail('INVALID_OFFSET');
  const matches = history(scope).filter((item) => item.text.includes(request.query));
  const results = matches.slice(offset, offset + limit).map((item) => {
    const matchStart = item.text.indexOf(request.query);
    const start = Math.max(0, matchStart - Math.floor(excerptChars / 4));
    const end = Math.min(item.text.length, start + excerptChars);
    const quote = item.text.slice(start, end);
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

export function searchMemoryEntries(
  scope: MemoryScope,
  entries: readonly MemoryEntry[],
  query: string,
  offset = 0,
  limit = 10
) {
  if (typeof query !== 'string' || !integer(offset)) fail('INVALID_QUERY');
  bound(limit, 10, 100);
  const matches = visibleMemoryEntries(scope, entries).filter((entry) =>
    entry.text.includes(query)
  );
  const results = matches.slice(offset, offset + limit);
  return {
    results,
    total: matches.length,
    nextOffset: offset + results.length < matches.length ? offset + results.length : null,
  };
}
