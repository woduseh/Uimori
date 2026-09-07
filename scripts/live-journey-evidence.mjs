import { createHash } from 'node:crypto';

export const checkJourney = (value, code) => { if (!value) throw Object.assign(new Error(code), { code }); };
export const sameJourney = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const activeJourney = status => ['queued', 'running'].includes(status);
export const sourceHash = text => createHash('sha256').update(text).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const parse = value => { try { return JSON.parse(value); } catch { checkJourney(false, 'LIVE_JOURNEY_INVALID_ATTEMPT'); } };

export function parseLiveJourneyOptions(args) {
  const options = { source: null, execute: false, resumeChat: null, retranslateFirst: false }; let mode = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--source' && !options.source && args[i + 1] && !args[i + 1].startsWith('--')) options.source = args[++i];
    else if (arg === '--resume-chat' && !options.resumeChat && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(args[i + 1] ?? '')) options.resumeChat = args[++i];
    else if (arg === '--retranslate-first' && !options.retranslateFirst) options.retranslateFirst = true;
    else if (['--preflight', '--execute'].includes(arg) && !mode) { options.execute = arg === '--execute'; mode = true; }
    else checkJourney(false, 'INVALID_LIVE_JOURNEY_OPTIONS');
  }
  checkJourney(options.source, 'LIVE_JOURNEY_SOURCE_REQUIRED');
  checkJourney(!options.retranslateFirst || options.resumeChat, 'LIVE_JOURNEY_RESUME_CHAT_REQUIRED'); return options;
}

/** Exact local mock shape only. Every other row must be a recorded Vertex request. */
export function splitJourneyAttempts(rows) {
  const native = []; const mocks = []; const ids = new Set();
  for (const row of rows) {
    checkJourney(typeof row.id === 'string' && row.id && !ids.has(row.id), 'LIVE_JOURNEY_INVALID_ATTEMPT'); ids.add(row.id);
    const request = typeof row.request === 'string' ? parse(row.request) : row.request;
    checkJourney(object(request), 'LIVE_JOURNEY_INVALID_ATTEMPT');
    const connectionId = row.connection_id ?? row.connectionId; const modelId = row.model_id ?? row.modelId;
    if (row.status === 'mock' && connectionId === 'local-scripted' && modelId === 'deterministic-fixture' &&
      request.mock === true && request.protocol === undefined &&
      Object.keys(request).every(key => ['mock', 'input'].includes(key)) &&
      [['response', 'response'], ['input_tokens', 'inputTokens'], ['output_tokens', 'outputTokens'], ['cost_usd', 'costUsd'],
        ['raw_usage', 'rawUsage'], ['price_revision', 'priceRevision'], ['error', 'error']].every(([dbKey, apiKey]) => (Object.hasOwn(row, dbKey) ? row[dbKey] : row[apiKey]) === null)) { mocks.push({ row, request }); continue; }
    checkJourney(row.status !== 'mock' && request.mock === undefined && request.protocol === 'vertex-gemini-v1' &&
      request.connectionId === connectionId && request.modelId === modelId && request.role === row.role &&
      request.method === 'POST', 'LIVE_JOURNEY_NON_VERTEX_ATTEMPT');
    native.push({ row, request });
  }
  return { native, mocks };
}

