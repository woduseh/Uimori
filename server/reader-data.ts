import type { Store } from './store.js';

type ReaderEvent = { kind: string; entityId: string };

/** Resolve a replay's distinct task IDs once, rather than querying each status transition. */
export function changedReaderSources(
  store: Pick<Store, 'db'>,
  chatId: string,
  events: readonly ReaderEvent[]
): Set<string> {
  const changed = new Set<string>();
  const jobs = new Set<string>();
  const illustrations = new Set<string>();
  for (const event of events) {
    if (event.kind.startsWith('source.')) changed.add(event.entityId);
    if (event.kind.startsWith('job.')) jobs.add(event.entityId);
    if (event.kind.startsWith('illustration.')) illustrations.add(event.entityId);
  }
  // Only these trusted table names enter SQL. IDs and the chat boundary are bound parameters.
  for (const [table, ids] of [
    ['jobs', jobs],
    ['illustration_jobs', illustrations],
  ] as const) {
    if (!ids.size) continue;
    const rows = store.db
      .prepare(`SELECT source_revision FROM ${table}
        WHERE chat_id=? AND id IN (SELECT value FROM json_each(?))`)
      .all(chatId, JSON.stringify([...ids])) as { source_revision: string }[];
    for (const row of rows) changed.add(row.source_revision);
  }
  return changed;
}

/** Select the visible jobs before hydrating their potentially large input/diagnostic bodies. */
export function readerJobIds(store: Pick<Store, 'db'>, sourceId: string, sourceHash: string) {
  return store.db
    .prepare(`SELECT j.id FROM jobs j
      WHERE j.source_revision=? AND (j.source_hash=? OR j.kind='image')
        AND (j.kind!='translation' OR j.id=(
          SELECT id FROM jobs WHERE source_revision=j.source_revision AND kind='translation'
          ORDER BY revision DESC,created_at DESC,id DESC LIMIT 1
        ))
      ORDER BY j.created_at,j.id`)
    .all(sourceId, sourceHash) as { id: string }[];
}
