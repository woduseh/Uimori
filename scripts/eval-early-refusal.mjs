import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const EVALUATION_VERSION = 1;
const THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99];
const PARAGRAPH_REACH = 0.25;
const STOP_CODES = new Set([
  'JEV_CREDENTIAL_REQUIRED',
  'JUDGMENT_CREDENTIAL_REQUIRED',
  'JUDGMENT_CONNECTION_UNAVAILABLE',
]);
const LABEL = /^[A-Za-z0-9<>][A-Za-z0-9._:/@+<>=-]{0,95}$/u;
const USAGE =
  'Usage: eval-early-refusal.mjs [database] [--dist DIR] [--prefixes 500,1500,3000] [--limit-positives N] [--limit-negatives N] [--seed S] [--concurrency N] [--max-calls N] [--max-errors N] [--dry-run]';

const usageError = (message) => Object.assign(new Error(message), { code: 'USAGE' });

function options(argv) {
  const result = {
    path: process.env.UIMORI_DB,
    dist: join(process.cwd(), 'dist'),
    prefixes: [500, 1500, 3000],
    limitPositives: Infinity,
    limitNegatives: Infinity,
    seed: 1,
    concurrency: 4,
    maxCalls: 500,
    maxErrors: 25,
    dryRun: false,
  };
  const count = (name, value, minimum) => {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < minimum)
      throw usageError(`${name} must be an integer of at least ${minimum}`);
    return number;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = argv[index].startsWith('--') ? argv[index].split(/=(.*)/su) : [];
    const value = () => inline ?? argv[++index];
    if (flag === '--dry-run') result.dryRun = true;
    else if (flag === '--dist') result.dist = resolve(value());
    else if (flag === '--prefixes')
      result.prefixes = [
        ...new Set(
          String(value())
            .split(',')
            .map((entry) => count('--prefixes', entry, 1))
        ),
      ].sort((left, right) => left - right);
    else if (flag === '--limit-positives') result.limitPositives = count(flag, value(), 0);
    else if (flag === '--limit-negatives') result.limitNegatives = count(flag, value(), 0);
    else if (flag === '--seed') result.seed = count(flag, value(), 0);
    else if (flag === '--concurrency') result.concurrency = count(flag, value(), 1);
    else if (flag === '--max-calls') result.maxCalls = count(flag, value(), 0);
    else if (flag === '--max-errors') result.maxErrors = count(flag, value(), 1);
    else if (flag) throw usageError(USAGE);
    else result.path = argv[index];
  }
  if (!result.path) throw usageError(USAGE);
  return result;
}

const digest = (text) => createHash('sha256').update(text).digest('hex');

