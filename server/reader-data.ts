import type { Store } from './store.js';
import { latestPromptWorkspaceUpdate } from './prompt-workspace-events.js';

type ReaderEvent = { kind: string; entityId: string };

export function changedReaderSources(
  store: Pick<Store, 'db'>,
  chatId: string,
  events: readonly ReaderEvent[]
): Set<string> {
  const changed = new Set<string>();
  const jobs = new Set<string>();
  const illustrations = new Set<string>();
  for (const event of events) {
    if (event.kind === 'illustration-layout.updated') changed.add(event.entityId);
    if (event.kind.startsWith('source.')) changed.add(event.entityId);
    if (event.kind.startsWith('job.')) jobs.add(event.entityId);
    if (event.kind.startsWith('illustration.')) illustrations.add(event.entityId);
  }
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

export function readerJobIds(store: Pick<Store, 'db'>, sourceId: string, sourceHash: string) {
  return store.db
    .prepare(`SELECT j.id FROM jobs j
      WHERE j.source_revision=? AND j.kind!='status' AND (j.source_hash=? OR j.kind='image')
        AND (j.kind!='translation' OR j.id=(
          SELECT id FROM jobs WHERE source_revision=j.source_revision AND kind='translation'
          ORDER BY revision DESC,created_at DESC,id DESC LIMIT 1
        ))
      ORDER BY j.created_at,j.id`)
    .all(sourceId, sourceHash) as { id: string }[];
}

export function readerPresentationRevisions(
  store: Pick<Store, 'db' | 'product'>,
  chatId: string,
  sourceIds: string[]
): Record<string, string> {
  const ids = JSON.stringify(sourceIds);
  const shared = store.db
    .prepare(`SELECT MAX(revision) AS revision FROM (
      SELECT COALESCE(MAX(seq),0) AS revision FROM events WHERE chat_id=? AND kind GLOB 'asset.*'
      UNION ALL SELECT COALESCE(MAX(seq),0) FROM events WHERE chat_id=? AND kind IN ('profile.updated','prompt-workspace.updated','chat.variables.changed','source.deleted')
      UNION ALL SELECT ?
    )`)
    .get(chatId, chatId, latestPromptWorkspaceUpdate(store.db)?.seq ?? 0) as { revision: number };
  const head = headDependent(store, chatId, ids)
    ? (
        store.db
          .prepare(
            "SELECT COALESCE(MAX(seq),0) AS revision FROM events WHERE chat_id=? AND kind GLOB 'source.*'"
          )
          .get(chatId) as { revision: number }
      ).revision
    : 0;
  const own = store.db
    .prepare(`SELECT entity_id AS sourceId,MAX(seq) AS revision FROM events
      WHERE chat_id=? AND kind GLOB 'source.*' AND entity_id IN (SELECT value FROM json_each(?))
      GROUP BY entity_id`)
    .all(chatId, ids) as { sourceId: string; revision: number }[];
  const images = store.db
    .prepare(`SELECT j.source_revision AS sourceId,MAX(e.seq) AS revision
    FROM events e JOIN jobs j ON j.id=e.entity_id
    WHERE e.chat_id=? AND j.kind='image' AND j.source_revision IN (SELECT value FROM json_each(?))
      AND e.kind IN ('job.completed','job.partial','job.stale','job.cancelled','job.failed')
    GROUP BY j.source_revision`)
    .all(chatId, ids) as { sourceId: string; revision: number }[];
  const ownBySource = new Map(own.map((row) => [row.sourceId, row.revision]));
  const imageBySource = new Map(images.map((row) => [row.sourceId, row.revision]));
  return Object.fromEntries(
    sourceIds.map((id) => [
      id,
      `${shared.revision}:${head}:${ownBySource.get(id) ?? 0}:${imageBySource.get(id) ?? 0}`,
    ])
  );
}

function headDependent(store: Pick<Store, 'db' | 'product'>, chatId: string, ids: string) {
  if (
    store.db
      .prepare(`SELECT 1 FROM sources s JOIN runs r ON r.id=s.run_id
        WHERE s.id IN (SELECT value FROM json_each(?)) AND instr(r.snapshot,'"nativeRisu')>0 LIMIT 1`)
      .get(ids)
  )
    return true;
  try {
    const profile = store.product.snapshot(chatId, 'inspect');
    return (
      !!profile.packages?.some((pkg) => pkg.nativeRisu) ||
      Object.values(profile.promptPresets ?? {}).some((preset) => preset?.program.nativeRisuPreset)
    );
  } catch {
    return true;
  }
}
