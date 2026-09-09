import { HttpError } from './request-validation.js';
import { latestTranslation, validateTranslationArtifact } from './source-editing.js';
import type { Store } from './store.js';
import { mergedReaderAssets } from './package-images.js';
import type { ReaderActivity } from '../core/types.js';
import { providerRejection } from '../core/provider-rejection.js';

/** The failing attempt's stored provider diagnostic, read only for 4xx failures being displayed. */
export function attemptRejection(
  store: Store,
  column: 'run_id' | 'job_id' | 'story_job_id',
  id: string
) {
  const row = store.db
    .prepare(
      `SELECT json_extract(response,'$.error.diagnostic') AS diagnostic FROM attempts WHERE ${column}=? AND json_extract(response,'$.error.diagnostic') IS NOT NULL ORDER BY rowid DESC LIMIT 1`
    )
    .get(id) as { diagnostic: string | null } | undefined;
  if (!row?.diagnostic) return undefined;
  try {
    return providerRejection(JSON.parse(row.diagnostic));
  } catch {
    return undefined;
  }
}

/** Metadata only; an explicit page scope includes its older completed work as well. */
function readerActivity(store: Store, chatId: string, sourceIds?: string[]): ReaderActivity[] {
  const selection = sourceIds
    ? 'SELECT * FROM activity WHERE sourceRevision IN (SELECT value FROM json_each(?)) ORDER BY createdAt,id'
    : "SELECT * FROM activity WHERE status IN ('queued','running','waiting_for_state') UNION ALL SELECT * FROM recent ORDER BY createdAt,id";
  const rows = store.db
    .prepare(`WITH activity AS (
    SELECT id,'main' AS kind,status,created_at AS createdAt,updated_at AS updatedAt,branch_id AS branchId,source_revision AS sourceRevision,0 AS generation FROM runs WHERE chat_id=?
    UNION ALL
    SELECT j.id,j.kind,j.status,j.created_at,j.updated_at,r.branch_id,j.source_revision,j.generation FROM jobs j JOIN sources s ON s.id=j.source_revision JOIN runs r ON r.id=s.run_id
      WHERE j.chat_id=? AND j.source_hash=COALESCE((SELECT hash FROM source_edits WHERE source_id=s.id ORDER BY revision DESC LIMIT 1),s.hash)
    UNION ALL
    SELECT j.id,j.kind,j.status,j.created_at,j.updated_at,COALESCE(json_extract(j.snapshot,'$.branchId'),r.branch_id),j.source_revision,j.generation FROM story_jobs j JOIN sources s ON s.id=j.source_revision JOIN runs r ON r.id=s.run_id
      WHERE j.chat_id=? AND j.source_hash=COALESCE((SELECT hash FROM source_edits WHERE source_id=s.id ORDER BY revision DESC LIMIT 1),s.hash)
  ), recent AS (SELECT * FROM activity WHERE status NOT IN ('queued','running','waiting_for_state') ORDER BY updatedAt DESC,id DESC LIMIT 30)
  ${selection}`)
    .all(chatId, chatId, chatId, ...(sourceIds ? [JSON.stringify(sourceIds)] : [])) as Omit<
    ReaderActivity,
    'startedAt' | 'finishedAt'
  >[];
  const eventTimes = new Map<string, string>();
  const timeline = store.db
    .prepare(`SELECT entity_id,kind,at FROM events WHERE chat_id=? AND entity_id IN (SELECT value FROM json_each(?))
    AND kind NOT IN ('run.usage','run.delta','run.running','job.running','story.job.running') ORDER BY seq`)
    .all(chatId, JSON.stringify(rows.map((row) => row.id))) as {
    entity_id: string;
    kind: string;
    at: string;
  }[];
  for (const event of timeline) eventTimes.set(`${event.entity_id}:${event.kind}`, event.at);
  return rows.map((row) => {
    const prefix =
      row.kind === 'main' ? 'run' : ['state', 'memory'].includes(row.kind) ? 'story.job' : 'job';
    const time = (status: string) => eventTimes.get(`${row.id}:${prefix}.${status}`);
    // A retry can reuse a job ID; queue time identifies that new user-visible execution.
    const startedAt = row.kind === 'main' ? row.createdAt : (time('queued') ?? row.createdAt);
    const finishedAt = ['queued', 'running', 'waiting_for_state'].includes(row.status)
      ? null
      : (time(row.status) ?? row.updatedAt);
    return { ...row, startedAt, finishedAt };
  });
}

