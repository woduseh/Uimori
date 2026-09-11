import { HttpError } from './request-validation.js';
import { latestTranslation, validateTranslationArtifact } from './source-editing.js';
import type { Store } from './store.js';
import { mergedReaderAssets } from './package-images.js';
import { illustrationsForSources } from './illustrations.js';
import type { BranchTreeNode, ReaderActivity } from '../core/types.js';
import type { Branch } from '../core/product.js';
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
function readerActivity(
  store: Store,
  chatId: string,
  sourceIds?: string[],
  page?: { before: [string, string] | null; limit: number }
): ReaderActivity[] {
  const selection = page
    ? `SELECT * FROM activity ${page.before ? 'WHERE (updatedAt,id) < (?,?)' : ''} ORDER BY updatedAt DESC,id DESC LIMIT ?`
    : sourceIds
      ? 'SELECT * FROM activity WHERE sourceRevision IN (SELECT value FROM json_each(?)) ORDER BY createdAt,id'
      : "SELECT * FROM activity WHERE status IN ('queued','running','waiting_for_state') UNION ALL SELECT * FROM recent ORDER BY createdAt,id";
  const rows = store.db
    .prepare(`WITH activity AS (
    SELECT id,'main' AS kind,status,created_at AS createdAt,updated_at AS updatedAt,branch_id AS branchId,source_revision AS sourceRevision,0 AS generation,NULL AS sourceHash,CASE WHEN source_revision IS NULL THEN EXISTS(SELECT 1 FROM runs newer WHERE newer.chat_id=runs.chat_id AND json_extract(newer.command,'$.retryOf')=runs.id) ELSE 0 END AS superseded,(status='interrupted' OR COALESCE(error,'') LIKE '%PROVIDER_UNCERTAIN%') AS executionUncertain FROM runs WHERE chat_id=?
    UNION ALL
    SELECT j.id,j.kind,j.status,j.created_at,j.updated_at,r.branch_id,j.source_revision,j.generation,j.source_hash,CASE WHEN j.kind='translation' AND j.status IN ('failed','partial','stale') AND COALESCE(j.error,'') NOT LIKE '%PROVIDER_UNCERTAIN%' THEN EXISTS(SELECT 1 FROM jobs newer WHERE newer.chat_id=j.chat_id AND newer.source_revision=j.source_revision AND newer.source_hash=j.source_hash AND newer.kind='translation' AND newer.status='completed' AND (newer.revision,newer.created_at,newer.id) > (j.revision,j.created_at,j.id)) ELSE 0 END,(j.status='interrupted' OR COALESCE(j.error,'') LIKE '%PROVIDER_UNCERTAIN%') FROM jobs j JOIN sources s ON s.id=j.source_revision JOIN runs r ON r.id=s.run_id
      WHERE j.chat_id=? AND j.source_hash=COALESCE((SELECT hash FROM source_edits WHERE source_id=s.id ORDER BY revision DESC LIMIT 1),s.hash)
    UNION ALL
    SELECT j.id,j.kind,j.status,j.created_at,j.updated_at,COALESCE(json_extract(j.snapshot,'$.branchId'),r.branch_id),j.source_revision,j.generation,j.source_hash,0,(j.status='interrupted' OR COALESCE(j.error,'') LIKE '%PROVIDER_UNCERTAIN%') FROM story_jobs j JOIN sources s ON s.id=j.source_revision JOIN runs r ON r.id=s.run_id
      WHERE j.chat_id=? AND j.source_hash=COALESCE((SELECT hash FROM source_edits WHERE source_id=s.id ORDER BY revision DESC LIMIT 1),s.hash)
    UNION ALL
    SELECT j.id,'illustration',j.status,j.created_at,j.updated_at,r.branch_id,j.source_revision,j.generation,j.source_hash,0,(j.status='interrupted') FROM illustration_jobs j JOIN sources s ON s.id=j.source_revision JOIN runs r ON r.id=s.run_id
      WHERE j.chat_id=?
  ), recent AS (SELECT * FROM activity WHERE status NOT IN ('queued','running','waiting_for_state') ORDER BY updatedAt DESC,id DESC LIMIT 30)
  ${selection}`)
    .all(
      chatId,
      chatId,
      chatId,
      chatId,
      ...(page
        ? [...(page.before ?? []), page.limit]
        : sourceIds
          ? [JSON.stringify(sourceIds)]
          : [])
    ) as (Omit<ReaderActivity, 'startedAt' | 'finishedAt' | 'superseded' | 'executionUncertain'> & {
    superseded: number;
    executionUncertain: number;
  })[];
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
      row.kind === 'main'
        ? 'run'
        : row.kind === 'state'
          ? 'story.job'
          : row.kind === 'illustration'
            ? 'illustration'
            : 'job';
    const time = (status: string) => eventTimes.get(`${row.id}:${prefix}.${status}`);
    // A retry can reuse a job ID; queue time identifies that new user-visible execution.
    const startedAt = row.kind === 'main' ? row.createdAt : (time('queued') ?? row.createdAt);
    const finishedAt = ['queued', 'running', 'waiting_for_state'].includes(row.status)
      ? null
      : (time(row.status) ?? row.updatedAt);
    return {
      ...row,
      superseded: !!row.superseded,
      executionUncertain: !!row.executionUncertain,
      startedAt,
      finishedAt,
    };
  });
}