function shuffled(items, seed) {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function prefixOf(text, limit) {
  if (text.length <= limit) return null;
  const floor = Math.floor(limit * (1 - PARAGRAPH_REACH));
  for (const [separator, kind] of [
    ['\n\n', 'paragraph'],
    ['\n', 'line'],
  ]) {
    const index = text.lastIndexOf(separator, limit - separator.length);
    if (index >= floor && index > 0) return { text: text.slice(0, index), cut: kind };
  }
  const high = text.charCodeAt(limit - 1);
  const end = high >= 0xd800 && high <= 0xdbff ? limit - 1 : limit;
  return { text: text.slice(0, end), cut: 'hard' };
}

function readSamples(db, settings) {
  const thresholdOf = (value, fallback) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0.5 && value <= 1
      ? value
      : fallback;
  const judged = db
    .prepare(
      `SELECT status, error, json_extract(snapshot,'$.mainJudgment.response') AS text,
      json_extract(snapshot,'$.mainJudgment.threshold') AS threshold
      FROM runs WHERE json_extract(snapshot,'$.mainJudgment.response') IS NOT NULL`
    )
    .all();
  const sources = db
    .prepare(
      `SELECT s.text AS text, json_extract(r.snapshot,'$.mainJudgmentThreshold') AS threshold,
      json_extract(r.snapshot,'$.mainJudgmentEnabled') AS judgmentEnabled
      FROM sources s JOIN runs r ON r.id=s.run_id WHERE r.status='completed'`
    )
    .all();
  const pool = {
    judgedRuns: {},
    positiveRows: 0,
    negativeJudgedRows: 0,
    negativeSourceRows: sources.length,
    negativeSourcesWithJudgmentEnabled: sources.filter((row) => row.judgmentEnabled === 1).length,
  };
  const positives = new Map();
  const negatives = new Map();
  for (const row of judged) {
    const key = `${row.status}/${row.error ?? 'none'}`;
    pool.judgedRuns[key] = (pool.judgedRuns[key] ?? 0) + 1;
    const sample = {
      text: String(row.text),
      threshold: thresholdOf(row.threshold, settings.defaultThreshold),
    };
    if (row.status === 'refused' && row.error === 'MAIN_RESPONSE_REFUSED') {
      pool.positiveRows += 1;
      positives.set(digest(sample.text), { ...sample, origin: 'judged' });
    } else if (row.status === 'completed') {
      pool.negativeJudgedRows += 1;
      negatives.set(digest(sample.text), { ...sample, origin: 'judged' });
    }
  }
  for (const row of sources) {
    const text = String(row.text);
    const key = digest(text);
    if (!negatives.has(key))
      negatives.set(key, {
        text,
        threshold: thresholdOf(row.threshold, settings.defaultThreshold),
        origin: 'source',
      });
  }
  let conflicts = 0;
  for (const key of positives.keys()) if (negatives.delete(key)) conflicts += 1;
  pool.uniquePositives = positives.size;
  pool.uniqueNegatives = negatives.size;
  pool.labelConflictsDropped = conflicts;
  return {
    pool,
    positives: shuffled([...positives.values()], settings.seed).slice(0, settings.limitPositives),
    negatives: shuffled([...negatives.values()], settings.seed + 1).slice(
      0,
      settings.limitNegatives
    ),
  };
}

function plan(samples, prefixes) {
  const tasks = [];
  for (const [set, list] of [
    ['positives', samples.positives],
    ['negatives', samples.negatives],
  ])
    list.forEach((sample, index) => {
      tasks.push({ set, index, sample, prefix: 'full', text: sample.text, cut: 'none' });
      for (const limit of prefixes) {
        const prefix = prefixOf(sample.text, limit);
        if (prefix) tasks.push({ set, index, sample, prefix: limit, ...prefix });
      }
    });
  return tasks;
}

function stats(input) {
  const values = input.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!values.length) return { n: 0 };
  const at = (fraction) =>
    values[Math.min(values.length - 1, Math.max(0, Math.ceil(fraction * values.length) - 1))];
  return {
    n: values.length,
    min: values[0],
    p50: at(0.5),
    p90: at(0.9),
    p95: at(0.95),
    p99: at(0.99),
    max: values.at(-1),
    mean: values.reduce((total, value) => total + value, 0) / values.length,
  };
}

const rate = (count, total) => ({ count, rate: total ? count / total : null });

function scored(results) {
  const judged = results.filter((result) => result.score !== undefined);
  const errors = {};
  for (const result of results)
    if (result.error) errors[result.error] = (errors[result.error] ?? 0) + 1;
  return {
    judged: judged.length,
    errors,
    atRunThreshold: rate(
      judged.filter((result) => result.score >= result.sample.threshold).length,
      judged.length
    ),
    atThreshold: Object.fromEntries(
      THRESHOLDS.map((threshold) => [
        String(threshold),
        rate(judged.filter((result) => result.score >= threshold).length, judged.length),
      ])
    ),
    scores: stats(judged.map((result) => result.score)),
  };
}

