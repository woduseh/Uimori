import { memoryHash, type MemoryEntry, type MemoryContextPlan } from './memory.js';
import {
  filterSourceSegments,
  parseSourceSegments,
  SourceSegmentError,
  type SegmentRange,
  type SegmentRequestView,
} from './source-segments.js';
import type { RunSnapshot } from './types.js';
import type { PromptHistoryMessage } from './prompt-program.js';

type Scope = Pick<RunSnapshot, 'history' | 'sourceSegments'>;
const overlaps = (a: SegmentRange, b: SegmentRange) => a.start < b.end && b.start < a.end;
export function sourceRequestView(snapshot: Scope, revision: string): SegmentRequestView {
  const index = snapshot.history.findIndex((item) => item.revision === revision),
    item = snapshot.history[index];
  if (!item) throw new SourceSegmentError('SEGMENT_SOURCE_UNAVAILABLE');
  const sourceHash = memoryHash(item.text);
  if (item.contentHash !== undefined && item.contentHash !== sourceHash)
    throw new SourceSegmentError('SEGMENT_SOURCE_HASH_MISMATCH');
  const source = { sourceRevision: revision, sourceHash, text: item.text };
  if (!snapshot.sourceSegments)
    return {
      ...source,
      ok: true,
      keptRanges: [{ start: 0, end: item.text.length }],
      excluded: [],
      diagnostics: [],
    };
  const view = filterSourceSegments(source, snapshot.sourceSegments, {
    messageIndex: index * 2 + 1,
    lastMessageIndex: snapshot.history.length * 2,
  });
  if (!view.ok) throw new SourceSegmentError('SEGMENT_REQUEST_PARSE_UNCERTAIN');
  return view;
}
/** Result text is a request view, never a replacement source. Hash and ranges identify the untouched source. */
export function sourceHistoryForRequest(snapshot: Scope) {
  return snapshot.history.map((item) => {
    const view = sourceRequestView(snapshot, item.revision);
    return {
      ...item,
      text: view.text,
      contentHash: view.sourceHash,
      requestRanges: view.keptRanges,
      excludedRanges: view.excluded,
    };
  });
}
export function sourceLogicalHistoryForRequest(
  snapshot: Scope,
  history: PromptHistoryMessage[]
): PromptHistoryMessage[] {
  if (!snapshot.sourceSegments) return structuredClone(history);
  return history.map((message) => {
    if (message.current || message.role !== 'assistant' || !message.sourceRevision)
      return { ...message };
    const view = sourceRequestView(snapshot, message.sourceRevision);
    if (message.sourceHash && message.sourceHash !== view.sourceHash)
      throw new SourceSegmentError('SEGMENT_SOURCE_HASH_MISMATCH');
    return { ...message, text: view.text, sourceHash: view.sourceHash };
  });
}
export function sourceMemoryEntryAllowed(snapshot: Scope, entry: MemoryEntry): boolean {
  if (entry.kind === 'author-canon' || !snapshot.sourceSegments) return true;
  try {
    return entry.sources.every((ref) => {
      const item = snapshot.history.find((item) => item.revision === ref.revision),
        view = sourceRequestView(snapshot, ref.revision);
      if (
        !item ||
        view.sourceHash !== ref.hash ||
        view.excluded.some((excluded) => overlaps(excluded.range, ref))
      )
        return false;
      const document = parseSourceSegments(
        { sourceRevision: ref.revision, sourceHash: view.sourceHash, text: item.text },
        snapshot.sourceSegments
      );
      if (document.diagnostics.some((d) => d.severity === 'error')) return false;
      // validateMemoryEntry supplies host-derived unknown knowledge; the existing kind is retained.
      return true;
    });
  } catch {
    return false;
  }
}
export function sourceMemoryPlanForRequest(
  snapshot: Scope,
  plan: MemoryContextPlan
): MemoryContextPlan {
  if (!snapshot.sourceSegments) return structuredClone(plan);
  const allowed = plan.memories.filter((entry) => sourceMemoryEntryAllowed(snapshot, entry));
  const recentIds = new Set(plan.recentHistory.map((item) => item.revision));
  const recentHistory = sourceHistoryForRequest(snapshot).filter((item) =>
    recentIds.has(item.revision)
  );
  const packetChars = JSON.stringify({
    watermark: plan.watermark,
    recentHistory,
    memories: allowed,
  }).length;
  return {
    ...structuredClone(plan),
    memories: allowed,
    recentHistory,
    packetChars,
    ready: packetChars <= plan.maxPacketChars,
    diagnostics: [...plan.diagnostics, 'SEGMENT_REQUEST_RANGES_APPLIED'],
  };
}
export function sourceReadRange(snapshot: Scope, revision: string, start: number, end: number) {
  const view = sourceRequestView(snapshot, revision),
    item = snapshot.history.find((item) => item.revision === revision)!;
  const ranges = view.keptRanges
    .map((range) => ({ start: Math.max(start, range.start), end: Math.min(end, range.end) }))
    .filter((range) => range.start < range.end);
  return {
    text: ranges.map((range) => item.text.slice(range.start, range.end)).join(''),
    ranges,
    sourceHash: view.sourceHash,
    excluded: view.excluded.filter((item) => overlaps(item.range, { start, end })),
  };
}
