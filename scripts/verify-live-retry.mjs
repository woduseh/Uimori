import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { root, newId, json, assertBuild, killOwned } from './lib.mjs';

function fail(code) { throw Object.assign(new Error(code), { code }); }
const check = (value, code) => { if (!value) fail(code); };
const code = error => /^[A-Z0-9_]+$/u.test(error?.code ?? '') ? error.code : 'LIVE_RETRY_FAILED';
const sha = value => createHash('sha256').update(value).digest('hex');
const fileHash = async file => sha(await readFile(file));
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const walIdentity = async file => {
  try { const metadata = await stat(file); check(metadata.isFile(), 'LIVE_RETRY_INVALID_WAL'); return { bytes: metadata.size, sha256: await fileHash(file) }; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const inside = (parent, target) => { const relative = path.relative(parent, target); return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative); };
const options = { execute: false, source: null, jobId: null, additionalRequests: 0, approvedMaxRequests: null, approvedMaxUsd: null };
let additionalRequestsSeen = false;
let modeSeen = false;
for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index];
  if (arg === '--help') { console.log('node scripts/verify-live-retry.mjs --source <closed live evidence directory> --job <translation job ID> [--additional-requests N | --approved-max-requests N --approved-max-usd USD] [--preflight | --execute]\nDefault is metadata/read-only preflight. --execute copies the closed evidence DB, retains its attempt ledger and original total limits, then submits one explicit failed-chunk retry. Additional requests default to zero; an explicit positive N must exactly match the increase in the environment total, with the USD ceiling unchanged. Explicit revised total ceilings require both approved flags and exactly matching environment totals. NR_VERTEX_REQUEST_TIER=flex is required. Credentials remain environment references.'); process.exit(0); }
  if (arg === '--source' && !options.source) options.source = process.argv[++index];
  else if (arg === '--job' && !options.jobId) options.jobId = process.argv[++index];
  else if (arg === '--additional-requests' && !additionalRequestsSeen) {
    const value = process.argv[++index]; const additional = Number(value);
    if (!/^[1-9]\d*$/u.test(value ?? '') || !Number.isSafeInteger(additional)) { console.error('INVALID_ADDITIONAL_REQUESTS'); process.exit(2); }
    options.additionalRequests = additional; additionalRequestsSeen = true;
  }
  else if (arg === '--approved-max-requests' && options.approvedMaxRequests === null) {
    const raw = process.argv[++index]; const value = Number(raw);
    if (!/^[1-9]\d*$/u.test(raw ?? '') || !Number.isSafeInteger(value)) { console.error('INVALID_APPROVED_LIMIT'); process.exit(2); }
    options.approvedMaxRequests = value;
  }
  else if (arg === '--approved-max-usd' && options.approvedMaxUsd === null) {
    const raw = process.argv[++index]; const value = Number(raw);
    if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/u.test(raw ?? '') || !Number.isFinite(value) || value <= 0) { console.error('INVALID_APPROVED_LIMIT'); process.exit(2); }
    options.approvedMaxUsd = value;
  }
  else if (['--execute', '--preflight'].includes(arg) && !modeSeen) { options.execute = arg === '--execute'; modeSeen = true; }
  else { console.error('INVALID_LIVE_RETRY_OPTIONS'); process.exit(2); }
}
if ((options.approvedMaxRequests === null) !== (options.approvedMaxUsd === null) || (options.approvedMaxRequests !== null && additionalRequestsSeen)) { console.error('EXPLICIT_LIMIT_PAIR_REQUIRED'); process.exit(2); }
if (!options.source || !options.jobId) { console.error('LIVE_RETRY_SOURCE_AND_JOB_REQUIRED'); process.exit(2); }
const sourceDirectory = path.resolve(root, options.source);
if (!inside(path.join(root, 'output', 'live'), sourceDirectory)) { console.error('LIVE_RETRY_SOURCE_OUTSIDE_EVIDENCE'); process.exit(2); }
const sourceDb = path.join(sourceDirectory, 'runtime', 'evidence.sqlite');
const runId = `live-retry-${newId()}`; const directory = path.join(root, 'output', 'live', runId);
const dbPath = path.join(directory, 'runtime', 'evidence.sqlite');
await mkdir(directory, { recursive: true });
const summary = { schema: 1, runId, mode: options.execute ? 'execute' : 'preflight', status: 'BLOCKED', startedAt: new Date().toISOString(),
  sourceEvidence: sourceDirectory, selectedJobId: options.jobId, preflight: { authenticationAttempted: false, networkRequests: 0 }, failures: [],
  limitations: ['Only failed chunks of the selected translation job are retried, with one explicit retry command. Existing completed chunks and source are preserved.',
    'The copied database retains the previous attempt ledger. Its ceilings change only through explicit approved CLI totals matched by server environment settings. Previous requests and reservations stay in the same ledger.',
    'Actual provider cost remains unknown unless explicitly reported. The accounting total combines conservative estimates and full uncertain reservations.',
    'Closed SQLite evidence may consist of a DB plus its WAL. Both are copied byte-for-byte and compared before/after; the derived SHM is rebuilt only in the copy.',
    'This is a targeted retry result. It does not replace or relabel the original failed live-run evidence. Semantic translation quality is not evaluated.'],
  cleanup: { status: 'NOT_RUN' } };