function summarize(set, samples, results, prefixes) {
  const positive = set === 'positives';
  const control = new Map(
    results
      .filter((result) => result.prefix === 'full' && result.score !== undefined)
      .map((result) => [result.index, result.score >= result.sample.threshold])
  );
  const confirmed = (result) => control.get(result.index) === positive;
  const byPrefix = {};
  for (const limit of prefixes) {
    const at = results.filter((result) => result.prefix === limit);
    const entry = {
      samples: at.length,
      shorterThanPrefix: samples.length - at.length,
      cuts: {
        paragraph: at.filter((result) => result.cut === 'paragraph').length,
        line: at.filter((result) => result.cut === 'line').length,
        hard: at.filter((result) => result.cut === 'hard').length,
      },
      prefixChars: stats(at.map((result) => result.text.length)),
      fullChars: stats(at.map((result) => result.sample.text.length)),
      ...scored(at),
      controlConfirmed: scored(at.filter(confirmed)),
    };
    if (positive) {
      const detected = at.filter(
        (result) => result.score !== undefined && result.score >= result.sample.threshold
      );
      const remaining = (result) => result.sample.text.length - result.text.length;
      entry.followingFraction = stats(
        at.map((result) => remaining(result) / result.sample.text.length)
      );
      entry.detectedFollowingFraction = stats(
        detected.map((result) => remaining(result) / result.sample.text.length)
      );
      entry.detectedFollowingChars = stats(detected.map(remaining));
      entry.savedShareOfAllPositiveChars = samples.length
        ? detected.reduce((total, result) => total + remaining(result), 0) /
          samples.reduce((total, sample) => total + sample.text.length, 0)
        : null;
    } else {
      entry.maxScore = entry.scores.max ?? null;
    }
    byPrefix[String(limit)] = entry;
  }
  const full = results.filter((result) => result.prefix === 'full');
  const controlResult = scored(full);
  return {
    count: samples.length,
    origins: {
      judged: samples.filter((sample) => sample.origin === 'judged').length,
      source: samples.filter((sample) => sample.origin === 'source').length,
    },
    runThresholds: stats(samples.map((sample) => sample.threshold)),
    fullChars: stats(samples.map((sample) => sample.text.length)),
    control: {
      ...controlResult,
      reproduced: rate(
        full.filter(
          (result) =>
            result.score !== undefined && result.score >= result.sample.threshold === positive
        ).length,
        controlResult.judged
      ),
    },
    byPrefix,
  };
}

function safe(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number')
    return Number.isFinite(value) ? Math.round(value * 10_000) / 10_000 : null;
  if (typeof value === 'string') return LABEL.test(value) ? value : '(redacted)';
  if (Array.isArray(value)) return value.map(safe);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [safe(key), safe(entry)]));
}

function errorCode(error) {
  const code = error?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ? code : 'unavailable';
}

async function judgeAll(tasks, settings, server) {
  const controller = new AbortController();
  let next = 0;
  let calls = 0;
  let errors = 0;
  let stopped = null;
  const latencies = [];
  const results = [];
  const fetchOverride = process.env.UIMORI_EVAL_JUDGMENT_FETCH
    ? (await import(pathToFileURL(resolve(process.env.UIMORI_EVAL_JUDGMENT_FETCH)).href)).default
    : undefined;
  const worker = async () => {
    while (next < tasks.length && !controller.signal.aborted) {
      const task = tasks[next++];
      const started = performance.now();
      let sent = false;
      try {
        const verdict = await server.judgeMainRefusal(
          server.mainJudgmentInput(task.text, task.sample.threshold),
          {
            ...server.runtime,
            ...(fetchOverride && { fetch: fetchOverride }),
            signal: controller.signal,
            onAttemptStart: () => {
              calls += 1;
              sent = true;
              return `evaluation-${calls}`;
            },
            onAttemptFinish: () => {},
          }
        );
        latencies.push(performance.now() - started);
        results.push({ ...task, score: verdict.scores.explicitRefusal });
      } catch (error) {
        const code = errorCode(error);
        if (code === 'JEV_CANCELLED' && stopped) continue;
        errors += 1;
        results.push({ ...task, error: sent ? code : `unsent:${code}` });
        if (STOP_CODES.has(code) || errors >= settings.maxErrors) {
          stopped ??= STOP_CODES.has(code) ? code : 'max-errors';
          controller.abort();
        }
      }
    }
  };
  await Promise.all(Array.from({ length: settings.concurrency }, worker));
  return { results, calls, errors, stopped, latencies };
}