export function summarizeJourneyAttempts(before, after, beforeAccounting, afterAccounting) {
  checkJourney(after.length >= before.length && sameJourney(after.slice(0, before.length), before), 'LIVE_JOURNEY_CHANGED_PRIOR_ATTEMPTS');
  const prior = splitJourneyAttempts(before); const total = splitJourneyAttempts(after); const fresh = splitJourneyAttempts(after.slice(before.length));
  checkJourney(prior.native.length === beforeAccounting.requestCount && total.native.length === afterAccounting.requestCount &&
    fresh.native.length === afterAccounting.requestCount - beforeAccounting.requestCount, 'LIVE_JOURNEY_LEDGER_COUNT_MISMATCH');
  let confirmed = 0; const unconfirmed = [];
  for (const { row, request } of fresh.native) {
    checkJourney(request.headers?.['x-vertex-ai-llm-request-type'] === 'shared' &&
      request.headers?.['x-vertex-ai-llm-shared-request-type'] === 'flex' && request.headers?.['x-server-timeout'] === '900', 'LIVE_JOURNEY_NON_FLEX_REQUEST');
    const raw = row.raw_usage === undefined ? row.rawUsage : row.raw_usage === null ? null : parse(row.raw_usage);
    if (raw?.trafficType === 'ON_DEMAND_FLEX') confirmed++;
    else {
      checkJourney(raw?.trafficType === undefined || raw?.trafficType === null, 'LIVE_JOURNEY_NON_FLEX_RESPONSE');
      checkJourney(!['completed', 'tool_calls', 'refused'].includes(row.status), 'LIVE_JOURNEY_UNCONFIRMED_FLEX');
      unconfirmed.push({ id: row.id, role: row.role, status: row.status, error: row.error });
    }
  }
  return { additionalRequestCount: fresh.native.length, totalRequestCount: total.native.length,
    additionalAttemptCount: fresh.native.length + fresh.mocks.length, localMockAttemptCount: fresh.mocks.length,
    localMockAttempts: fresh.mocks.map(({ row }) => ({ id: row.id, role: row.role, status: row.status, providerRequests: 0 })),
    confirmedFlexResponseCount: confirmed, unconfirmedTrafficAttempts: unconfirmed,
    requestTierVerified: true, allResponseTrafficConfirmed: unconfirmed.length === 0,
    requestCountMeaning: 'Durably admitted Vertex dispatch attempts, including errors and uncertain outcomes; local scripted attempts excluded.' };
}

export function validateJourneyModel(model) {
  checkJourney(model?.modelId === 'gemini-3.8-flash' && model.maxOutputTokens === 8192 && model.thinkingLevel === 'MEDIUM' &&
    model.timeoutMs === 900000 && model.connection?.enabled && model.connection.protocol === 'vertex-gemini-v1' &&
    model.serviceTier === 'flex', 'LIVE_RESUME_REQUIRED_MODEL_UNAVAILABLE');
}

export function selectResumePlan(detail, chatId) {
  checkJourney(detail?.chat?.id === chatId && !detail.runs.some(run => activeJourney(run.status)) &&
    !detail.jobs.some(job => activeJourney(job.status)) && !detail.attempts.some(attempt => attempt.status === 'running'), 'LIVE_RESUME_CHAT_NOT_QUIET');
  const branch = detail.branches?.find(item => item.default);
  const source = detail.sources.find(item => item.id === branch?.headRevision);
  const run = source && detail.runs.find(item => item.id === source.runId);
  checkJourney(source && run?.status === 'completed' && source.id === run.sourceRevision && source.parentRevision !== null &&
    run.snapshot.branchId === branch.id && !run.snapshot.candidateOf && !detail.runs.some(item => item.snapshot.candidateOf === run.id), 'LIVE_RESUME_CONTINUED_SOURCE_REQUIRED');
  checkJourney(sourceHash(source.text) === source.hash, 'LIVE_RESUME_SOURCE_HASH_MISMATCH');
  const translation = detail.jobs.filter(job => job.sourceRevision === source.id && job.kind === 'translation').sort((a, b) => (a.revision ?? 1) - (b.revision ?? 1)).at(-1);
  checkJourney(translation?.status === 'partial' && translation.result?.mock === false &&
    translation.result.sourceRevision === source.id && translation.result.sourceHash === source.hash &&
    Array.isArray(translation.chunks) && translation.chunks.length > 1, 'LIVE_RESUME_PARTIAL_TRANSLATION_REQUIRED');
  const completed = translation.chunks.filter(chunk => chunk.status === 'completed');
  const failed = translation.chunks.filter(chunk => ['failed', 'cancelled', 'interrupted'].includes(chunk.status));
  checkJourney(completed.length > 0 && failed.length > 0 && completed.length + failed.length === translation.chunks.length, 'LIVE_RESUME_CHUNK_STATE_INVALID');
  for (const role of ['main', 'translation']) {
    const model = run.snapshot.profile?.models[role]; validateJourneyModel(model);
    checkJourney(sameJourney(detail.profile.routes[role], { id: model.id, revision: model.revision }), 'LIVE_RESUME_MODEL_ROUTE_CHANGED');
  }
  checkJourney(detail.chat.settings.translation === true, 'LIVE_RESUME_TRANSLATION_DISABLED');
  return structuredClone({ chat: detail.chat, branch, source, run, translation, completed, failed });
}

