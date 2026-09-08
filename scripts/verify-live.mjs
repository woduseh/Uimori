import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { root, newId, json, assertBuild, killOwned } from './lib.mjs';

// Default execution is a metadata-only preflight. Paid model requests require an explicit --execute.
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'node scripts/verify-live.mjs [--preflight | --execute]\nRequired environment: NR_VERTEX_PROJECT, GOOGLE_APPLICATION_CREDENTIALS (file reference), NR_VERTEX_REQUEST_TIER=flex.\nDefault/--preflight performs no authentication or network request. --execute runs paid synthetic scenarios in a new isolated SQLite database. Per-run call, timeout and output limits remain in force.'
  );
  process.exit(0);
}
if (
  args.some((arg) => !['--preflight', '--execute'].includes(arg)) ||
  new Set(args).size !== args.length ||
  args.length > 1
) {
  console.error('INVALID_LIVE_VERIFY_OPTIONS');
  process.exit(2);
}
const execute = args[0] === '--execute';
const runId = `live-${newId()}`;
const directory = path.join(root, 'output', 'live', runId);
const runtime = path.join(directory, 'runtime');
const dbPath = path.join(runtime, 'evidence.sqlite');
await mkdir(directory, { recursive: true });
const digest = (value) => createHash('sha256').update(value).digest('hex');
const safeCode = (error, fallback = 'LIVE_VERIFY_FAILED') =>
  typeof error?.code === 'string' && /^[A-Z0-9_]+$/u.test(error.code) ? error.code : fallback;
function fail(code) {
  throw Object.assign(new Error(code), { code });
}
function check(condition, code) {
  if (!condition) fail(code);
}
const summary = {
  schema: 1,
  runId,
  mode: execute ? 'execute' : 'preflight',
  status: 'BLOCKED',
  startedAt: new Date().toISOString(),
  model: 'gemini-3.8-flash',
  protocol: 'vertex-gemini-v1',
  endpointOrigin: 'https://aiplatform.googleapis.com',
  preflight: {},
  scenarios: {},
  samples: [],
  requests: [],
  restarts: [],
  failures: [],
  limitations: [
    'Synthetic creative material only. Semantic quality and refusal quality require a separate human review.',
    'Actual cost stays null when the provider does not report it. Token usage is recorded without estimating charges.',
    'Cancellation is observed after durable attempt admission; it does not prove that the remote model stopped or that no charge occurred.',
    'No automatic provider retries. Unexpected or uncertain results are retained; each scenario is attempted only once.',
    'This runner does not establish browser rendering, physical-phone behavior, live timeout/429 behavior, or a complete M1 acceptance claim.',
  ],
  cleanup: { status: 'NOT_RUN', retained: [] },
};
let build;
const checks = summary.preflight;
try {
  build = await assertBuild();
  summary.identity = {
    buildId: build.buildId,
    sourceHash: build.sourceHash,
    distHash: build.distHash,
    builtAt: build.builtAt,
  };
  checks.build = 'PASS';
} catch {
  checks.build = 'BUILD_MISSING_OR_STALE';
}
checks.requestTier =
  process.env.NR_VERTEX_REQUEST_TIER === 'flex' ? 'PASS' : 'NR_VERTEX_REQUEST_TIER_FLEX_REQUIRED';
summary.requestTier = process.env.NR_VERTEX_REQUEST_TIER ?? null;
const project = process.env.NR_VERTEX_PROJECT;
checks.project =
  typeof project === 'string' && /^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]+)$/u.test(project)
    ? 'PASS'
    : 'NR_VERTEX_PROJECT_REQUIRED';
const credentialFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
checks.credentials = 'GOOGLE_APPLICATION_CREDENTIALS_FILE_REQUIRED';
if (credentialFile)
  try {
    if ((await stat(credentialFile)).isFile()) checks.credentials = 'PASS';
  } catch {
    /* Metadata only: never read or echo the credential file. */
  }
