import type { ReaderRun, Source } from './types.js';

type ConversationEntry =
  | { kind: 'source'; source: Source; index: number }
  | { kind: 'pending'; run: ReaderRun };

/** Imported fork ranks are negative, so subsequent local admissions remain after preserved history. */
export function readerRequestOrder(
  rows: ReadonlyMap<
    string,
    {
      id: string;
      admissionOrder: number;
      retryOf?: string | null;
      forkRequestOrder?: number | null;
    }
  >,
  id: string
): number {
  let row = rows.get(id);
  const seen = new Set<string>();
  while (row) {
    if (Number.isSafeInteger(row.forkRequestOrder) && row.forkRequestOrder! < 0)
      return row.forkRequestOrder!;
    if (!row.retryOf || seen.has(row.id)) break;
    seen.add(row.id);
    const previous = rows.get(row.retryOf);
    if (!previous) break;
    row = previous;
  }
  return row?.admissionOrder ?? Number.MAX_SAFE_INTEGER;
}

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