export function checkTranslationComplete(source, translation) {
  checkJourney(translation?.status === 'completed' && translation.result?.mock === false &&
    translation.result.sourceRevision === source.id && translation.result.sourceHash === source.hash &&
    Array.isArray(translation.result.segments) && translation.result.segments.length > 0 && Array.isArray(source.blocks) && source.blocks.length > 0 &&
    sameJourney(translation.result.segments?.flatMap(segment => segment.anchors), source.blocks?.map(block => block.anchor)) &&
    translation.chunks?.length > 0 && translation.chunks.every(chunk => chunk.status === 'completed'), 'LIVE_RESUME_TRANSLATION_BINDING_OR_COVERAGE_MISMATCH');
  const text = translation.result.segments.map(segment => segment.text).join('\n\n');
  checkJourney(/[가-힣]/u.test(text), 'LIVE_RESUME_KOREAN_TEXT_MISSING'); return text;
}

export function checkRetriedTranslation(plan, before, after) {
  const translation = after.jobs.find(job => job.id === plan.translation.id);
  checkJourney(sameJourney(after.runs, before.runs) && sameJourney(after.sources, before.sources) &&
    sameJourney(after.profile, before.profile) && sameJourney(after.chat, before.chat) &&
    sameJourney(after.attempts.slice(0, before.attempts.length), before.attempts), 'LIVE_RESUME_RETRY_CHANGED_ORIGINAL');
  checkJourney(after.jobs.length === before.jobs.length && before.jobs.filter(job => job.id !== translation?.id).every(job => sameJourney(after.jobs.find(item => item.id === job.id), job)), 'LIVE_RESUME_RETRY_CHANGED_OTHER_JOB');
  checkJourney(translation?.generation === plan.translation.generation + 1 &&
    translation.chunks.length === plan.translation.chunks.length, 'LIVE_RESUME_RETRY_GENERATION_MISMATCH');
  for (const chunk of plan.completed) checkJourney(sameJourney(translation.chunks.find(item => item.id === chunk.id), chunk), 'LIVE_RESUME_COMPLETED_CHUNK_CHANGED');
  for (const chunk of plan.failed) {
    const current = translation.chunks.find(item => item.id === chunk.id);
    checkJourney(current?.status === 'completed' && current.attempt === chunk.attempt + 1, 'LIVE_RESUME_FAILED_CHUNK_NOT_RETRIED_ONCE');
  }
  const fresh = after.attempts.slice(before.attempts.length);
  checkJourney(fresh.length > 0 && fresh.every(attempt => attempt.jobId === translation.id && attempt.role === 'translation' &&
    attempt.request?.protocol === 'vertex-gemini-v1'), 'LIVE_RESUME_RETRY_WRONG_TARGET');
  return { translation, text: checkTranslationComplete(plan.source, translation) };
}

export function checkCandidatePreservation(plan, before, after, candidateRunId) {
  const run = after.runs.find(item => item.id === candidateRunId);
  const source = after.sources.find(item => item.id === run?.sourceRevision);
  const clean = snapshot => { const { branchId, candidateOf, ...rest } = snapshot; return rest; };
  checkJourney(after.runs.length === before.runs.length + 1 && before.runs.every(item => sameJourney(after.runs.find(current => current.id === item.id), item)) &&
    after.sources.length === before.sources.length + 1 && before.sources.every(item => sameJourney(after.sources.find(current => current.id === item.id), item)) &&
    before.jobs.every(job => sameJourney(after.jobs.find(item => item.id === job.id), job)) &&
    sameJourney(after.attempts.slice(0, before.attempts.length), before.attempts), 'LIVE_RESUME_CANDIDATE_CHANGED_ORIGINAL');
  checkJourney(run?.status === 'completed' && source && sourceHash(source.text) === source.hash &&
    source.parentRevision === plan.source.parentRevision && run.snapshot.candidateOf === plan.run.id &&
    run.snapshot.branchId !== plan.run.snapshot.branchId && sameJourney(clean(run.snapshot), clean(plan.run.snapshot)), 'LIVE_RESUME_CANDIDATE_SNAPSHOT_MISMATCH');
  const translation = after.jobs.findLast(job => job.sourceRevision === source.id && job.kind === 'translation');
  return { run, source, translation, text: checkTranslationComplete(source, translation) };
}