/** Read projection only. Frozen execution records remain available through detail/run APIs. */
export function readerDetail(store: Store, id: string, query: Record<string, string | undefined>) {
  const chat = store.chat(id);
  const branch = store.product.branch(id, query.branch || undefined);
  const rows = store.db
    .prepare(
      'SELECT id,parent_revision AS parentRevision,run_id AS runId FROM sources WHERE chat_id=?'
    )
    .all(id) as { id: string; parentRevision: string | null; runId: string }[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const chain: string[] = [];
  const seen = new Set<string>();
  let head = branch.headRevision;
  while (head && !seen.has(head)) {
    seen.add(head);
    const row = byId.get(head);
    if (!row) break;
    chain.unshift(head);
    head = row.parentRevision;
  }
  const limit = 5;
  let start = query.source ? chain.indexOf(query.source) : 0;
  if (start < 0) throw new HttpError(404, 'Source is not in this branch');
  start = Math.floor(start / limit) * limit;
  const order = chain.slice(start, start + limit);
  const cursor = Number(
    (
      store.db
        .prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE chat_id=?')
        .get(id) as { seq: number }
    ).seq
  );
  const since = query.since === undefined ? null : Number(query.since);
  if (since !== null && (!Number.isSafeInteger(since) || since < 0 || since > cursor))
    throw new HttpError(400, 'Invalid reader cursor');
  const events =
    since === null ? null : (store.events(id, since) as { kind: string; entityId: string }[]);
  const changed = new Set<string>();
  for (const event of events ?? []) {
    if (event.kind.startsWith('source.')) changed.add(event.entityId);
    if (event.kind.startsWith('job.')) {
      const job = store.db
        .prepare('SELECT source_revision FROM jobs WHERE id=? AND chat_id=?')
        .get(event.entityId, id) as { source_revision: string } | undefined;
      if (job) changed.add(job.source_revision);
    }
  }
  // The caller supplies only IDs from its current page; identity is scoped again by order.
  const known = new Set((query.known ?? '').split(','));
  const sources = order
    .filter((sourceId) => !events || !known.has(sourceId) || changed.has(sourceId))
    .map((sourceId) => store.source(sourceId));
  const jobs = sources.flatMap((source) => {
    const ids = store.db
      .prepare('SELECT id FROM jobs WHERE source_revision=? ORDER BY created_at,id')
      .all(source.id) as { id: string }[];
    return ids
      .map((row) => store.job(row.id))
      .filter((job) => {
        if (job.sourceHash !== source.hash && job.kind !== 'image') return false;
        if (job.kind !== 'translation') return true;
        if (latestTranslation(store, source.id)?.id !== job.id) return false;
        if (job.status === 'completed') {
          try {
            validateTranslationArtifact(store, job, source);
          } catch {
            return false;
          }
        }
        return true;
      })
      .map(({ input: _input, ...job }) => {
        const rejection = /AUXILIARY_PROVIDER_HTTP_4\d\d$/u.test(job.error ?? '')
          ? attemptRejection(store, 'job_id', job.id)
          : undefined;
        return rejection ? { ...job, rejection } : job;
      });
  });
  // JSON projection happens in SQLite: do not parse quadratic history or diagnostic bodies.
  const runs = (
    store.db
      .prepare(`SELECT id,chat_id AS chatId,parent_revision AS parentRevision,status,request,source_revision AS sourceRevision,error,usage,partial_text AS partialText,
    json_extract(snapshot,'$.settingsRevision') AS settingsRevision,CASE WHEN json_extract(snapshot,'$.packageStart.mode')='authored' THEN NULL ELSE json_extract(snapshot,'$.profile.models.main.title') END AS modelTitle,json_extract(snapshot,'$.sourceSegments') AS sourceSegments,COALESCE(json_array_length(snapshot,'$.profile.packageAttachments'),0)>0 AS hasPackages,
    CASE WHEN json_type(snapshot,'$.packageStart') IS NOT NULL THEN json_object('mode',json_extract(snapshot,'$.packageStart.mode'),'title',json_extract(snapshot,'$.packageStart.title')) END AS packageStart,
    CASE WHEN json_type(snapshot,'$.contextPlan')='object' THEN json_object('status',json_extract(snapshot,'$.contextPlan.status'),'inputTokenLimit',json_extract(snapshot,'$.contextPlan.budget.inputTokenLimit'),'estimatedInputTokens',json_extract(snapshot,'$.contextPlan.estimatedInputTokens'),'compactedSources',json_array_length(snapshot,'$.contextPlan.compacted'),'summaryCalls',json_extract(snapshot,'$.contextPlan.summaryCalls'),'error',json_extract(snapshot,'$.contextPlan.error')) END AS contextSummary,
    json_object('loreContextReset',json_extract(snapshot,'$.loreContextReset'),'branchId',branch_id,'candidateOf',json_extract(snapshot,'$.candidateOf'),'forkedFrom',json_extract(snapshot,'$.forkedFrom')) AS snapshot
    FROM runs WHERE chat_id=? ORDER BY created_at,id`)
      .all(id) as (Record<string, any> & { id: string; request: string })[]
  ).map((row) => ({
    ...row,
    snapshot: {
      ...JSON.parse(row.snapshot),
      loreContextReset: !!JSON.parse(row.snapshot).loreContextReset,
    },
    contextSummary: row.contextSummary ? JSON.parse(row.contextSummary) : undefined,
    packageStart: row.packageStart ? JSON.parse(row.packageStart) : undefined,
    sourceSegments: row.sourceSegments ? JSON.parse(row.sourceSegments) : undefined,
    usage: row.usage
      ? JSON.parse(row.usage)
      : { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    ...(/^HTTP_4\d\d$/u.test(String(row.error ?? ''))
      ? { rejection: attemptRejection(store, 'run_id', row.id) }
      : {}),
  }));
  const runsById = new Map(runs.map((run) => [run.id, run]));
  // Requests label the branch's complete index without loading off-page source bodies.
  // Authored starts have no user request; never substitute generated or hidden content.
  const navigation = chain.map((sourceId, index) => {
    const run = runsById.get(byId.get(sourceId)!.runId);
    const request = String(run?.request ?? '')
      .replace(/\s+/gu, ' ')
      .trim();
    const characters = Array.from(request);
    const label =
      run?.packageStart?.mode === 'authored'
        ? '시작 장면'
        : characters.length > 100
          ? `${characters.slice(0, 99).join('')}…`
          : request || `장면 ${index + 1}`;
    return { id: sourceId, number: index + 1, label };
  });
  const activeJobs = Number(
    (
      store.db
        .prepare(
          `SELECT COUNT(*) AS count FROM jobs j JOIN sources s ON s.id=j.source_revision WHERE j.chat_id=? AND j.status IN ('queued','running') AND j.source_hash=COALESCE((SELECT hash FROM source_edits WHERE source_id=s.id ORDER BY revision DESC LIMIT 1),s.hash)`
        )
        .get(id) as { count: number }
    ).count
  );
  const assetsChanged =
    !events ||
    events.some(
      (event) =>
        event.kind.startsWith('asset.') ||
        event.kind.startsWith('job.') ||
        event.kind.startsWith('source.')
    );
  return {
    chat,
    runs,
    sources,
    jobs,
    profile: store.product.profile(id),
    branches: store.product.branches(id),
    ...(assetsChanged ? { assets: mergedReaderAssets(store, id, order) } : {}),
    reader: {
      navigation,
      activity: readerActivity(store, id),
      responseActivity: readerActivity(store, id, order),
      headSourceHash: branch.headRevision
        ? ((
            store.db
              .prepare(
                'SELECT COALESCE((SELECT hash FROM source_edits WHERE source_id=s.id ORDER BY revision DESC LIMIT 1),s.hash) AS hash FROM sources s WHERE s.id=?'
              )
              .get(branch.headRevision) as { hash: string } | undefined
          )?.hash ?? null)
        : null,
      activeJobs,
      cursor,
      order,
      start,
      total: chain.length,
      previous: start > 0 ? chain[Math.max(0, start - limit)] : null,
      next: chain[start + limit] ?? null,
      latest: chain[Math.max(0, Math.floor((chain.length - 1) / limit) * limit)] ?? null,
      projection: true as const,
    },
  };
}
