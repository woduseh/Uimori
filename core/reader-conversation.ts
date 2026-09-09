import type { ReaderRun, Source } from './types.js';

type ConversationEntry =
  | { kind: 'source'; source: Source; index: number }
  | { kind: 'pending'; run: ReaderRun };

/** Preserve source pagination and numbering, inserting attempts at their original request position. */
export function readerConversation(sources: Source[], runs: ReaderRun[]): ConversationEntry[] {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const pending = runs
    .filter((run) => !run.sourceRevision && !run.supersededBy)
    .sort((a, b) => (a.requestOrder ?? Infinity) - (b.requestOrder ?? Infinity));
  const entries: ConversationEntry[] = [];
  let next = 0;
  sources.forEach((source, index) => {
    const order = byId.get(source.runId)?.requestOrder ?? Infinity;
    while (next < pending.length && (pending[next].requestOrder ?? Infinity) < order)
      entries.push({ kind: 'pending', run: pending[next++] });
    entries.push({ kind: 'source', source, index });
  });
  while (next < pending.length) entries.push({ kind: 'pending', run: pending[next++] });
  return entries;
}
