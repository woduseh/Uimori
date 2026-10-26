import type { ReaderRun, Source } from './types.js';

type ConversationEntry =
  | { kind: 'source'; source: Source; index: number }
  | { kind: 'pending'; run: ReaderRun };

/** Retries keep their first admitted request's place in the conversation. */
export function readerRequestOrder(
  rows: ReadonlyMap<
    string,
    {
      id: string;
      admissionOrder: number;
      retryOf?: string | null;
    }
  >,
  id: string,
  cache: Map<string, number> = new Map()
): number {
  const known = cache.get(id);
  if (known !== undefined) return known;
  let row = rows.get(id);
  const path: string[] = [];
  const seen = new Set<string>();
  while (row) {
    if (cache.has(row.id)) break;
    if (!row.retryOf || seen.has(row.id)) break;
    seen.add(row.id);
    path.push(row.id);
    const previous = rows.get(row.retryOf);
    if (!previous) break;
    row = previous;
  }
  const order = row ? (cache.get(row.id) ?? row.admissionOrder) : Number.MAX_SAFE_INTEGER;
  cache.set(id, order);
  for (const ancestor of path) cache.set(ancestor, order);
  return order;
}

export function canDismissReaderRun(
  run: Pick<ReaderRun, 'status' | 'sourceRevision' | 'error'>
): boolean {
  return (
    run.status === 'cancelled' && !run.sourceRevision && !run.error?.includes('PROVIDER_UNCERTAIN')
  );
}

/** Only confirmed cancellations can leave the manuscript; uncertain outcomes remain visible. */
export function isReaderPendingRun(
  run: Pick<
    ReaderRun,
    'sourceRevision' | 'supersededBy' | 'status' | 'error' | 'snapshot' | 'readerDismissed'
  >
): boolean {
  if (run.sourceRevision || run.supersededBy) return false;
  return !(canDismissReaderRun(run) && (run.snapshot.replacement || run.readerDismissed));
}

/** Preserve source pagination and numbering, inserting attempts at their original request position. */
export function readerConversation(sources: Source[], runs: ReaderRun[]): ConversationEntry[] {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const pending = runs
    .filter(isReaderPendingRun)
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