async function loadServer(dist, db) {
  const module = (path) => import(pathToFileURL(join(dist, 'server', path)).href);
  const [
    { judgeMainRefusal, mainJudgmentInput },
    { judgmentRuntime },
    { CredentialStore },
    { ProductStore },
    { DEFAULT_MAIN_JUDGMENT_THRESHOLD },
    { DATABASE_SCHEMA_VERSION },
  ] = await Promise.all([
    module('main-judgment.js'),
    module('judgment-runtime.js'),
    module('credentials.js'),
    module('product-store.js'),
    import(pathToFileURL(join(dist, 'core', 'main-judgment-settings.js')).href),
    module('database-schema.js'),
  ]);
  const schemaVersion = Number(db.prepare('PRAGMA user_version').get().user_version);
  if (schemaVersion !== DATABASE_SCHEMA_VERSION)
    throw Object.assign(new Error('schema'), {
      code: 'SCHEMA_VERSION_MISMATCH',
      detail: { schemaVersion, expected: DATABASE_SCHEMA_VERSION },
    });
  const store = { db, credentials: new CredentialStore(db) };
  store.product = new ProductStore(store);
  const runtime = judgmentRuntime(store);
  return {
    judgeMainRefusal,
    mainJudgmentInput,
    runtime,
    defaultThreshold: DEFAULT_MAIN_JUDGMENT_THRESHOLD,
    provider: runtime.target?.provider ?? 'typesafe',
    credential: async () => {
      try {
        return (await runtime.credential?.()) ? 'configured' : 'missing';
      } catch (error) {
        return errorCode(error);
      }
    },
  };
}

async function main() {
  const settings = options(process.argv.slice(2));
  const db = new DatabaseSync(settings.path, { readOnly: true });
  try {
    const server = await loadServer(settings.dist, db);
    const samples = readSamples(db, { ...settings, defaultThreshold: server.defaultThreshold });
    const tasks = plan(samples, settings.prefixes);
    const planned = {
      calls: tasks.length,
      controlCalls: tasks.filter((task) => task.prefix === 'full').length,
      prefixCalls: Object.fromEntries(
        settings.prefixes.map((limit) => [
          String(limit),
          tasks.filter((task) => task.prefix === limit).length,
        ])
      ),
      maxCalls: settings.maxCalls,
    };
    const header = {
      evaluation: EVALUATION_VERSION,
      generatedAt: new Date().toISOString(),
      node: process.version,
      provider: server.provider,
      dryRun: settings.dryRun,
      seed: settings.seed,
      concurrency: settings.concurrency,
      prefixes: settings.prefixes,
      thresholds: THRESHOLDS,
      pool: samples.pool,
      sampled: { positives: samples.positives.length, negatives: samples.negatives.length },
      planned,
    };
    const credential = await server.credential();
    if (settings.dryRun) return { ...header, credential };
    if (tasks.length > settings.maxCalls) {
      process.exitCode = 2;
      return { ...header, aborted: 'max-calls', calls: 0 };
    }
    if (credential !== 'configured') {
      process.exitCode = 2;
      return { ...header, aborted: 'credential', credential, calls: 0 };
    }
    const started = performance.now();
    const run = await judgeAll(tasks, settings, server);
    if (run.stopped) process.exitCode = 1;
    const of = (set) => run.results.filter((result) => result.set === set);
    return {
      ...header,
      ...(run.stopped && { aborted: run.stopped }),
      calls: run.calls,
      errors: run.errors,
      elapsedMs: performance.now() - started,
      callLatencyMs: stats(run.latencies),
      positives: summarize('positives', samples.positives, of('positives'), settings.prefixes),
      negatives: summarize('negatives', samples.negatives, of('negatives'), settings.prefixes),
    };
  } finally {
    db.close();
  }
}

let report;
try {
  report = await main();
} catch (error) {
  if (error?.code === 'USAGE') {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  process.exitCode = 2;
  report = { evaluation: EVALUATION_VERSION, error: errorCode(error), ...error?.detail };
}
process.stdout.write(`${JSON.stringify(safe(report))}\n`);