export function checkFirstRetranslation(firstSource, before, after, jobId) {
  const job = after.jobs.find(item => item.id === jobId);
  const previous = before.jobs.filter(item => item.sourceRevision === firstSource.id && item.kind === 'translation');
  const revision = Math.max(...previous.map(item => item.revision ?? 1)) + 1;
  checkJourney(previous.length > 0 && after.jobs.length === before.jobs.length + 1 &&
    before.jobs.every(item => sameJourney(after.jobs.find(current => current.id === item.id), item)) &&
    sameJourney(before.runs, after.runs) && sameJourney(before.sources, after.sources) &&
    sameJourney(before.profile, after.profile) && sameJourney(before.chat, after.chat) &&
    sameJourney(after.attempts.slice(0, before.attempts.length), before.attempts), 'LIVE_RESUME_RETRANSLATION_CHANGED_ORIGINAL');
  checkJourney(job?.sourceRevision === firstSource.id && job.kind === 'translation' && job.revision === revision &&
    job.generation === 1 && job.chunks?.length === 3 && job.chunks.every(chunk => chunk.attempt === 1), 'LIVE_RESUME_NEW_TRANSLATION_REVISION_MISMATCH');
  const fresh = after.attempts.slice(before.attempts.length);
  checkJourney(fresh.length > 0 && fresh.every(attempt => attempt.jobId === job.id && attempt.role === 'translation' &&
    attempt.request?.protocol === 'vertex-gemini-v1'), 'LIVE_RESUME_RETRANSLATION_WRONG_TARGET');
  return { translation: job, text: checkTranslationComplete(firstSource, job) };
}

/** Read-only DB projection used before the copied server or browser starts. */
export function readResumeDetail(db, chatId) {
  const chat = db.prepare('SELECT id,title,head_revision AS headRevision,settings_revision AS settingsRevision,settings,created_at AS createdAt FROM chats WHERE id=?').get(chatId);
  checkJourney(chat, 'LIVE_RESUME_CHAT_NOT_FOUND'); chat.settings = parse(chat.settings);
  const profile = db.prepare('SELECT body FROM profiles WHERE chat_id=?').get(chatId);
  checkJourney(profile, 'LIVE_RESUME_PROFILE_NOT_FOUND');
  const sources = db.prepare('SELECT id,chat_id AS chatId,run_id AS runId,parent_revision AS parentRevision,text,hash,created_at AS createdAt FROM sources WHERE chat_id=? ORDER BY rowid').all(chatId);
  const runs = db.prepare('SELECT id,status,snapshot,source_revision AS sourceRevision FROM runs WHERE chat_id=? ORDER BY rowid').all(chatId).map(run => ({ ...run, snapshot: parse(run.snapshot) }));
  const jobs = db.prepare('SELECT j.*,r.result FROM jobs j LEFT JOIN job_results r ON r.job_id=j.id WHERE j.chat_id=? ORDER BY j.rowid').all(chatId).map(job => ({
    id: job.id, sourceRevision: job.source_revision, kind: job.kind, status: job.status, revision: job.revision, generation: job.generation,
    result: job.result === null ? null : parse(job.result),
    chunks: db.prepare('SELECT id,status,attempt,input,result,error FROM job_chunks WHERE job_id=? ORDER BY rowid').all(job.id).map(chunk => ({
      ...chunk, input: chunk.input === null ? null : parse(chunk.input), result: chunk.result === null ? null : parse(chunk.result) })),
  }));
  const branches = db.prepare('SELECT id,head_revision AS headRevision,is_default FROM branches WHERE chat_id=? ORDER BY rowid').all(chatId).map(branch => ({ id: branch.id, headRevision: branch.headRevision, default: !!branch.is_default }));
  const attempts = db.prepare('SELECT * FROM attempts WHERE chat_id=? ORDER BY rowid').all(chatId);
  return { chat, profile: parse(profile.body), sources, runs, jobs, branches, attempts };
}
