import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const LEDGER_VERSION = 1;
const LABEL = /^[A-Za-z0-9<>][A-Za-z0-9._:/@+<>=-]{0,95}$/u;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;
const PHASE = /^[A-Za-z][A-Za-z0-9]{0,47}$/u;
const TIMELINE_FIELDS = [
  'totalMs',
  'queueMs',
  'preMainMs',
  'preMainCalls',
  'preMainCallMs',
  'writingCalls',
  'writingToolRounds',
  'writingMs',
  'firstRoundMs',
  'finalRoundMs',
  'stagedToTerminalMs',
  'postMainMs',
  'postMainCalls',
  'calls',
];
const TRANSLATION_FIELDS = [
  'gapAfterRunMs',
  'queueMs',
  'durationMs',
  'sendToTranslatedMs',
  'runOnlyMs',
  'attempts',
  'translationCalls',
  'judgmentCalls',
];
const STREAM_FIELDS = [
  'firstByteMs',
  'firstTextMs',
  'firstThoughtMs',
  'streamMs',
  'requestBytes',
  'responseBytes',
  'interCallGapMs',
];

function label(value) {
  const text = String(value);
  if (UUID.test(text)) return '(id)';
  return LABEL.test(text) ? text : '(redacted)';
}

function aggregate(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number')
    return Number.isFinite(value)
      ? Number.isInteger(value)
        ? value
        : Math.round(value * 10) / 10
      : null;
  if (typeof value === 'string') return label(value);
  if (Array.isArray(value)) return value.map(aggregate);
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    const name = label(key);
    const safe = aggregate(entry);
    result[name] =
      typeof result[name] === 'number' && typeof safe === 'number' ? result[name] + safe : safe;
  }
  return result;
}

function failure(error) {
  const missing = /no such (table|column): ([A-Za-z0-9_.]+)/u.exec(String(error?.message));
  return { error: missing ? `missing-${missing[1]}:${missing[2]}` : 'unavailable' };
}

function options(argv) {
  let path = process.env.UIMORI_DB;
  let since;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--since') since = argv[++index];
    else if (argv[index].startsWith('--since=')) since = argv[index].slice('--since='.length);
    else path = argv[index];
  }
  if (!path) throw new Error('Usage: perf-ledger.mjs [database] [--since YYYY-MM-DD]');
  const start = since === undefined ? Date.now() - 30 * 86_400_000 : Date.parse(since);
  if (!Number.isFinite(start)) throw new Error('--since must be a date such as 2026-10-24');
  return { path, since: new Date(start).toISOString() };
}

function stats(input) {
  const values = input
    .map((value) => (typeof value === 'bigint' ? Number(value) : value))
    .filter((value) => typeof value === 'number' && Number.isFinite(value))
    .sort((left, right) => left - right);
  if (!values.length) return { n: 0 };
  const at = (fraction) =>
    values[Math.min(values.length - 1, Math.max(0, Math.ceil(fraction * values.length) - 1))];
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    n: values.length,
    p50: at(0.5),
    p90: at(0.9),
    p95: at(0.95),
    p99: at(0.99),
    max: values.at(-1),
    mean: sum / values.length,
    sum,
  };
}

function tally(items, key) {
  const result = {};
  for (const item of items) {
    const name = String(typeof key === 'function' ? key(item) : item[key]);
    result[name] = (result[name] ?? 0) + 1;
  }
  return result;
}

function groupBy(items, key) {
  const groups = new Map();
  for (const item of items) {
    const name = key(item);
    if (name === null || name === undefined) continue;
    const group = groups.get(name);
    if (group) group.push(item);
    else groups.set(name, [item]);
  }
  return groups;
}

const elapsed = (later, earlier) =>
  later && earlier ? Date.parse(later) - Date.parse(earlier) : null;

function gapBucket(gap) {
  if (gap === null || gap === undefined) return 'first';
  if (gap < 60_000) return '<1m';
  if (gap < 300_000) return '1-5m';
  if (gap < 900_000) return '5-15m';
  if (gap < 3_600_000) return '15-60m';
  if (gap < 86_400_000) return '1-24h';
  return '>24h';
}