/** Bounded metadata history; independent of the reader's latest thirty records. */
export function readerActivities(
  store: Store,
  id: string,
  query: Record<string, string | undefined>
) {
  store.chat(id);
  const limit = query.limit === undefined ? 100 : Number(query.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new HttpError(400, 'Invalid activity limit');
  let before: [string, string] | null = null;
  if (query.before !== undefined) {
    try {
      const parsed: unknown = JSON.parse(Buffer.from(query.before, 'base64url').toString('utf8'));
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 3 ||
        parsed[0] !== id ||
        typeof parsed[1] !== 'string' ||
        !parsed[1] ||
        typeof parsed[2] !== 'string' ||
        !parsed[2]
      )
        throw new Error('Invalid cursor');
      before = [parsed[1], parsed[2]];
    } catch {
      throw new HttpError(400, 'Invalid activity cursor');
    }
  }
  const rows = readerActivity(store, id, undefined, { before, limit: limit + 1 });
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? Buffer.from(JSON.stringify([id, last.updatedAt, last.id])).toString('base64url')
        : null,
  };
}

/** Display summaries for an explicit task panel, or the reader's selected Run IDs. */
export function readerRuns(store: Store, id: string, scope?: string[]) {
  store.chat(id);
  // JSON projection happens in SQLite: do not parse quadratic history or diagnostic bodies.
  const runCosts = new Map(
    (
      store.db
        .prepare(`SELECT run_id AS runId,COUNT(*) AS attemptCount,
    SUM(CASE WHEN json_extract(response,'$.estimatedCost.status')='estimated' AND json_type(response,'$.estimatedCost.usd') IN ('integer','real') THEN 0 ELSE 1 END) AS unknownCount,
    SUM(COALESCE(json_extract(response,'$.estimatedCost.usd'),json_extract(response,'$.estimatedCost.subtotalUsd'),0)) AS subtotalUsd
    FROM attempts WHERE chat_id=? AND run_id IS NOT NULL AND role!='title' ${scope ? 'AND run_id IN (SELECT value FROM json_each(?))' : ''} GROUP BY run_id`)
        .all(id, ...(scope ? [JSON.stringify(scope)] : [])) as {
        runId: string;
        attemptCount: number;
        unknownCount: number;
        subtotalUsd: number;
      }[]
    ).map(({ runId, ...cost }) => [
      runId,
      { ...cost, usd: cost.unknownCount ? null : cost.subtotalUsd },
    ])
  );
  const runs = (
    store.db
      .prepare(`SELECT id,chat_id AS chatId,parent_revision AS parentRevision,status,request,source_revision AS sourceRevision,error,usage,partial_text AS partialText,
    json_extract(command,'$.retryOf') AS retryOf,
    CASE WHEN source_revision IS NULL THEN (SELECT newer.id FROM runs newer WHERE newer.chat_id=runs.chat_id AND json_extract(newer.command,'$.retryOf')=runs.id ORDER BY newer.created_at DESC,newer.id DESC LIMIT 1) END AS supersededBy,
    json_extract(snapshot,'$.settingsRevision') AS settingsRevision,CASE WHEN json_extract(snapshot,'$.packageStart.mode')='authored' THEN NULL ELSE json_extract(snapshot,'$.profile.models.main.title') END AS modelTitle,json_extract(snapshot,'$.sourceSegments') AS sourceSegments,COALESCE(json_array_length(snapshot,'$.profile.packageAttachments'),0)>0 AS hasPackages,
    CASE WHEN json_type(snapshot,'$.packageStart') IS NOT NULL THEN json_object('mode',json_extract(snapshot,'$.packageStart.mode'),'title',json_extract(snapshot,'$.packageStart.title')) END AS packageStart,
    CASE WHEN json_type(snapshot,'$.contextPlan')='object' THEN json_object('status',json_extract(snapshot,'$.contextPlan.status'),'inputTokenLimit',json_extract(snapshot,'$.contextPlan.budget.inputTokenLimit'),'estimatedInputTokens',json_extract(snapshot,'$.contextPlan.estimatedInputTokens'),'compactedSources',json_array_length(snapshot,'$.contextPlan.compacted'),'summaryCalls',json_extract(snapshot,'$.contextPlan.summaryCalls'),'error',json_extract(snapshot,'$.contextPlan.error')) END AS contextSummary,
    json_object('loreContextReset',json_extract(snapshot,'$.loreContextReset'),'branchId',branch_id,'candidateOf',json_extract(snapshot,'$.candidateOf'),'forkedFrom',json_extract(snapshot,'$.forkedFrom')) AS snapshot
    FROM runs WHERE chat_id=? ${scope ? 'AND id IN (SELECT value FROM json_each(?))' : ''} ORDER BY created_at,id`)
      .all(id, ...(scope ? [JSON.stringify(scope)] : [])) as (Record<string, any> & {
      id: string;
      request: string;
      retryOf: string | null;
      supersededBy: string | null;
      sourceRevision: string | null;
    })[]
  ).map((row) => ({
    ...row,
    estimatedCost: runCosts.get(row.id),
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
  return runs;
}

/**
 * `branches` records no parent, so the shape comes from the source chains: branches whose chains
 * share a prefix diverged at its last source. Walking that trie orders and indents them.
 */
export function branchTree(
  branches: Branch[],
  parents: Map<string, string | null>
): BranchTreeNode[] {
  const chains = new Map<string, string[]>();
  for (const branch of branches) {
    const chain: string[] = [];
    const seen = new Set<string>();
    let head = branch.headRevision;
    while (head && !seen.has(head)) {
      seen.add(head);
      if (!parents.has(head)) break;
      chain.push(head);
      head = parents.get(head) ?? null;
    }
    chains.set(branch.id, chain.reverse());
  }
  const nodes: BranchTreeNode[] = [];
  const emit = (branch: Branch, depth: number, fork: number) => {
    const chain = chains.get(branch.id)!;
    nodes.push({
      id: branch.id,
      depth,
      forkSourceId: fork > 0 ? chain[fork - 1] : null,
      forkIndex: fork > 0 ? fork : null,
      ownScenes: chain.length - fork,
      totalScenes: chain.length,
    });
  };
  /**
   * `members` share the first `start` sources and left their siblings after `fork` of them.
   * Only a position where the members actually part ways indents them and moves the fork.
   */
  const walk = (members: Branch[], start: number, depth: number, fork: number) => {
    const ending = members.filter((branch) => chains.get(branch.id)!.length === start);
    const groups = new Map<string, Branch[]>();
    for (const branch of members.filter((item) => chains.get(item.id)!.length > start)) {
      const next = chains.get(branch.id)![start];
      groups.set(next, [...(groups.get(next) ?? []), branch]);
    }
    const parting = ending.length + groups.size > 1;
    // A branch ending here parted from the row above it earlier; `start` is only where its own
    // continuations leave it, and those rows carry that themselves.
    for (const branch of ending) emit(branch, depth, fork);
    for (const group of groups.values()) {
      if (!parting) walk(group, start + 1, depth, fork);
      else if (group.length === 1) emit(group[0], depth + 1, start);
      else walk(group, start + 1, depth + 1, start);
    }
  };
  // A branch with no scene sits outside the source tree, so it cannot part anything.
  for (const branch of branches) if (!chains.get(branch.id)!.length) emit(branch, 0, 0);
  walk(
    branches.filter((branch) => chains.get(branch.id)!.length > 0),
    0,
    0,
    0
  );
  return nodes;
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
    chain.push(head);
    head = row.parentRevision;
  }
  chain.reverse();
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
    if (event.kind.startsWith('illustration.')) {
      const job = store.db
        .prepare('SELECT source_revision FROM illustration_jobs WHERE id=? AND chat_id=?')
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
  // One metadata scan serves navigation, selection and branch labels. Off-branch requests
  // and off-page execution diagnostics need not be materialized for the reader.
  const indexRows = store.db
    .prepare(`SELECT id,rowid AS admissionOrder,json_extract(command,'$.retryOf') AS retryOf,source_revision AS sourceRevision,status,branch_id AS branchId,
    CASE WHEN id IN (SELECT value FROM json_each(?)) THEN request ELSE NULL END AS request,
    json_extract(snapshot,'$.packageStart.mode') AS startMode,
    json_extract(snapshot,'$.candidateOf') AS candidateOf
    FROM runs WHERE chat_id=? ORDER BY created_at,id`)
    .all(JSON.stringify(chain.map((sourceId) => byId.get(sourceId)!.runId)), id) as {
    id: string;
    sourceRevision: string | null;
    status: string;
    branchId: string | null;
    admissionOrder: number;
    retryOf: string | null;
    candidateOf: string | null;
    request: string | null;
    startMode: string | null;
  }[];
  const requestRows = new Map(indexRows.map((run) => [run.id, run]));
  const requestOrder = (id: string): number => {
    let row = requestRows.get(id);
    const seen = new Set<string>();
    while (row?.retryOf && !seen.has(row.id)) {
      seen.add(row.id);
      const parent = requestRows.get(row.retryOf);
      if (!parent) break;
      row = parent;
    }
    return row?.admissionOrder ?? Number.MAX_SAFE_INTEGER;
  };
  // The complete task panel loads readerRuns independently when opened.
  const pageIds = new Set(order);
  const runs = readerRuns(
    store,
    id,
    indexRows
      .filter(
        (run) =>
          run.sourceRevision === null ||
          pageIds.has(run.sourceRevision) ||
          ['queued', 'running', 'waiting_for_state'].includes(run.status)
      )
      .map((run) => run.id)
  );
  for (const run of runs) Object.assign(run, { requestOrder: requestOrder(run.id) });
  const previousOrder = start > 0 ? requestOrder(byId.get(chain[start - 1])!.runId) : -Infinity;
  const finalOrder =
    start + order.length < chain.length
      ? requestOrder(byId.get(order[order.length - 1])!.runId)
      : Infinity;
  const pendingRunIds = runs
    .filter((run) => {
      if (
        run.sourceRevision ||
        run.supersededBy ||
        (run.snapshot.branchId ? run.snapshot.branchId !== branch.id : !branch.default)
      )
        return false;
      return (
        ['queued', 'running', 'waiting_for_state'].includes(
          requestRows.get(run.id)?.status ?? ''
        ) ||
        (requestOrder(run.id) > previousOrder && requestOrder(run.id) <= finalOrder)
      );
    })
    .map((run) => run.id);
  const runsById = new Map(indexRows.map((run) => [run.id, run]));
  // Requests label the branch's complete index without loading off-page source bodies.
  // Authored starts have no user request; never substitute generated or hidden content.
  const navigation = chain.map((sourceId, index) => {
    const run = runsById.get(byId.get(sourceId)!.runId);
    const request = String(run?.request ?? '')
      .replace(/\s+/gu, ' ')
      .trim();
    // 202 UTF-16 units suffice to decide whether there are more than 100 codepoints.
    // Avoid expanding a long request into an array only to discard all but its label.
    const characters = Array.from(request.slice(0, 202));
    const label =
      run?.startMode === 'authored'
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
        event.kind === 'branch.default.changed' ||
        event.kind.startsWith('asset.') ||
        event.kind.startsWith('job.') ||
        event.kind.startsWith('source.')
    );
  return {
    chat,
    runs,
    sources,
    jobs,
    illustrations: illustrationsForSources(
      store,
      sources.map((source) => source.id)
    ),
    profile: store.product.profile(id),
    branches: store.product.branches(id),
    ...(assetsChanged ? { assets: mergedReaderAssets(store, id, order) } : {}),
    reader: {
      navigation,
      pendingRunIds,
      branchTree: branchTree(
        store.product.branches(id),
        new Map(rows.map((row) => [row.id, row.parentRevision]))
      ),
      latestBranchRuns: Object.fromEntries(
        indexRows.filter((run) => run.branchId !== null).map((run) => [run.branchId!, run.id])
      ),
      candidateBranches: indexRows
        .filter((run) => run.candidateOf !== null && run.branchId !== null)
        .map((run) => run.branchId!),
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