if (build) {
  try {
    const { createApp } = await import(pathToFileURL(path.join(root, 'dist/server/app.js')).href);
    check(typeof createApp === 'function', 'LIVE_BUILD_EXPORT_MISSING');
    checks.runtime = 'PASS';
  } catch (error) {
    checks.runtime = safeCode(error, 'LIVE_BUILD_INVALID');
  }
} else checks.runtime = 'REQUIRES_CURRENT_BUILD';
checks.authenticationAttempted = false;
checks.networkRequests = 0;
checks.ready = ['build', 'project', 'credentials', 'requestTier', 'runtime'].every(
  (key) => checks[key] === 'PASS'
);
if (!execute || !checks.ready) {
  summary.status = checks.ready ? 'READY' : 'BLOCKED';
  summary.finishedAt = new Date().toISOString();
  summary.cleanup = { status: 'PASS', retained: ['summary.json'], serverStarted: false };
  await json(path.join(directory, 'summary.json'), summary);
  console.log(
    JSON.stringify(
      {
        status: summary.status,
        mode: summary.mode,
        evidence: path.join(directory, 'summary.json'),
        preflight: checks,
      },
      null,
      2
    )
  );
  process.exitCode = checks.ready ? 0 : 2;
} else await runLive();

async function runLive() {
  await mkdir(runtime, { recursive: true });
  const children = new Set();
  const charts = new Map();
  let server;
  let cookie = '';
  let interrupted = false;
  let fatalAccessReason = null;
  const accessToken = randomBytes(32).toString('base64url');
  const logs = [];
  const log = async (event, fields = {}) => {
    const value = { at: new Date().toISOString(), event, ...fields };
    logs.push(value);
    await writeFile(
      path.join(directory, 'events.jsonl'),
      logs.map((item) => JSON.stringify(item)).join('\n') + '\n'
    );
    console.log(JSON.stringify(value));
  };
  const owner = { runId, ownerPid: process.pid, active: true, directory, dbPath, children: [] };
  const owned = () =>
    json(path.join(directory, 'ownership.json'), {
      ...owner,
      children: [...children].map((child) => ({
        pid: child.pid,
        exited: child.exitCode !== null || child.signalCode !== null,
      })),
    });
  const onInterrupt = () => {
    interrupted = true;
    for (const child of children) void killOwned(child).catch(() => {});
  };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);
  const api = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
    check(!interrupted, 'LIVE_VERIFY_INTERRUPTED');
    let response;
    try {
      response = await fetch(server.ready.url + route, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(cookie ? { cookie } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      fail('LOCAL_HTTP_UNAVAILABLE');
    }
    if (!response.ok) fail(`LOCAL_HTTP_${response.status}`);
    return response.json();
  };
  const start = async () => {
    const instanceId = randomUUID();
    cookie = '';
    const child = spawn(process.execPath, ['dist/server/index.js'], {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NR_DB: dbPath,
        NR_PORT: '0',
        NR_INSTANCE: instanceId,
        NR_BUILD_ID: build.buildId,
        NR_TEST_MODE: '0',
        NR_ACCESS_TOKEN: accessToken,
        NR_PROVIDER_ORIGINS: 'https://aiplatform.googleapis.com',
      },
    });
    children.add(child);
    await owned();
    let pending = '';
    let stderrBytes = 0;
    child.stderr.on('data', (data) => {
      stderrBytes += data.length;
    }); // Do not copy raw server output into artifacts.
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            Object.assign(new Error('LIVE_SERVER_READY_TIMEOUT'), {
              code: 'LIVE_SERVER_READY_TIMEOUT',
            })
          ),
        15_000
      );
      const failed = () => {
        clearTimeout(timer);
        reject(
          Object.assign(new Error('LIVE_SERVER_START_FAILED'), { code: 'LIVE_SERVER_START_FAILED' })
        );
      };
      child.once('error', failed);
      child.once('exit', failed);
      child.stdout.on('data', (data) => {
        pending += data.toString();
        const lines = pending.split(/\r?\n/u);
        pending = lines.pop() ?? '';
        if (pending.length > 4096) pending = '';
        for (const line of lines)
          try {
            const value = JSON.parse(line);
            if (value.event === 'ready') {
              clearTimeout(timer);
              child.removeListener('error', failed);
              child.removeListener('exit', failed);
              resolve(value);
            }
          } catch {
            /* Non-ready stdout is deliberately not persisted. */
          }
      });
    });
    check(
      /^http:\/\/127\.0\.0\.1:\d+$/u.test(ready.url) &&
        ready.dbPath === dbPath &&
        ready.buildId === build.buildId &&
        ready.instanceId === instanceId,
      'LIVE_SERVER_IDENTITY_MISMATCH'
    );
    server = { child, ready };
    const login = await fetch(ready.url + '/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: accessToken }),
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    check(login.ok, 'LIVE_LOCAL_SESSION_FAILED');
    cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    check(cookie.startsWith('nr_session='), 'LIVE_LOCAL_SESSION_FAILED');
    const health = await api('/api/health');
    check(
      health.buildId === build.buildId &&
        health.instanceId === instanceId &&
        health.dbPath === dbPath,
      'LIVE_SERVER_IDENTITY_MISMATCH'
    );
    await log('server.ready', {
      pid: child.pid,
      instanceId,
      url: ready.url,
      startupStderrBytes: stderrBytes,
    });
  };
  const ledger = () => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const attempts = db
        .prepare(
          'SELECT id,chat_id,run_id,job_id,role,model_id,status,input_tokens,output_tokens,cost_usd,raw_usage,price_revision,error,request FROM attempts ORDER BY rowid'
        )
        .all()
        .map((row) => {
          const request = JSON.parse(row.request);
          return {
            id: row.id,
            chatId: row.chat_id,
            runId: row.run_id,
            jobId: row.job_id,
            role: row.role,
            modelId: row.model_id,
            status: row.status,
            inputTokens: row.input_tokens,
            outputTokens: row.output_tokens,
            costUsd: row.cost_usd,
            rawUsage: row.raw_usage === null ? null : JSON.parse(row.raw_usage),
            priceRevision: row.price_revision,
            error: row.error,
            bodySha256: request.bodySha256,
            stablePrefixSha256: request.stablePrefixSha256,
          };
        });
      return { requestCount: attempts.length, attempts };
    } finally {
      db.close();
    }
  };
  const checkpoint = async () => {
    const current = ledger();
    summary.totalRequestCount = current.requestCount;
    summary.requests = current.attempts;
    await json(path.join(directory, 'summary.json'), summary);
    return current;
  };
  const pause = async (ms) => {
    check(!interrupted, 'LIVE_VERIFY_INTERRUPTED');
    await delay(ms);
  };
  const wait = async (observe, predicate, code, timeoutMs = 600_000) => {
    const deadline = Date.now() + timeoutMs;
    let lastProgress = 0;
    while (Date.now() < deadline) {
      const value = await observe();
      if (predicate(value)) return value;
      if (Date.now() - lastProgress > 30_000) {
        await log('waiting', { boundary: code, attempts: ledger().requestCount });
        lastProgress = Date.now();
      }
      await pause(100);
    }
    fail(code);
  };
  const detail = (chatId) => api(`/api/chats/${chatId}`);
  const terminalRun = (id) =>
    wait(
      () => api(`/api/runs/${id}`),
      (run) => !['queued', 'running'].includes(run.status),
      'LIVE_RUN_TIMEOUT'
    );
  const restart = async (reason) => {
    const prior = server.child.pid;
    await killOwned(server.child);
    await start();
    const item = {
      reason,
      priorPid: prior,
      nextPid: server.child.pid,
      at: new Date().toISOString(),
    };
    summary.restarts.push(item);
    await log('server.restarted', item);
    return item;
  };
  const attach = (target, title, text, loading = 'discoverable') =>
    api('/api/content', {
      kind: 'module',
      title,
      text: target === 'translation' ? '' : text,
      description: `Synthetic ${title}`,
      loading,
      relatedIds: [],
      ...(target === 'translation'
        ? {
            package: {
              version: 1,
              id: 'live-translation-reference',
              revision: 1,
              title,
              description: `Synthetic ${title}`,
              body: '',
              lore: [],
              controls: [],
              transforms: [],
              instructions: [{ id: 'terms', target: 'translation', text }],
            },
          }
        : {}),
    });
  let mainModel;
  let translationModel;
  const reference = (value) => ({ id: value.id, revision: value.revision });
  const requireCompleted = (value, fallback) => {
    if (value.status === 'completed') return;
    const providerCode = typeof value.error === 'string' ? value.error : '';
    const accessFailure = [
      'CREDENTIAL_UNAVAILABLE',
      'CONNECTION_NOT_AUTHORIZED',
      'ENDPOINT_NOT_APPROVED',
      'HTTP_401',
      'HTTP_403',
      'HTTP_404',
    ].find((code) => providerCode.includes(code));
    if (accessFailure) {
      fatalAccessReason = accessFailure;
      fail(accessFailure);
    }
    fail(fallback);
  };
  const prepareChat = async (
    name,
    { attachments = [], translation = false, long = false } = {}
  ) => {
    const owner = await api('/api/content', {
      kind: 'bot',
      title: `Synthetic ${name} owner`,
      description: 'Synthetic live evaluation fixture',
      text: '',
      loading: 'pinned',
      relatedIds: [],
      package: {
        version: 1,
        id: `live-${name}`,
        revision: 1,
        title: `Synthetic ${name} owner`,
        description: 'Synthetic live evaluation fixture',
        body: '',
        lore: [],
        instructions: [],
        controls: [],
        transforms: [],
      },
    });
    const created = await api('/api/chats', { title: `Live synthetic ${name}`, botId: owner.id });
    const chat = await api(
      `/api/chats/${created.id}/settings`,
      {
        expectedSettingsRevision: created.settingsRevision,
        ...created.settings,
        translation,
        status: false,
        maxCalls: 16,
      },
      'PATCH'
    );
    const prior = await api(`/api/chats/${chat.id}/profile`);
    const prompt = await api('/api/prompt-presets', {
      title: `Synthetic ${name} writing instructions`,
      role: 'main',
      text: `Write original fiction in English, approximately ${long ? '1500–1800' : '120–220'} words. Preserve the attached author canon and leave unprovided reader choices open. Follow the current request and use approved read tools when helpful.`,
    });
    const profile = await api(
      `/api/chats/${chat.id}/profile`,
      {
        expectedRevision: prior.revision,
        attachments: attachments.filter((item) => !item.package).map(reference),
        packageAttachments: [
          ...(prior.packageAttachments ?? []),
          ...attachments
            .filter((item) => item.package)
            .map((item) => ({ ...reference(item), role: 'module' })),
        ],
        prompts: { ...prior.prompts, main: reference(prompt) },
        routes: {
          main: { id: mainModel.id },
          translation: translation ? { id: translationModel.id } : null,
          status: null,
          image: null,
        },
        image: false,
      },
      'PUT'
    );
    charts.set(name, { chat, profile });
    return { chat, profile };
  };
  const generate = async (context, request) => {
    const run = await api(`/api/chats/${context.chat.id}/runs`, {
      request,
      expectedRevision: context.chat.headRevision,
      expectedSettingsRevision: context.chat.settingsRevision,
      expectedProfileRevision: context.profile.revision,
      idempotencyKey: randomUUID(),
    });
    return terminalRun(run.id);
  };
  const saveSample = async (name, result) => {
    const file = `samples/${name}.json`;
    await json(path.join(directory, file), result);
    summary.samples.push({ name, file });
  };
  const recordScenario = async (name, action, needsRequest = true) => {
    await log('scenario.started', { name });
    const startedAt = new Date().toISOString();
    try {
      if (needsRequest && fatalAccessReason) {
        summary.scenarios[name] = { status: 'BLOCKED', reason: fatalAccessReason, startedAt };
        return;
      }
      const result = await action();
      summary.scenarios[name] = { status: 'PASS', startedAt, ...result };
    } catch (error) {
      const code = safeCode(error);
      summary.scenarios[name] = {
        status: code.includes('NOT_OBSERVED')
          ? 'NOT_OBSERVED'
          : code.includes('DEPENDENCY')
            ? 'BLOCKED'
            : 'FAIL',
        reason: code,
        startedAt,
      };
      summary.failures.push({ scenario: name, code });
      // A local deadline never causes an uncertain request to be retried.
      // Stop/reopen the same database so later independent cases can run without orphan work.
      if (
        ['LIVE_RUN_TIMEOUT', 'LIVE_JOB_TIMEOUT', 'LOCAL_HTTP_UNAVAILABLE'].includes(code) &&
        !interrupted
      )
        await restart(code);
    } finally {
      summary.scenarios[name].finishedAt = new Date().toISOString();
      await checkpoint();
      await log('scenario.finished', {
        name,
        status: summary.scenarios[name].status,
        reason: summary.scenarios[name].reason ?? null,
      });
    }
  };
  let original;
  let cancellation;
  try {
    await start();
    summary.execution = {
      startedAt: new Date().toISOString(),
      authentication:
        'Server-managed ADC when provider execution is reached; token exchange is not inspected or counted as model admission.',
    };
    const connection = await api('/api/connections', {
      title: 'Approved live Vertex global',
      protocol: 'vertex-gemini-v1',
      endpoint: `https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/publishers/google/models`,
      enabled: true,
    });
    mainModel = await api('/api/model-presets', {
      title: 'Live main synthetic',
      connectionId: connection.id,
      modelId: summary.model,
      maxOutputTokens: 12_000,
      temperature: null,
      thinkingLevel: 'MEDIUM',
      timeoutMs: 300_000,
    });
    translationModel = await api('/api/model-presets', {
      title: 'Live translation synthetic',
      connectionId: connection.id,
      modelId: summary.model,
      maxOutputTokens: 12_000,
      temperature: null,
      thinkingLevel: 'MEDIUM',
      timeoutMs: 300_000,
    });
    await recordScenario('short', async () => {
      const context = await prepareChat('short');
      const run = await generate(
        context,
        'Write a self-contained 120-220 word English scene about a keeper waiting beside a rain-streaked harbor window. Use only this description; do not use tools in this case. End with an open fictional choice.'
      );
      const current = await detail(run.chatId);
      const source = current.sources.find((item) => item.id === run.sourceRevision);
      await saveSample('short', {
        runId: run.id,
        status: run.status,
        source: source ?? null,
        usage: run.usage,
        toolNames: run.toolEvents.map((item) => item.name),
      });
      requireCompleted(run, 'SHORT_GENERATION_NOT_COMPLETED');
      check(source?.text.trim(), 'SHORT_SOURCE_MISSING');
      original = { context, run, source };
      check(run.toolEvents.length === 0, 'SHORT_NO_TOOL_PATH_NOT_OBSERVED');
      return {
        runId: run.id,
        sourceRevision: source.id,
        sourceHash: source.hash,
        words: source.text.match(/\b[A-Za-z]+(?:['’-][A-Za-z]+)*\b/gu)?.length ?? 0,
        semanticQuality: 'NOT_REVIEWED',
      };
    });
    await recordScenario('tools', async () => {
      const lore = await attach(
        'module',
        'Tideglass archive',
        'The fictional Tideglass archive opens only when the third bell sounds. Its western window is blue; its eastern window is amber.'
      );
      const skill = await attach(
        'module',
        'Quiet reveal',
        'Reveal one detail through a physical action. Keep the visitor decision open. This guidance grants no extra tools.'
      );
      const context = await prepareChat('tools', { attachments: [lore, skill] });
      const run = await generate(
        context,
        `Before writing this synthetic scene, read the Tideglass archive lore (${lore.id}) with knowledge.read and read Quiet reveal (${skill.id}) with knowledge.read. Then write 120-220 English words applying those materials. Do not report the tool process in the narrative.`
      );
      const current = await detail(run.chatId);
      const source = current.sources.find((item) => item.id === run.sourceRevision);
      const reads = run.toolEvents.map((item) => ({
        name: item.name,
        callId: item.callId,
        denied: item.denied,
        resourceId: item.args?.id ?? null,
      }));
      await saveSample('tools', {
        runId: run.id,
        status: run.status,
        source: source ?? null,
        usage: run.usage,
        reads,
      });
      requireCompleted(run, 'TOOL_GENERATION_NOT_COMPLETED');
      check(source?.text.trim(), 'TOOL_SOURCE_MISSING');
      check(
        reads.some(
          (item) => item.name === 'knowledge.read' && !item.denied && item.resourceId === lore.id
        ) &&
          reads.some(
            (item) => item.name === 'knowledge.read' && !item.denied && item.resourceId === skill.id
          ),
        'REQUESTED_TOOL_ROUNDTRIP_NOT_OBSERVED'
      );
      check(
        current.attempts
          .filter((item) => item.runId === run.id)
          .some((item) => item.status === 'tool_calls'),
        'TOOL_CALL_TURN_NOT_OBSERVED'
      );
      return { runId: run.id, sourceRevision: source.id, reads, semanticQuality: 'NOT_REVIEWED' };
    });
    await recordScenario('long_translation', async () => {
      const glossary = await attach(
        'translation',
        'Harbor terms',
        'For Korean translation, render Tideglass as 타이드글라스 and lantern as 등불. Preserve the source anchors and fictional facts.',
        'pinned'
      );
      const context = await prepareChat('long translation', {
        attachments: [glossary],
        translation: true,
        long: true,
      });
      const run = await generate(
        context,
        'Write an original English narrative of 1500-1800 words in 12-16 paragraphs. A keeper finds an unsigned map in the Tideglass harbor archive, follows three clues, and leaves the last choice to the reader. Use prose paragraphs, no headings, and no tools for this self-contained case.'
      );
      const first = await detail(run.chatId);
      const source = first.sources.find((item) => item.id === run.sourceRevision);
      await saveSample('long-original', {
        runId: run.id,
        status: run.status,
        source: source ?? null,
        usage: run.usage,
      });
      requireCompleted(run, 'LONG_GENERATION_NOT_COMPLETED');
      check(source?.text.trim(), 'LONG_SOURCE_MISSING');
      await api(`/api/sources/${source.id}/translation`, {});
      const final = await wait(
        () => detail(run.chatId),
        (value) =>
          value.jobs.some((job) => job.kind === 'translation') &&
          value.jobs
            .filter((job) => job.kind === 'translation')
            .every((job) => !['queued', 'running'].includes(job.status)),
        'LIVE_JOB_TIMEOUT',
        1_800_000
      );
      const job = final.jobs.find((item) => item.kind === 'translation');
      const unchanged = final.sources.find((item) => item.id === source.id);
      const words = source.text.match(/\b[A-Za-z]+(?:['’-][A-Za-z]+)*\b/gu)?.length ?? 0;
      await saveSample('long-translation', {
        runId: run.id,
        sourceRevision: source.id,
        sourceHash: source.hash,
        words,
        job,
      });
      check(
        unchanged?.hash === source.hash && unchanged.text === source.text,
        'TRANSLATION_CHANGED_SOURCE'
      );
      requireCompleted(job, 'LIVE_TRANSLATION_NOT_COMPLETED');
      check(
        job?.status === 'completed' &&
          job.result?.mock === false &&
          job.result.sourceRevision === source.id &&
          job.result.sourceHash === source.hash,
        'LIVE_TRANSLATION_NOT_COMPLETED'
      );
      check(
        JSON.stringify(job.result.segments.flatMap((segment) => segment.anchors)) ===
          JSON.stringify(source.blocks.map((block) => block.anchor)),
        'TRANSLATION_ANCHOR_COVERAGE_MISMATCH'
      );
      check(/[가-힣]/u.test(job.result.text), 'KOREAN_TEXT_NOT_OBSERVED');
      check(words >= 1000 && job.chunks.length >= 2, 'LONG_MULTICHUNK_PATH_NOT_OBSERVED');
      return {
        runId: run.id,
        sourceRevision: source.id,
        sourceHash: source.hash,
        words,
        requestedRange: { minWords: 1500, maxWords: 1800 },
        withinRequestedRange: words >= 1500 && words <= 1800,
        jobId: job.id,
        chunks: job.chunks.map((chunk) => ({
          id: chunk.id,
          status: chunk.status,
          attempt: chunk.attempt,
        })),
        semanticQuality: 'NOT_REVIEWED',
      };
    });
    await recordScenario('candidate', async () => {
      check(original, 'CANDIDATE_DEPENDENCY_UNAVAILABLE');
      const prior = await api(`/api/chats/${original.run.chatId}/profile`);
      const changed = await api(
        `/api/chats/${original.run.chatId}/profile`,
        {
          expectedRevision: prior.revision,
          attachments: prior.attachments,
          personaReference: prior.personaReference === false,
          routes: prior.routes,
          image: false,
        },
        'PUT'
      );
      const created = await api(`/api/runs/${original.run.id}/candidate`, {
        idempotencyKey: randomUUID(),
        title: 'Live candidate from original snapshot',
      });
      const run = await terminalRun(created.id);
      const current = await detail(run.chatId);
      const source = current.sources.find((item) => item.id === run.sourceRevision);
      await saveSample('candidate', {
        runId: run.id,
        candidateOf: run.snapshot.candidateOf,
        branchId: run.snapshot.branchId,
        status: run.status,
        source: source ?? null,
        originalProfileRevision: original.run.snapshot.profile.revision,
        currentProfileRevision: changed.revision,
        candidateProfileRevision: run.snapshot.profile.revision,
        usage: run.usage,
      });
      const {
        branchId: _originalBranch,
        candidateOf: _originalCandidate,
        ...originalSnapshot
      } = original.run.snapshot;
      const { branchId, candidateOf, ...candidateSnapshot } = run.snapshot;
      check(
        JSON.stringify(candidateSnapshot) === JSON.stringify(originalSnapshot) &&
          candidateOf === original.run.id &&
          branchId !== original.run.snapshot.branchId,
        'CANDIDATE_SNAPSHOT_MISMATCH'
      );
      requireCompleted(run, 'CANDIDATE_NOT_COMPLETED');
      check(source?.parentRevision === original.run.parentRevision, 'CANDIDATE_PARENT_MISMATCH');
      check(
        current.branches.find((item) => item.id === branchId)?.headRevision === source.id &&
          current.chat.headRevision === original.source.id,
        'CANDIDATE_BRANCH_ATTRIBUTION_MISMATCH'
      );
      check(
        current.sources.find((item) => item.id === original.source.id)?.hash ===
          original.source.hash,
        'CANDIDATE_CHANGED_ORIGINAL_SOURCE'
      );
      return {
        runId: run.id,
        branchId,
        candidateOf,
        sourceRevision: source.id,
        originalSourceHash: original.source.hash,
      };
    });
    await recordScenario('cancel', async () => {
      check(original, 'CANCEL_DEPENDENCY_UNAVAILABLE');
      const current = await detail(original.run.chatId);
      const prior = current.profile;
      const request = await api(`/api/chats/${original.run.chatId}/runs`, {
        request:
          'Write a long self-contained English scene about the harbor rain, slowly developing several discoveries. No tools are needed for this synthetic request.',
        expectedRevision: current.chat.headRevision,
        expectedSettingsRevision: current.chat.settingsRevision,
        expectedProfileRevision: prior.revision,
        idempotencyKey: randomUUID(),
      });
      const observed = await wait(
        () => detail(request.chatId),
        (value) =>
          value.attempts.some((item) => item.runId === request.id) ||
          !['queued', 'running'].includes(
            value.runs.find((item) => item.id === request.id)?.status
          ),
        'LIVE_CANCEL_ADMISSION_TIMEOUT',
        310_000
      );
      const attempt = observed.attempts.find((item) => item.runId === request.id);
      if (!attempt)
        requireCompleted(
          observed.runs.find((item) => item.id === request.id),
          'CANCEL_ATTEMPT_NOT_OBSERVED'
        );
      check(attempt, 'CANCEL_ATTEMPT_NOT_OBSERVED');
      const cancelled = await api(`/api/runs/${request.id}/cancel`, {});
      check(cancelled.status === 'cancelled', 'LIVE_CANCELLATION_NOT_OBSERVED');
      await pause(500);
      const after = await detail(request.chatId);
      const saved = after.runs.find((item) => item.id === request.id);
      check(
        saved.status === 'cancelled' &&
          saved.sourceRevision === null &&
          after.chat.headRevision === current.chat.headRevision,
        'CANCEL_COMMITTED_SOURCE'
      );
      check(
        after.sources.find((item) => item.id === original.source.id)?.hash === original.source.hash,
        'CANCEL_CHANGED_ORIGINAL_SOURCE'
      );
      cancellation = {
        chatId: request.chatId,
        runId: request.id,
        attemptId: attempt.id,
        sourceCount: after.sources.length,
        headRevision: after.chat.headRevision,
      };
      await saveSample('cancel', {
        ...cancellation,
        status: saved.status,
        usage: saved.usage,
        observation:
          'Cancellation issued after durable attempt admission; remote execution and final billing may remain unknown.',
      });
      return cancellation;
    });
    await recordScenario(
      'restart_reconnect',
      async () => {
        const before = ledger();
        const savedSources = new Map();
        for (const { chat } of charts.values()) {
          const current = await detail(chat.id);
          savedSources.set(
            chat.id,
            current.sources.map((source) => ({
              id: source.id,
              hash: source.hash,
              textHash: digest(source.text),
            }))
          );
        }
        const transition = await restart('explicit live lifecycle check');
        await pause(1500);
        const after = ledger();
        check(transition.priorPid !== transition.nextPid, 'PROCESS_RESTART_NOT_OBSERVED');
        check(after.requestCount === before.requestCount, 'RESTART_REPLAYED_PROVIDER_REQUEST');
        check(
          JSON.stringify(after.attempts.map((item) => item.id)) ===
            JSON.stringify(before.attempts.map((item) => item.id)),
          'RESTART_CHANGED_ATTEMPT_IDENTITY'
        );
        for (const [chatId, expected] of savedSources) {
          const current = await detail(chatId);
          check(
            JSON.stringify(
              current.sources.map((source) => ({
                id: source.id,
                hash: source.hash,
                textHash: digest(source.text),
              }))
            ) === JSON.stringify(expected),
            'RESTART_CHANGED_SOURCE'
          );
        }
        if (cancellation) {
          const run = await api(`/api/runs/${cancellation.runId}`);
          check(
            run.status === 'cancelled' && run.sourceRevision === null,
            'RESTART_CHANGED_CANCELLED_RUN'
          );
        }
        return {
          ...transition,
          beforeRequests: before.requestCount,
          afterRequests: after.requestCount,
          sourceChatsChecked: savedSources.size,
          cancelledRunChecked: cancellation?.runId ?? null,
          reconnect: 'actual new HTTP origin and session',
        };
      },
      false
    );
    await assertBuild();
  } catch (error) {
    summary.failures.push({ scenario: 'runner', code: safeCode(error) });
  } finally {
    const cleanupErrors = [];
    for (const child of children)
      try {
        await killOwned(child);
      } catch {
        cleanupErrors.push('OWNED_SERVER_CLEANUP_FAILED');
      }
    try {
      await checkpoint();
    } catch {
      cleanupErrors.push('FINAL_LEDGER_UNAVAILABLE');
    }
    owner.active = [...children].some(
      (child) => child.exitCode === null && child.signalCode === null
    );
    await owned();
    summary.cleanup = {
      status: cleanupErrors.length || owner.active ? 'FAIL' : 'PASS',
      serverStillRunning: owner.active,
      errors: cleanupErrors,
      retained: [
        'runtime/evidence.sqlite',
        'samples',
        'summary.json',
        'events.jsonl',
        'ownership.json',
      ],
    };
    summary.failures.push(...cleanupErrors.map((code) => ({ scenario: 'cleanup', code })));
    summary.status = summary.failures.some(
      (item) => !item.code.includes('NOT_OBSERVED') && !item.code.includes('DEPENDENCY')
    )
      ? 'FAIL'
      : Object.values(summary.scenarios).some((item) => item.status === 'BLOCKED')
        ? 'BLOCKED'
        : Object.values(summary.scenarios).length === 6 &&
            Object.values(summary.scenarios).every((item) => item.status === 'PASS')
          ? 'PASS'
          : 'INCOMPLETE';
    summary.finishedAt = new Date().toISOString();
    await json(path.join(directory, 'summary.json'), summary);
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onInterrupt);
    console.log(
      JSON.stringify(
        {
          status: summary.status,
          evidence: path.join(directory, 'summary.json'),
          requests: summary.totalRequestCount ?? null,
          cleanup: summary.cleanup.status,
        },
        null,
        2
      )
    );
    if (summary.status !== 'PASS') process.exitCode = 1;
  }
}