function ledger(db, path, since) {
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const sections = {};
  const section = (name, compute) => {
    try {
      sections[name] = compute();
    } catch (error) {
      sections[name] = failure(error);
    }
  };
  const read = (sql, fallback = []) => {
    try {
      return all(sql);
    } catch {
      return fallback;
    }
  };

  const attempts =
    read(`SELECT id, chat_id, run_id, job_id, role, usage_kind, status, model_id, started_at,
    json_extract(request,'$.protocol') AS protocol,
    json_extract(request,'$.detailsOmitted') AS omitted,
    json_extract(request,'$.stablePrefixSha256') AS prefix_hash,
    json_extract(response,'$.executionDiagnostic.elapsedMs') AS elapsed,
    json_extract(response,'$.executionDiagnostic.finishedAt') AS finished_at,
    json_extract(response,'$.executionDiagnostic.firstByteMs') AS firstByteMs,
    json_extract(response,'$.executionDiagnostic.firstTextMs') AS firstTextMs,
    json_extract(response,'$.executionDiagnostic.firstThoughtMs') AS firstThoughtMs,
    json_extract(response,'$.executionDiagnostic.streamMs') AS streamMs,
    json_extract(response,'$.executionDiagnostic.requestBytes') AS requestBytes,
    json_extract(response,'$.executionDiagnostic.responseBytes') AS responseBytes,
    json_extract(response,'$.executionDiagnostic.interCallGapMs') AS interCallGapMs,
    input_tokens, output_tokens, COALESCE(cost_usd, estimated_usd, 0) AS usd,
    json_extract(raw_usage,'$.thoughtsTokenCount') AS thoughts,
    json_extract(raw_usage,'$.candidatesTokenCount') AS candidates,
    json_extract(raw_usage,'$.promptTokenCount') AS prompt_tokens,
    COALESCE(json_extract(raw_usage,'$.cachedContentTokenCount'),
      json_extract(raw_usage,'$.cache_read_input_tokens'),
      json_extract(raw_usage,'$.input_tokens_details.cached_tokens'),
      json_extract(raw_usage,'$.prompt_tokens_details.cached_tokens')) AS cached,
    json_extract(raw_usage,'$.cache_creation_input_tokens') AS cache_write,
    LENGTH(CAST(request AS BLOB)) AS stored_request_bytes,
    LENGTH(CAST(response AS BLOB)) AS stored_response_bytes,
    LENGTH(CAST(json_extract(request,'$.body') AS BLOB)) AS provider_body_bytes
    FROM attempts WHERE is_synthetic = 0 ORDER BY started_at`);
  const runs = read(`SELECT id, chat_id, status, created_at, updated_at,
    json_extract(command,'$.retryOf') AS retry_of,
    LENGTH(CAST(snapshot AS BLOB)) AS snapshot_bytes,
    LENGTH(CAST(request AS BLOB)) AS request_bytes,
    LENGTH(CAST(partial_text AS BLOB)) AS partial_bytes,
    json_extract(snapshot,'$.mainJudgmentEnabled') AS judgment_enabled,
    json_type(snapshot,'$.mainJudgment') AS judgment_type,
    json_type(snapshot,'$.nativeRisuAuthored') IS NOT NULL AS native_risu,
    json_type(snapshot,'$.storyGuideReceipt') IS NOT NULL AS story_guide,
    json_type(snapshot,'$.contextPlan') IS NOT NULL AS context_plan,
    COALESCE(json_array_length(snapshot,'$.requestImages'),0) AS request_images
    FROM runs`);
  const jobs = read(`SELECT id, kind, status, generation, created_at, updated_at,
    json_extract(input,'$.autoTranslateRunId') AS auto_run,
    LENGTH(CAST(input AS BLOB)) AS input_bytes FROM jobs`);
  const events = read(
    "SELECT kind, entity_id, at FROM events WHERE kind LIKE 'run.%' OR kind LIKE 'job.%'"
  );

  const eventTimes = new Map();
  for (const event of events) {
    const key = `${event.kind}|${event.entity_id}`;
    const known = eventTimes.get(key);
    if (!known) eventTimes.set(key, { first: event.at, last: event.at });
    else {
      if (event.at < known.first) known.first = event.at;
      if (event.at > known.last) known.last = event.at;
    }
  }
  const firstAt = (kind, id) => eventTimes.get(`${kind}|${id}`)?.first ?? null;
  const lastAt = (kind, id) => eventTimes.get(`${kind}|${id}`)?.last ?? null;
  const terminalAt = (run) =>
    firstAt('run.completed', run.id) ??
    firstAt('run.refused', run.id) ??
    firstAt('run.failed', run.id) ??
    firstAt('run.cancelled', run.id) ??
    run.updated_at;
  const runById = new Map(runs.map((run) => [run.id, run]));
  const attemptsByRun = groupBy(attempts, (attempt) => attempt.run_id);
  const attemptsByJob = groupBy(attempts, (attempt) => attempt.job_id);
  const recentRuns = runs.filter((run) => run.created_at >= since);
  const recentAttempts = attempts.filter((attempt) => attempt.started_at >= since);
  const writingOf = (run) =>
    (attemptsByRun.get(run.id) ?? []).filter((attempt) => attempt.usage_kind === 'writing');

  section('database', () => {
    const files = {};
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        files[`file${suffix || '-main'}`] = statSync(path + suffix).size;
      } catch {
        files[`file${suffix || '-main'}`] = null;
      }
    }
    const [physical] = all(`SELECT
      (SELECT page_count FROM pragma_page_count()) AS pageCount,
      (SELECT freelist_count FROM pragma_freelist_count()) AS freelistCount,
      (SELECT page_size FROM pragma_page_size()) AS pageSize,
      (SELECT journal_mode FROM pragma_journal_mode()) AS journalMode,
      (SELECT user_version FROM pragma_user_version()) AS schemaVersion,
      sqlite_version() AS sqliteVersion`);
    return { ...files, ...physical };
  });

  section('tables', () => {
    const names = all(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'search_fts%' ORDER BY name"
    ).map((row) => row.name);
    const rows = {};
    for (const name of names) rows[name] = all(`SELECT COUNT(*) AS n FROM "${name}"`)[0].n;
    let pages;
    try {
      pages = Object.fromEntries(
        all(
          'SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 40'
        ).map((row) => [row.name, row.bytes])
      );
    } catch (error) {
      pages = failure(error);
    }
    return { rows, dbstatBytes: pages };
  });

  section('scale', () => {
    const [counts] = all(`SELECT
      (SELECT COUNT(*) FROM chats) AS chats,
      (SELECT COUNT(*) FROM sources) AS scenes,
      (SELECT COUNT(*) FROM assets) AS chatAssets,
      (SELECT COUNT(*) FROM helper_conversations) AS helperConversations,
      (SELECT COUNT(*) FROM helper_tasks) AS helperTasks`);
    const scenes = all(
      'SELECT chat_id, LENGTH(text) AS chars, LENGTH(CAST(text AS BLOB)) AS bytes FROM sources'
    );
    const perChat = [...groupBy(scenes, (scene) => scene.chat_id).values()];
    return {
      ...counts,
      sceneChars: stats(scenes.map((scene) => scene.chars)),
      sceneBytes: stats(scenes.map((scene) => scene.bytes)),
      scenesPerChat: stats(perChat.map((list) => list.length)),
      chatSceneBytes: stats(
        perChat.map((list) => list.reduce((sum, scene) => sum + scene.bytes, 0))
      ),
    };
  });

  section('usage', () => {
    const describe = (list) =>
      [
        ...groupBy(
          list,
          (attempt) => `${attempt.usage_kind}/${attempt.protocol ?? 'unknown'}/${attempt.model_id}`
        ),
      ]
        .map(([key, group]) => ({
          key,
          calls: group.length,
          statuses: tally(group, 'status'),
          elapsedMs: stats(group.map((attempt) => attempt.elapsed)),
          inputTokens: group.reduce((sum, attempt) => sum + (attempt.input_tokens ?? 0), 0),
          outputTokens: group.reduce((sum, attempt) => sum + (attempt.output_tokens ?? 0), 0),
          cachedTokens: group.reduce((sum, attempt) => sum + (attempt.cached ?? 0), 0),
          cacheWriteTokens: group.reduce((sum, attempt) => sum + (attempt.cache_write ?? 0), 0),
          usd: group.reduce((sum, attempt) => sum + (attempt.usd ?? 0), 0),
        }))
        .sort((left, right) => right.calls - left.calls)
        .slice(0, 40);
    return {
      window: describe(recentAttempts),
      all: describe(attempts),
      byMonth: tally(attempts, (attempt) => String(attempt.started_at).slice(0, 7)),
    };
  });

  section('runs', () => {
    const perDay = Object.values(tally(recentRuns, (run) => run.created_at.slice(0, 10)));
    return {
      byStatusAll: tally(runs, 'status'),
      byStatusWindow: tally(recentRuns, 'status'),
      retriesAll: runs.filter((run) => run.retry_of).length,
      retriesWindow: recentRuns.filter((run) => run.retry_of).length,
      judgmentEnabled: tally(runs, (run) => String(run.judgment_enabled)),
      judgmentRecorded: tally(runs, (run) => String(run.judgment_type)),
      nativeRisuRuns: runs.filter((run) => run.native_risu).length,
      storyGuideRuns: runs.filter((run) => run.story_guide).length,
      contextPlanRuns: runs.filter((run) => run.context_plan).length,
      runsWithRequestImages: runs.filter((run) => run.request_images > 0).length,
      snapshotBytes: stats(runs.map((run) => run.snapshot_bytes)),
      requestBytes: stats(runs.map((run) => run.request_bytes)),
      partialBytes: stats(runs.map((run) => run.partial_bytes ?? 0)),
      activeDaysWindow: perDay.length,
      runsPerActiveDayWindow: stats(perDay),
    };
  });

  section('timeline', () => {
    const describe = (subset) => {
      const rows = subset.map((run) => {
        const list = attemptsByRun.get(run.id) ?? [];
        const writing = list.filter((attempt) => attempt.usage_kind === 'writing');
        const first = writing[0];
        const last = writing.at(-1);
        const before = first
          ? list.filter((attempt) => attempt.started_at < first.started_at)
          : list;
        const after = last
          ? list.filter(
              (attempt) => attempt.started_at > last.started_at && attempt.usage_kind !== 'writing'
            )
          : [];
        const terminal = terminalAt(run);
        return {
          totalMs: elapsed(terminal, run.created_at),
          queueMs: elapsed(firstAt('run.running', run.id), firstAt('run.queued', run.id)),
          preMainMs: first ? elapsed(first.started_at, run.created_at) : null,
          preMainCalls: before.length,
          preMainCallMs: before.reduce((sum, attempt) => sum + (attempt.elapsed ?? 0), 0),
          writingCalls: writing.length,
          writingToolRounds: writing.filter((attempt) => attempt.status === 'tool_calls').length,
          writingMs: writing.reduce((sum, attempt) => sum + (attempt.elapsed ?? 0), 0),
          firstRoundMs: first?.elapsed ?? null,
          finalRoundMs: last?.elapsed ?? null,
          stagedToTerminalMs: elapsed(terminal, lastAt('run.output.staged', run.id)),
          postMainMs: last?.finished_at ? elapsed(terminal, last.finished_at) : null,
          postMainCalls: after.length,
          calls: list.length,
          kindsBefore: before.map((attempt) => attempt.usage_kind),
        };
      });
      const result = { runs: rows.length };
      for (const key of TIMELINE_FIELDS) result[key] = stats(rows.map((row) => row[key]));
      result.preMainKinds = tally(
        rows.flatMap((row) => row.kindsBefore),
        (kind) => kind
      );
      result.toolRoundHistogram = tally(rows, (row) =>
        row.writingToolRounds >= 5 ? '5+' : row.writingToolRounds
      );
      return result;
    };
    const result = {};
    for (const status of ['completed', 'refused', 'failed'])
      result[status] = {
        window: describe(recentRuns.filter((run) => run.status === status)),
        all: describe(runs.filter((run) => run.status === status)),
      };
    return result;
  });

  section('preMain', () => {
    const rows = [];
    for (const run of recentRuns) {
      const list = attemptsByRun.get(run.id) ?? [];
      const first = list[0];
      const writing = list.find((attempt) => attempt.usage_kind === 'writing');
      if (!writing) continue;
      rows.push({
        native: run.native_risu ? 'native' : 'plain',
        plan: run.context_plan ? 'plan' : 'noplan',
        retry: run.retry_of ? 'retry' : 'fresh',
        kinds:
          list
            .filter((attempt) => attempt.started_at < writing.started_at)
            .map((attempt) => attempt.usage_kind)
            .join('+') || 'none',
        createdToRunning: elapsed(firstAt('run.running', run.id), run.created_at),
        runningToFirstCall: first
          ? elapsed(first.started_at, firstAt('run.running', run.id))
          : null,
        firstCallToWriting:
          first && first !== writing ? elapsed(writing.started_at, first.started_at) : 0,
        createdToWriting: elapsed(writing.started_at, run.created_at),
      });
    }
    const by = (key) =>
      Object.fromEntries(
        [...groupBy(rows, (row) => row[key])].map(([value, group]) => [
          value,
          stats(group.map((row) => row.createdToWriting)),
        ])
      );
    return {
      runs: rows.length,
      createdToRunningMs: stats(rows.map((row) => row.createdToRunning)),
      runningToFirstCallMs: stats(rows.map((row) => row.runningToFirstCall)),
      firstCallToWritingMs: stats(rows.map((row) => row.firstCallToWriting)),
      createdToWritingMsByNative: by('native'),
      createdToWritingMsByPlan: by('plan'),
      createdToWritingMsByRetry: by('retry'),
      createdToWritingMsByPriorCalls: by('kinds'),
    };
  });

  section('phaseSpans', () => {
    const rows =
      all(`SELECT r.created_at AS created_at, r.status AS status, j.key AS phase, j.value AS ms
      FROM runs r, json_each(r.snapshot,'$.phaseSpans') j
      WHERE json_type(r.snapshot,'$.phaseSpans') = 'object' AND j.type IN ('integer','real')`).filter(
        (row) => PHASE.test(row.phase)
      );
    const describe = (list) =>
      Object.fromEntries(
        [...groupBy(list, (row) => row.phase)].map(([phase, group]) => [
          phase,
          stats(group.map((row) => row.ms)),
        ])
      );
    return {
      window: describe(rows.filter((row) => row.created_at >= since)),
      windowCompleted: describe(
        rows.filter((row) => row.created_at >= since && row.status === 'completed')
      ),
      all: describe(rows),
    };
  });

  section('streaming', () => {
    const describe = (list) => {
      const result = { calls: list.length };
      for (const field of STREAM_FIELDS)
        result[field] = stats(list.map((attempt) => attempt[field]));
      return result;
    };
    return {
      windowByUsageKind: Object.fromEntries(
        [...groupBy(recentAttempts, (attempt) => attempt.usage_kind)].map(([kind, list]) => [
          kind,
          describe(list),
        ])
      ),
      windowWritingByModel: Object.fromEntries(
        [
          ...groupBy(
            recentAttempts.filter((attempt) => attempt.usage_kind === 'writing'),
            (attempt) => attempt.model_id
          ),
        ].map(([model, list]) => [model, describe(list)])
      ),
    };
  });

  section('refusal', () => {
    const refused = runs.filter((run) => run.status === 'refused');
    const describe = (subset) => {
      const kinds = { providerRefusedAttempt: 0, judgedAfterCompleted: 0, other: 0 };
      const lastOutput = [];
      const lastThoughts = [];
      const byModel = {};
      for (const run of subset) {
        const writing = writingOf(run);
        const last = writing.at(-1);
        if (writing.some((attempt) => attempt.status === 'refused'))
          kinds.providerRefusedAttempt += 1;
        else if (last?.status === 'completed') kinds.judgedAfterCompleted += 1;
        else kinds.other += 1;
        if (last) {
          lastOutput.push(last.output_tokens);
          lastThoughts.push(last.thoughts);
        }
        const model = last?.model_id ?? 'none';
        byModel[model] = (byModel[model] ?? 0) + 1;
      }
      return {
        runs: subset.length,
        kinds,
        lastWritingOutputTokens: stats(lastOutput),
        lastWritingThoughtTokens: stats(lastThoughts),
        byModel,
      };
    };
    const outcomeByModel = {};
    for (const run of runs) {
      const last = writingOf(run).at(-1);
      if (!last) continue;
      const entry = (outcomeByModel[last.model_id] ??= {
        completed: 0,
        refused: 0,
        failed: 0,
        other: 0,
      });
      entry[['completed', 'refused', 'failed'].includes(run.status) ? run.status : 'other'] += 1;
    }
    const durations = (status, list) =>
      stats(
        list
          .filter((run) => run.status === status)
          .map((run) => elapsed(run.updated_at, run.created_at))
      );
    const judgments = attempts.filter((attempt) => attempt.usage_kind === 'judgment');
    return {
      all: describe(refused),
      window: describe(refused.filter((run) => run.created_at >= since)),
      outcomeByFinalWritingModel: outcomeByModel,
      refusedRunMsWindow: durations('refused', recentRuns),
      completedRunMsWindow: durations('completed', recentRuns),
      judgmentAttempts: tally(judgments, (attempt) => `${attempt.role}/${attempt.status}`),
      judgmentElapsedMsByRole: Object.fromEntries(
        [...groupBy(judgments, (attempt) => attempt.role)].map(([role, list]) => [
          role,
          stats(list.map((attempt) => attempt.elapsed)),
        ])
      ),
      judgmentInputTokens: stats(judgments.map((attempt) => attempt.input_tokens)),
      mainJudgment: all(`SELECT json_type(snapshot,'$.mainJudgment.refused') AS refusedType,
        CAST(json_extract(snapshot,'$.mainJudgment.refused') AS INTEGER) AS refused,
        COUNT(*) AS runs, AVG(CAST(json_extract(snapshot,'$.mainJudgment.score') AS REAL)) AS averageScore
        FROM runs WHERE json_type(snapshot,'$.mainJudgment') = 'object' GROUP BY 1,2`),
    };
  });

  section('retry', () => {
    const rows = [];
    for (const run of runs) {
      const original = run.retry_of ? runById.get(run.retry_of) : undefined;
      if (original)
        rows.push({ status: original.status, gap: elapsed(run.created_at, terminalAt(original)) });
    }
    const result = {
      retriesWithKnownOriginal: rows.length,
      byOriginalStatus: tally(rows, 'status'),
    };
    for (const status of ['refused', 'failed', 'completed', 'cancelled']) {
      const gaps = rows
        .filter((row) => row.status === status && row.gap !== null && row.gap >= 0)
        .map((row) => row.gap);
      result[`gapMsAfter_${status}`] = stats(gaps);
      result[`gapBucketsAfter_${status}`] = tally(gaps, (gap) =>
        gap < 10_000
          ? '<10s'
          : gap < 60_000
            ? '10-60s'
            : gap < 300_000
              ? '1-5m'
              : gap < 1_800_000
                ? '5-30m'
                : '>30m'
      );
    }
    const depths = new Map();
    for (const run of runs) {
      let origin = run;
      let depth = 0;
      while (origin.retry_of && runById.has(origin.retry_of) && depth < 50) {
        origin = runById.get(origin.retry_of);
        depth += 1;
      }
      depths.set(origin.id, Math.max(depths.get(origin.id) ?? 0, depth));
    }
    result.retryChainDepth = tally([...depths.values()], (depth) => (depth >= 5 ? '5+' : depth));
    return result;
  });

  section('tokens', () => {
    const groups = groupBy(
      attempts.filter((attempt) => attempt.prompt_tokens !== null),
      (attempt) =>
        `${attempt.usage_kind}/${attempt.status}/${attempt.started_at >= since ? 'window' : 'older'}`
    );
    const result = {};
    for (const [key, list] of groups) {
      if (list.length < 5) continue;
      const prompt = list.reduce((sum, attempt) => sum + (attempt.prompt_tokens ?? 0), 0);
      const cached = list.reduce((sum, attempt) => sum + (attempt.cached ?? 0), 0);
      result[key] = {
        n: list.length,
        elapsedMs: stats(list.map((attempt) => attempt.elapsed)),
        promptTokens: stats(list.map((attempt) => attempt.prompt_tokens)),
        visibleOutputTokens: stats(list.map((attempt) => attempt.candidates)),
        thoughtTokens: stats(list.map((attempt) => attempt.thoughts)),
        thoughtSharePct: stats(
          list.map((attempt) =>
            attempt.thoughts !== null &&
            attempt.candidates !== null &&
            attempt.thoughts + attempt.candidates > 0
              ? (100 * attempt.thoughts) / (attempt.thoughts + attempt.candidates)
              : null
          )
        ),
        generatedTokensPerSecond: stats(
          list.map((attempt) =>
            attempt.elapsed > 0
              ? (((attempt.thoughts ?? 0) + (attempt.candidates ?? 0)) * 1000) / attempt.elapsed
              : null
          )
        ),
        cacheReadPctTotal: prompt ? (100 * cached) / prompt : null,
        zeroCacheCalls: list.filter((attempt) => !attempt.cached).length,
        cacheReadPctPerCall: stats(
          list.map((attempt) =>
            attempt.prompt_tokens ? (100 * (attempt.cached ?? 0)) / attempt.prompt_tokens : null
          )
        ),
      };
    }
    return result;
  });

  section('attemptBytes', () =>
    Object.fromEntries(
      [
        ...groupBy(
          attempts,
          (attempt) => `${attempt.usage_kind}/${attempt.omitted ? 'omitted' : 'full'}`
        ),
      ].map(([key, list]) => [
        key,
        {
          n: list.length,
          storedRequestBytes: stats(list.map((attempt) => attempt.stored_request_bytes)),
          providerBodyBytes: stats(list.map((attempt) => attempt.provider_body_bytes)),
          storedResponseBytes: stats(list.map((attempt) => attempt.stored_response_bytes)),
        },
      ])
    )
  );

  section('prefixStability', () => {
    const result = {
      runsWithTwoOrMoreWritingPrefixes: 0,
      samePrefixWithinRun: 0,
      changedPrefixWithinRun: 0,
      consecutiveRunsSameChat: 0,
      consecutiveSamePrefix: 0,
    };
    const firstPrefix = new Map();
    for (const [runId, list] of attemptsByRun) {
      const hashes = list
        .filter((attempt) => attempt.usage_kind === 'writing' && attempt.prefix_hash)
        .map((attempt) => attempt.prefix_hash);
      if (hashes.length) firstPrefix.set(runId, hashes[0]);
      if (hashes.length < 2) continue;
      result.runsWithTwoOrMoreWritingPrefixes += 1;
      if (new Set(hashes).size === 1) result.samePrefixWithinRun += 1;
      else result.changedPrefixWithinRun += 1;
    }
    for (const list of groupBy(
      runs.filter((run) => firstPrefix.has(run.id)),
      (run) => run.chat_id
    ).values()) {
      list.sort((left, right) => (left.created_at < right.created_at ? -1 : 1));
      for (let index = 1; index < list.length; index += 1) {
        result.consecutiveRunsSameChat += 1;
        if (firstPrefix.get(list[index].id) === firstPrefix.get(list[index - 1].id))
          result.consecutiveSamePrefix += 1;
      }
    }
    return result;
  });

  section('cacheByGap', () => {
    const describe = (kind) => {
      const lastEnd = new Map();
      const buckets = {};
      const recorded = {};
      for (const attempt of attempts) {
        if (attempt.usage_kind !== kind || !attempt.prompt_tokens) continue;
        const key = `${attempt.chat_id}|${attempt.role}|${attempt.model_id}`;
        const started = Date.parse(attempt.started_at);
        const previous = lastEnd.get(key);
        const end = attempt.finished_at
          ? Date.parse(attempt.finished_at)
          : started + (attempt.elapsed ?? 0);
        lastEnd.set(key, Math.max(end, started));
        if (attempt.started_at < since) continue;
        const add = (target, bucket) => {
          const entry = (target[bucket] ??= { calls: 0, prompt: 0, cached: 0, zeroCacheCalls: 0 });
          entry.calls += 1;
          entry.prompt += attempt.prompt_tokens;
          entry.cached += attempt.cached ?? 0;
          entry.zeroCacheCalls += attempt.cached ? 0 : 1;
        };
        add(buckets, gapBucket(previous === undefined ? null : started - previous));
        if (typeof attempt.interCallGapMs === 'number')
          add(recorded, gapBucket(attempt.interCallGapMs));
      }
      const finish = (target) =>
        Object.fromEntries(
          Object.entries(target).map(([bucket, entry]) => [
            bucket,
            {
              calls: entry.calls,
              zeroCacheCalls: entry.zeroCacheCalls,
              cacheReadPct: entry.prompt ? (100 * entry.cached) / entry.prompt : null,
            },
          ])
        );
      return { derived: finish(buckets), recordedInterCallGap: finish(recorded) };
    };
    return {
      writing: describe('writing'),
      translation: describe('translation'),
      helper: describe('helper'),
    };
  });

  section('tools', () => {
    const writerRounds = [];
    for (const [runId, list] of attemptsByRun) {
      const rounds = list.filter(
        (attempt) => attempt.usage_kind === 'writing' && attempt.status === 'tool_calls'
      );
      if (!rounds.length || rounds.some((attempt) => attempt.elapsed === null)) continue;
      const run = runById.get(runId);
      const total = run ? elapsed(terminalAt(run), run.created_at) : null;
      const cost = rounds.reduce((sum, attempt) => sum + attempt.elapsed, 0);
      writerRounds.push({
        rounds: rounds.length,
        cost,
        share: total ? (100 * cost) / total : null,
      });
    }
    const sequences = read(`SELECT run_id, group_concat(name, '>') AS names FROM (
        SELECT run_id, json_extract(data,'$.name') AS name FROM execution_tool_diagnostics
        WHERE origin='writer' AND run_id IS NOT NULL ORDER BY seq) GROUP BY run_id`);
    const signature = (names) => [...new Set(String(names).split('>'))].sort().join('+');
    return {
      eventsByName: all(`SELECT json_extract(event,'$.name') AS name, COUNT(*) AS calls,
        SUM(CASE WHEN json_extract(event,'$.denied') THEN 1 ELSE 0 END) AS denied,
        AVG(LENGTH(CAST(json_extract(event,'$.result') AS BLOB))) AS averageResultBytes
        FROM tool_events GROUP BY 1 ORDER BY calls DESC LIMIT 60`),
      diagnosticsByOriginName:
        all(`SELECT origin, json_extract(data,'$.name') AS name, COUNT(*) AS calls,
        AVG(json_extract(data,'$.elapsedMs')) AS averageMs, MAX(json_extract(data,'$.elapsedMs')) AS maxMs,
        AVG(json_extract(data,'$.providedResultChars')) AS averageResultChars
        FROM execution_tool_diagnostics GROUP BY 1,2 ORDER BY calls DESC LIMIT 60`),
      writerRunsWithTimedToolRounds: writerRounds.length,
      toolRoundMsPerRun: stats(writerRounds.map((row) => row.cost)),
      toolRoundSharePct: stats(writerRounds.map((row) => row.share)),
      perRoundMs: stats(
        attempts
          .filter((attempt) => attempt.usage_kind === 'writing' && attempt.status === 'tool_calls')
          .map((attempt) => attempt.elapsed)
      ),
      toolSetPerRun: tally(sequences, (row) => signature(row.names)),
      firstToolPerRun: tally(sequences, (row) => String(row.names).split('>')[0]),
    };
  });

  section('helper', () => {
    const tasks = all(`SELECT status, created_at, started_at, updated_at,
      LENGTH(CAST(snapshot AS BLOB)) AS snapshot_bytes FROM helper_tasks`);
    const measuredInputs = all(`SELECT json_extract(data,'$.preparationMs') AS preparation,
      json_extract(data,'$.compactionMs') AS compaction,
      json_extract(data,'$.estimatedInputTokens') AS tokens,
      json_extract(data,'$.tokenizer') AS tokenizer, json_extract(data,'$.execution') AS execution
      FROM helper_events WHERE kind='input.measured'`);
    return {
      tasksByStatus: tally(tasks, 'status'),
      taskMs: stats(
        tasks.map((task) => elapsed(task.updated_at, task.started_at ?? task.created_at))
      ),
      snapshotBytes: stats(tasks.map((task) => task.snapshot_bytes)),
      attemptsPerTask: stats(
        all('SELECT COUNT(*) AS n FROM helper_task_attempts GROUP BY task_id').map((row) => row.n)
      ),
      attemptsByPurpose: tally(all('SELECT purpose FROM helper_task_attempts'), 'purpose'),
      toolsByName: all(`SELECT json_extract(data,'$.name') AS name, COUNT(*) AS calls,
        AVG(json_extract(data,'$.elapsedMs')) AS averageMs, MAX(json_extract(data,'$.elapsedMs')) AS maxMs,
        AVG(json_extract(data,'$.queueMs')) AS averageQueueMs,
        AVG(json_extract(data,'$.providedResultChars')) AS averageResultChars
        FROM helper_events WHERE kind='tool.finished' GROUP BY 1 ORDER BY calls DESC LIMIT 60`),
      toolsPerCall: stats(
        all(
          "SELECT COUNT(*) AS n FROM helper_events WHERE kind='tool.finished' GROUP BY task_id, json_extract(data,'$.helperCall')"
        ).map((row) => row.n)
      ),
      inputPreparationMs: stats(measuredInputs.map((row) => row.preparation)),
      inputCompactionMs: stats(measuredInputs.map((row) => row.compaction)),
      estimatedInputTokens: stats(measuredInputs.map((row) => row.tokens)),
      tokenizer: tally(measuredInputs, 'tokenizer'),
      execution: tally(measuredInputs, 'execution'),
    };
  });

  section('translation', () => {
    const describe = (subset) => {
      const rows = subset.map((job) => {
        const run = job.auto_run ? runById.get(job.auto_run) : undefined;
        const end = lastAt('job.completed', job.id) ?? job.updated_at;
        const runEnd = run ? (firstAt('run.completed', run.id) ?? run.updated_at) : null;
        const list = attemptsByJob.get(job.id) ?? [];
        return {
          gapAfterRunMs: run ? elapsed(job.created_at, runEnd) : null,
          queueMs: elapsed(firstAt('job.running', job.id), firstAt('job.queued', job.id)),
          durationMs: elapsed(end, job.created_at),
          sendToTranslatedMs: run ? elapsed(end, run.created_at) : null,
          runOnlyMs: run ? elapsed(runEnd, run.created_at) : null,
          attempts: list.length,
          translationCalls: list.filter((attempt) => attempt.usage_kind === 'translation').length,
          judgmentCalls: list.filter((attempt) => attempt.usage_kind === 'judgment').length,
        };
      });
      const result = { jobs: rows.length };
      for (const key of TRANSLATION_FIELDS) result[key] = stats(rows.map((row) => row[key]));
      return result;
    };
    const completed = jobs.filter(
      (job) => job.kind === 'translation' && job.status === 'completed'
    );
    const autoRuns = new Set(
      jobs.filter((job) => job.kind === 'translation' && job.auto_run).map((job) => job.auto_run)
    );
    const completedRuns = (list) => list.filter((run) => run.status === 'completed');
    return {
      all: describe(completed),
      window: describe(completed.filter((job) => job.created_at >= since)),
      autoTranslatedRunsWindow: {
        completedRuns: completedRuns(recentRuns).length,
        withAutoTranslation: completedRuns(recentRuns).filter((run) => autoRuns.has(run.id)).length,
      },
      jobsByKindStatusOrigin: tally(
        jobs,
        (job) => `${job.kind}/${job.status}/${job.auto_run ? 'auto' : 'manual'}`
      ),
      retriedJobs: jobs.filter((job) => job.generation > 1).length,
      jobInputBytes: stats(jobs.map((job) => job.input_bytes)),
      resultTextChars: stats(
        all("SELECT LENGTH(json_extract(result,'$.text')) AS n FROM job_results").map(
          (row) => row.n
        )
      ),
      illustrationJobs: tally(
        all('SELECT origin, status FROM illustration_jobs'),
        (row) => `${row.origin}/${row.status}`
      ),
    };
  });

  section('storage', () => {
    const streamTasks =
      read(`SELECT task_kind, COUNT(*) AS chunks, SUM(LENGTH(CAST(text AS BLOB))) AS bytes
      FROM response_stream_chunks GROUP BY task_kind, task_id`);
    const images = read('SELECT mime, LENGTH(bytes) AS n FROM image_blobs');
    const cards = read(`SELECT LENGTH(CAST(body AS BLOB)) AS bytes,
      COALESCE(json_array_length(body,'$.package.images'),0) AS images,
      COALESCE(json_array_length(body,'$.package.lore'),0) AS lore,
      COALESCE(json_array_length(body,'$.package.nativeRisu.luaScripts'),0) AS luaScripts
      FROM versions WHERE kind='content'`);
    const sizes = (table, column) =>
      read(`SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(CAST(${column} AS BLOB))),0) AS bytes,
        COALESCE(MAX(LENGTH(CAST(${column} AS BLOB))),0) AS maxBytes FROM ${table}`)[0] ?? null;
    return {
      payloadBytes: {
        imageBlobs: sizes('image_blobs', 'bytes'),
        fontAssets: sizes('font_assets', 'bytes'),
        themeAssets: sizes('theme_assets', 'bytes'),
        attachmentBlobs: sizes('attachment_blobs', 'bytes'),
        runSnapshots: sizes('runs', 'snapshot'),
        versions: sizes('versions', 'body'),
        sources: sizes('sources', 'text'),
        sourceEdits: sizes('source_edits', 'text'),
        attemptRequests: sizes('attempts', 'request'),
        attemptResponses: sizes('attempts', 'response'),
        attemptRawUsage: sizes('attempts', 'raw_usage'),
        jobInputs: sizes('jobs', 'input'),
        jobResults: sizes('job_results', 'result'),
        helperEvents: sizes('helper_events', 'data'),
        modelInputs: sizes('model_inputs', 'input'),
        providerSettings: sizes('provider_settings', 'body'),
        resourceUndo: sizes('resource_undo', 'model'),
        promptWorkspace: sizes('prompt_workspace', 'body'),
        chatPromptOptions: sizes('chat_prompt_options', 'body'),
        chatLoreState: sizes('chat_lore_state', 'body'),
        profiles: sizes('profiles', 'body'),
        importOperations: sizes('import_operations', 'result'),
        appMetadata: sizes('app_metadata', 'value'),
        illustrationJobInputs: sizes('illustration_jobs', 'input'),
        illustrationJobDiagnostics: sizes('illustration_jobs', 'diagnostic'),
        illustrationImages: sizes('illustration_images', 'body'),
      },
      searchDocuments:
        read(`SELECT kind, COUNT(*) AS rows, SUM(LENGTH(CAST(text AS BLOB))) AS textBytes,
        SUM(LENGTH(CAST(search_text AS BLOB))) AS searchTextBytes FROM search_documents GROUP BY kind`),
      responseStream: {
        tasksWithChunks: streamTasks.length,
        tasksByKind: tally(streamTasks, 'task_kind'),
        chunksPerTask: stats(streamTasks.map((row) => row.chunks)),
        bytesPerTask: stats(streamTasks.map((row) => row.bytes)),
        tasksByStatus: tally(
          read('SELECT task_kind, status FROM response_stream_tasks'),
          (row) => `${row.task_kind}/${row.status}`
        ),
      },
      images: {
        byMime: tally(images, 'mime'),
        bytes: stats(images.map((row) => row.n)),
        overOneMegabyte: images.filter((row) => row.n > 1_048_576).length,
      },
      cards: {
        n: cards.length,
        bytes: stats(cards.map((row) => row.bytes)),
        images: stats(cards.map((row) => row.images)),
        lore: stats(cards.map((row) => row.lore)),
        withLua: cards.filter((row) => row.luaScripts > 0).length,
      },
      connections: read(`SELECT json_extract(body,'$.protocol') AS protocol,
        COALESCE(json_array_length(body,'$.catalog'),0) AS catalogModels,
        LENGTH(CAST(body AS BLOB)) AS bodyBytes FROM provider_settings WHERE kind='connection' ORDER BY bodyBytes DESC`),
      modelThinking: read(`SELECT json_extract(body,'$.capabilityProtocol') AS protocol,
        json_extract(body,'$.thinkingLevel') AS thinkingLevel,
        json_extract(body,'$.reasoningEffort') AS reasoningEffort,
        json_extract(body,'$.enabled') AS enabled, COUNT(*) AS models
        FROM provider_settings WHERE kind='model' GROUP BY 1,2,3,4`),
      eventsPerChat: stats(
        read('SELECT COUNT(*) AS n FROM events GROUP BY chat_id').map((row) => row.n)
      ),
      eventKinds: read(
        'SELECT kind, COUNT(*) AS n, MIN(at) AS firstAt, MAX(at) AS lastAt FROM events GROUP BY kind ORDER BY n DESC LIMIT 60'
      ),
      attemptRange:
        read('SELECT MIN(started_at) AS oldest, MAX(started_at) AS newest FROM attempts')[0] ??
        null,
    };
  });

  return sections;
}

const { path, since } = options(process.argv.slice(2));
const db = new DatabaseSync(path, { readOnly: true });
try {
  const result = {
    ledger: LEDGER_VERSION,
    generatedAt: new Date().toISOString(),
    since,
    node: process.version,
    ...ledger(db, path, since),
  };
  process.stdout.write(`${JSON.stringify(aggregate(result))}\n`);
} finally {
  db.close();
}