let build; let budgetModule; let limits; let baseline; let sourceSummary; let sourceOwner;
const capture = file => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(options.jobId); check(job && job.kind === 'translation', 'LIVE_RETRY_TRANSLATION_JOB_REQUIRED');
    const source = db.prepare('SELECT * FROM sources WHERE id=?').get(job.source_revision); check(source, 'LIVE_RETRY_SOURCE_MISSING');
    const run = db.prepare('SELECT * FROM runs WHERE id=?').get(source.run_id); check(run, 'LIVE_RETRY_SOURCE_RUN_MISSING');
    const chunks = db.prepare('SELECT * FROM job_chunks WHERE job_id=? ORDER BY rowid').all(job.id);
    const attempts = db.prepare('SELECT * FROM attempts ORDER BY rowid').all();
    const activeRuns = db.prepare("SELECT count(*) AS count FROM runs WHERE status IN ('queued','running')").get().count;
    const activeJobs = db.prepare("SELECT count(*) AS count FROM jobs WHERE status IN ('queued','running')").get().count;
    return { job, source, run, chunks, attempts, activeRuns, activeJobs,
      accounting: new budgetModule.ProviderBudget(db, limits).snapshot() };
  } finally { db.close(); }
};
const closedEvidence = async () => {
  check(sourceOwner.active === false && sourceOwner.children?.every(child => child.exited), 'LIVE_RETRY_SOURCE_NOT_CLOSED');
  await walIdentity(sourceDb + '-wal'); // A closed WAL is part of the durable DB, not a reason to checkpoint the original.
  check((await stat(sourceDb + '.owner.sqlite')).isFile(), 'LIVE_RETRY_SOURCE_MUTEX_MISSING');
};
try {
  build = await assertBuild();
  budgetModule = await import(pathToFileURL(path.join(root, 'dist/server/provider-budget.js')).href);
  check(typeof budgetModule.ProviderBudget?.prototype.snapshot === 'function', 'LIVE_RETRY_BUILD_EXPORT_MISSING');
  limits = budgetModule.parseLiveBudgetLimits(process.env); check(limits, 'LIVE_BUDGET_NOT_CONFIGURED');
  sourceSummary = await readJson(path.join(sourceDirectory, 'summary.json')); sourceOwner = await readJson(path.join(sourceDirectory, 'ownership.json'));
  check(sourceSummary.mode === 'execute' && sourceSummary.finishedAt, 'LIVE_RETRY_FINISHED_SOURCE_REQUIRED');
  const priorLimits = sourceSummary.approvedLimits;
  const requestedTotal = options.approvedMaxRequests ?? priorLimits?.maxRequests + options.additionalRequests;
  const requestedUsd = options.approvedMaxUsd ?? priorLimits?.maxCostUsd;
  check(Number.isSafeInteger(priorLimits?.maxRequests) && Number.isSafeInteger(requestedTotal) && requestedTotal >= priorLimits.maxRequests && requestedUsd >= priorLimits.maxCostUsd && limits.maxRequests === requestedTotal && limits.maxCostUsd === requestedUsd, 'LIVE_RETRY_TOTAL_LIMITS_MUST_MATCH_EXPLICIT_ALLOWANCE');
  summary.priorApprovedLimits = priorLimits; summary.additionalApprovedRequests = requestedTotal - priorLimits.maxRequests;
  summary.explicitRevisedCeilings = options.approvedMaxRequests === null ? null : {maxRequests:options.approvedMaxRequests,maxCostUsd:options.approvedMaxUsd};
  check(process.env.NR_VERTEX_REQUEST_TIER === 'flex', 'LIVE_RETRY_FLEX_REQUIRED'); summary.requestTier = 'flex';
  await closedEvidence(); baseline = capture(sourceDb);
  check(!baseline.activeRuns && !baseline.activeJobs && baseline.attempts.every(item => item.status !== 'running'), 'LIVE_RETRY_SOURCE_HAS_ACTIVE_WORK');
  check(['partial','failed'].includes(baseline.job.status), 'LIVE_RETRY_JOB_NOT_RETRYABLE');
  check(baseline.chunks.some(chunk => chunk.status === 'failed'), 'LIVE_RETRY_FAILED_CHUNKS_REQUIRED');
  const recordedAccounting = sourceSummary.afterAccounting ?? sourceSummary.accounting;
  check(baseline.accounting.requestCount === recordedAccounting?.requestCount, 'LIVE_RETRY_SOURCE_LEDGER_CHANGED');
  check(baseline.accounting.nextRequestAdmissible, baseline.accounting.blockedReason ?? 'LIVE_RETRY_NO_ALLOWANCE');
  const project = process.env.NR_VERTEX_PROJECT; const credentialFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  check(typeof project === 'string' && /^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]+)$/u.test(project), 'NR_VERTEX_PROJECT_REQUIRED');
  check(credentialFile && (await stat(credentialFile)).isFile(), 'GOOGLE_APPLICATION_CREDENTIALS_FILE_REQUIRED'); // No credential body read.
  const snapshot = JSON.parse(baseline.run.snapshot); const connection = snapshot.profile?.models.translation?.connection;
  check(connection?.protocol === 'vertex-gemini-v1' && connection.endpoint === `https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/publishers/google/models`, 'LIVE_RETRY_PROJECT_ROUTE_MISMATCH');
  summary.identity = { buildId: build.buildId, sourceHash: build.sourceHash, distHash: build.distHash, sourceEvidenceBuildId: sourceSummary.identity?.buildId };
  summary.approvedLimits = limits; summary.sourceDbSha256Before = await fileHash(sourceDb); summary.sourceWalBefore = await walIdentity(sourceDb + '-wal'); summary.sourceShmBefore = await walIdentity(sourceDb + '-shm'); summary.beforeAccounting = baseline.accounting;
  summary.selectedFailedChunkIds = baseline.chunks.filter(chunk => chunk.status === 'failed').map(chunk => chunk.id);
  summary.preservedCompletedChunks = baseline.chunks.filter(chunk => chunk.status === 'completed').map(chunk => ({ id: chunk.id, rowSha256: sha(JSON.stringify(chunk)) }));
  summary.sourceIdentity = { revision: baseline.source.id, hash: baseline.source.hash, textSha256: sha(baseline.source.text), snapshotSha256: sha(baseline.run.snapshot) };
  summary.preflight.ready = true;
} catch (error) { summary.preflight.ready = false; summary.preflight.reason = code(error); }
if (!options.execute || !summary.preflight.ready) {
  summary.status = summary.preflight.ready ? 'READY' : 'BLOCKED'; summary.finishedAt = new Date().toISOString(); summary.cleanup = { status: 'PASS', serverStarted: false, copiedDatabase: false };
  await json(path.join(directory, 'summary.json'), summary); console.log(JSON.stringify({ status: summary.status, mode: summary.mode, evidence: path.join(directory, 'summary.json'), preflight: summary.preflight }, null, 2));
  process.exitCode = summary.preflight.ready ? 0 : 2;
} else await executeRetry();

async function executeRetry() {
  let child; let sourceMutex; let sourceMutexHeld = false; let serverUrl; let cookie = ''; let interrupted = false;
  const accessToken = randomBytes(32).toString('base64url');
  const owner = { runId, ownerPid: process.pid, active: true, directory, dbPath, sourceEvidence: sourceDirectory, children: [] };
  const saveOwner = () => json(path.join(directory, 'ownership.json'), { ...owner, children: child ? [{ pid: child.pid, exited: child.exitCode !== null || child.signalCode !== null }] : [] });
  const log = async (event, fields = {}) => { const entry = { at: new Date().toISOString(), event, ...fields }; console.log(JSON.stringify(entry)); summary.events ??= []; summary.events.push(entry); await json(path.join(directory, 'summary.json'), summary); };
  const onInterrupt = () => { interrupted = true; if (child) void killOwned(child).catch(() => {}); };
  process.once('SIGINT', onInterrupt); process.once('SIGTERM', onInterrupt);
  const api = async (route, body) => {
    check(!interrupted, 'LIVE_RETRY_INTERRUPTED'); let response;
    try { response = await fetch(serverUrl + route, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(10_000) }); }
    catch { fail('LIVE_RETRY_LOCAL_HTTP_UNAVAILABLE'); }
    check(response.ok, `LIVE_RETRY_LOCAL_HTTP_${response.status}`); return response.json();
  };
  try {
    // Hold the same mutex used by Store while copying and verifying the original evidence.
    // No SQL writes are made to the original story database.
    sourceMutex = new DatabaseSync(sourceDb + '.owner.sqlite'); sourceMutex.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); sourceMutexHeld = true;
    await closedEvidence(); check(await fileHash(sourceDb) === summary.sourceDbSha256Before, 'LIVE_RETRY_SOURCE_CHANGED_BEFORE_COPY');
    check(JSON.stringify(await walIdentity(sourceDb + '-wal')) === JSON.stringify(summary.sourceWalBefore), 'LIVE_RETRY_SOURCE_WAL_CHANGED_BEFORE_COPY');
    await mkdir(path.dirname(dbPath), { recursive: true }); await copyFile(sourceDb, dbPath, constants.COPYFILE_EXCL);
    if (summary.sourceWalBefore !== null) await copyFile(sourceDb + '-wal', dbPath + '-wal', constants.COPYFILE_EXCL);
    // SHM is a derived coordination file; the new SQLite owner rebuilds it for the copied DB/WAL pair.
    summary.copyWalBefore = await walIdentity(dbPath + '-wal');
    check(JSON.stringify(summary.copyWalBefore) === JSON.stringify(summary.sourceWalBefore), 'LIVE_RETRY_COPY_WAL_HASH_MISMATCH');
    check(await fileHash(dbPath) === summary.sourceDbSha256Before, 'LIVE_RETRY_COPY_HASH_MISMATCH'); summary.copyDbSha256Before = await fileHash(dbPath);
    const copied = capture(dbPath);
    check(copied.accounting.requestCount === baseline.accounting.requestCount && JSON.stringify(copied.attempts) === JSON.stringify(baseline.attempts), 'LIVE_RETRY_COPY_LEDGER_MISMATCH');
    check(JSON.stringify(copied.source) === JSON.stringify(baseline.source) && copied.run.snapshot === baseline.run.snapshot && JSON.stringify(copied.chunks) === JSON.stringify(baseline.chunks), 'LIVE_RETRY_COPY_SOURCE_MISMATCH');
    summary.copyLedgerRequestCount = copied.accounting.requestCount;
    const instanceId = randomUUID();
    child = spawn(process.execPath, ['dist/server/index.js'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      NR_DB: dbPath, NR_PORT: '0', NR_INSTANCE: instanceId, NR_BUILD_ID: build.buildId, NR_TEST_MODE: '0', NR_ACCESS_TOKEN: accessToken,
      NR_PROVIDER_ORIGINS: 'https://aiplatform.googleapis.com', NR_LIVE_MAX_REQUESTS: String(limits.maxRequests), NR_LIVE_MAX_USD: String(limits.maxCostUsd) } });
    await saveOwner(); let pending = ''; let stderrBytes = 0; child.stderr.on('data', value => { stderrBytes += value.length; });
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error('LIVE_RETRY_SERVER_READY_TIMEOUT'), { code: 'LIVE_RETRY_SERVER_READY_TIMEOUT' })), 15_000);
      const failed = () => { clearTimeout(timer); reject(Object.assign(new Error('LIVE_RETRY_SERVER_START_FAILED'), { code: 'LIVE_RETRY_SERVER_START_FAILED' })); };
      child.once('error', failed); child.once('exit', failed);
      child.stdout.on('data', value => {
        pending += value.toString(); const lines = pending.split(/\r?\n/u); pending = lines.pop() ?? ''; if (pending.length > 4096) pending = '';
        for (const line of lines) try { const value = JSON.parse(line); if (value.event === 'ready') { clearTimeout(timer); child.removeListener('error', failed); child.removeListener('exit', failed); resolve(value); } } catch { /* No raw stdout/credentials are persisted. */ }
      });
    });
    check(/^http:\/\/127\.0\.0\.1:\d+$/u.test(ready.url) && ready.dbPath === dbPath && ready.buildId === build.buildId && ready.instanceId === instanceId, 'LIVE_RETRY_SERVER_IDENTITY_MISMATCH');
    serverUrl = ready.url;
    const session = await fetch(serverUrl + '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: accessToken }), redirect: 'error', signal: AbortSignal.timeout(5000) });
    check(session.ok, 'LIVE_RETRY_SESSION_FAILED'); cookie = session.headers.get('set-cookie')?.split(';')[0] ?? ''; check(cookie.startsWith('nr_session='), 'LIVE_RETRY_SESSION_FAILED');
    const health = await api('/api/health'); check(health.buildId === build.buildId && health.dbPath === dbPath && health.instanceId === instanceId, 'LIVE_RETRY_SERVER_IDENTITY_MISMATCH');
    await log('retry.server.ready', { pid: child.pid, url: serverUrl, startupStderrBytes: stderrBytes });
    const started = capture(dbPath); check(JSON.stringify(started.attempts) === JSON.stringify(baseline.attempts), 'LIVE_RETRY_STARTUP_CHANGED_PRIOR_ATTEMPTS');
    // This is the only retry command issued by the runner. The app retries only failed chunks.
    await api(`/api/jobs/${options.jobId}/retry`, {}); summary.retryCommandsIssued = 1; await log('retry.command.accepted', { selectedFailedChunks: summary.selectedFailedChunkIds.length });
    const deadline = Date.now() + 2_400_000; let lastLog = 0;
    while (true) {
      check(!interrupted, 'LIVE_RETRY_INTERRUPTED'); const detail = await api(`/api/chats/${baseline.job.chat_id}`);
      const job = detail.jobs.find(item => item.id === options.jobId); check(job, 'LIVE_RETRY_JOB_DISAPPEARED');
      const current = capture(dbPath); const fresh = current.attempts.slice(baseline.attempts.length);
      check(current.accounting.requestCount <= limits.maxRequests, 'LIVE_RETRY_REQUEST_CEILING_BROKEN');
      check(fresh.every(item => item.job_id === options.jobId && item.role === 'translation'), 'LIVE_RETRY_UNEXPECTED_PROVIDER_WORK');
      const accessFailure = fresh.map(item => item.error).find(value => typeof value === 'string' && /CREDENTIAL_UNAVAILABLE|CONNECTION_NOT_AUTHORIZED|HTTP_(?:401|403|404)/u.test(value));
      if (accessFailure) fail('LIVE_RETRY_COMMON_ACCESS_FAILURE');
      if (!['queued','running'].includes(job.status)) { summary.result = { status: job.status, error: job.error, result: job.result, chunks: job.chunks }; await json(path.join(directory, 'translation-result.json'), summary.result); break; }
      check(Date.now() < deadline, 'LIVE_RETRY_JOB_TIMEOUT');
      if (Date.now() - lastLog > 30_000) { await log('retry.waiting', { totalAdmittedRequests: current.accounting.requestCount, additionalRequests: fresh.length, jobStatus: job.status }); lastLog = Date.now(); }
      await delay(100);
    }
    const after = capture(dbPath);
    check(JSON.stringify(after.source) === JSON.stringify(baseline.source) && after.run.snapshot === baseline.run.snapshot, 'LIVE_RETRY_CHANGED_SOURCE_OR_SNAPSHOT');
    check(JSON.stringify(after.attempts.slice(0, baseline.attempts.length)) === JSON.stringify(baseline.attempts), 'LIVE_RETRY_CHANGED_PRIOR_ATTEMPTS');
    check(baseline.chunks.filter(item => item.status === 'completed').every(item => JSON.stringify(after.chunks.find(chunk => chunk.id === item.id)) === JSON.stringify(item)), 'LIVE_RETRY_CHANGED_COMPLETED_CHUNK');
    check(after.chunks.every(item => baseline.chunks.some(prior => prior.id === item.id)), 'LIVE_RETRY_CHANGED_CHUNK_PLAN');
    summary.preservation = { sourceBytes: true, sourceSnapshot: true, priorAttempts: true, completedChunkRows: true };
    check(after.job.plan === baseline.job.plan, 'LIVE_RETRY_CHANGED_CHUNK_PLAN');
    const actual = summary.result; const source = JSON.parse(after.job.plan).blocks;
    if (actual.status !== 'completed') {
      const budgetCode = ['LIVE_REQUEST_BUDGET_EXHAUSTED', 'LIVE_COST_BUDGET_EXHAUSTED', 'LIVE_BUDGET_NOT_CONFIGURED', 'LIVE_PRICE_REVERIFY_REQUIRED'].find(value => actual.error?.includes(value));
      if (budgetCode) fail(budgetCode);
    }
    check(actual.status === 'completed' && actual.result?.mock === false && actual.result.sourceRevision === baseline.source.id && actual.result.sourceHash === baseline.source.hash, 'LIVE_RETRY_TRANSLATION_INCOMPLETE');
    check(JSON.stringify(actual.result.segments.flatMap(segment => segment.anchors)) === JSON.stringify(source.map(block => block.anchor)), 'LIVE_RETRY_ANCHOR_COVERAGE_MISMATCH');
    check(/[가-힣]/u.test(actual.result.text), 'LIVE_RETRY_KOREAN_TEXT_NOT_OBSERVED');
    summary.translationValidation = { sourceIdentity: true, fullAnchorCoverage: true, containsKoreanText: true, semanticQuality: 'NOT_REVIEWED' };
    await assertBuild(); summary.status = 'PASS';
  } catch (error) { summary.failures.push(code(error)); summary.status = code(error).includes('BUDGET') || code(error) === 'LIVE_PRICE_REVERIFY_REQUIRED' ? 'BLOCKED' : 'FAIL'; }
  finally {
    const cleanupErrors = [];
    if (child) try { await killOwned(child); } catch { cleanupErrors.push('LIVE_RETRY_SERVER_CLEANUP_FAILED'); }
    try {
      const final = capture(dbPath); summary.afterAccounting = final.accounting; const fresh = final.attempts.slice(baseline.attempts.length);
      summary.additionalRequestCount = fresh.length; summary.totalRequestCount = final.accounting.requestCount;
      summary.newAttempts = fresh.map(item => ({ id: item.id, jobId: item.job_id, role: item.role, modelId: item.model_id, status: item.status, inputTokens: item.input_tokens, outputTokens: item.output_tokens,
        costUsd: item.cost_usd, rawUsage: item.raw_usage === null ? null : JSON.parse(item.raw_usage), priceRevision: item.price_revision, error: item.error, reservation: JSON.parse(item.request).budgetReservation ?? null }));
      if (fresh.length > limits.maxRequests - baseline.accounting.requestCount || final.accounting.requestCount > limits.maxRequests) cleanupErrors.push('LIVE_RETRY_REQUEST_CEILING_BROKEN');
    } catch { cleanupErrors.push('LIVE_RETRY_FINAL_LEDGER_UNAVAILABLE'); }
    try { summary.sourceDbSha256After = await fileHash(sourceDb); summary.sourceWalAfter = await walIdentity(sourceDb + '-wal'); summary.sourceShmAfter = await walIdentity(sourceDb + '-shm'); summary.sourceShmNote = 'Derived coordination bytes observed only; never copied. Original DB/WAL content is the preservation boundary.'; summary.originalEvidenceUnchanged = summary.sourceDbSha256After === summary.sourceDbSha256Before && JSON.stringify(summary.sourceWalAfter) === JSON.stringify(summary.sourceWalBefore); if (!summary.originalEvidenceUnchanged) cleanupErrors.push('LIVE_RETRY_ORIGINAL_EVIDENCE_CHANGED'); }
    catch { cleanupErrors.push('LIVE_RETRY_ORIGINAL_EVIDENCE_UNREADABLE'); }
    try { if (sourceMutex) { if (sourceMutexHeld) sourceMutex.exec('ROLLBACK'); sourceMutex.close(); } } catch { cleanupErrors.push('LIVE_RETRY_SOURCE_MUTEX_RELEASE_FAILED'); }
    owner.active = !!child && child.exitCode === null && child.signalCode === null; await saveOwner();
    summary.cleanup = { status: cleanupErrors.length || owner.active ? 'FAIL' : 'PASS', serverStillRunning: owner.active, errors: cleanupErrors,
      retained: ['runtime/evidence.sqlite', 'summary.json', 'ownership.json', ...(summary.result ? ['translation-result.json'] : [])] };
    if (cleanupErrors.length || owner.active) { summary.failures.push(...cleanupErrors); summary.status = 'FAIL'; }
    summary.finishedAt = new Date().toISOString(); await json(path.join(directory, 'summary.json'), summary);
    process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onInterrupt);
    console.log(JSON.stringify({ status: summary.status, evidence: path.join(directory, 'summary.json'), additionalRequests: summary.additionalRequestCount ?? null, totalRequests: summary.totalRequestCount ?? null, originalEvidenceUnchanged: summary.originalEvidenceUnchanged ?? null }, null, 2));
    if (summary.status !== 'PASS') process.exitCode = 1;
  }
}


