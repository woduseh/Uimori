import { describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const helperUrl = new URL('../scripts/live-journey-evidence.mjs', import.meta.url).href;
const browserUrl = new URL('../scripts/live-journey-browser.mjs', import.meta.url).href;
const resumeUrl = new URL('../scripts/resume-journey-browser.mjs', import.meta.url).href;
const { parseLiveJourneyOptions, splitJourneyAttempts, summarizeJourneyAttempts, selectResumePlan, checkRetriedTranslation,
  checkCandidatePreservation, checkFirstRetranslation, validateJourneyModel, sourceHash } = await import(helperUrl);
const { runLiveJourney } = await import(browserUrl);
const { runResumeJourney } = await import(resumeUrl);

const model = (id: string) => ({ id, revision: 1, modelId: 'gemini-3.8-flash', maxOutputTokens: 8192, temperature: null, thinkingLevel: 'MEDIUM', timeoutMs: 900000, serviceTier: 'flex',
  connectionId: 'vertex', connectionRevision: 1, connection: { id: 'vertex', revision: 1, enabled: true, protocol: 'vertex-gemini-v1' } });
const native = (id: string, role = 'main', jobId: string | null = null): any => ({ id, role, jobId, connectionId: 'vertex', modelId: 'gemini-3.8-flash', status: 'completed',
  inputTokens: 1, outputTokens: 2, costUsd: null, priceRevision: null, error: null, response: {}, rawUsage: { trafficType: 'ON_DEMAND_FLEX' },
  request: { role, protocol: 'vertex-gemini-v1', connectionId: 'vertex', modelId: 'gemini-3.8-flash', method: 'POST',
    headers: { 'x-vertex-ai-llm-request-type': 'shared', 'x-vertex-ai-llm-shared-request-type': 'flex', 'x-server-timeout': '900' } } });
const mock = (): any => ({ id: 'mock', role: 'status', status: 'mock', connectionId: 'local-scripted', modelId: 'deterministic-fixture',
  request: { mock: true, input: {} }, inputTokens: null, outputTokens: null, costUsd: null, priceRevision: null, error: null, response: null, rawUsage: null });
function fixture(): any {
  const source = (id: string, parentRevision: string | null, runId: string) => ({ id, parentRevision, runId, text: id + ' story', hash: sourceHash(id + ' story'),
    blocks: ['a', 'b', 'c'].map(anchor => ({ anchor: id + anchor })) });
  const first = source('first', null, 'r-first'); const second = source('second', first.id, 'r-second');
  const profile = { routes: { main: { id: 'main', revision: 1 }, translation: { id: 'translation', revision: 1 } } };
  const snapshot = { branchId: 'main:chat', parentRevision: first.id, profile: { ...profile, models: { main: model('main'), translation: model('translation') } }, request: 'Continue.' };
  const chunks = (s: any, partial: boolean) => s.blocks.map((block: any, index: number) => ({
    id: s.id + '-chunk-' + index, status: partial && index < 2 ? 'failed' : 'completed', attempt: 1,
    input: { identity: s.id, index }, error: partial && index < 2 ? 'TRANSPORT_ERROR' : null, result: partial && index < 2 ? null : { segments: [{ anchors: [block.anchor], text: '보존된 번역 ' + block.anchor }] },
  }));
  const job = (s: any, partial: boolean) => ({ id: 'j-' + s.id, kind: 'translation', sourceRevision: s.id, sourceHash: s.hash, status: partial ? 'partial' : 'completed',
    generation: 1, revision: 1, error: partial ? 'TRANSPORT_ERROR' : null, chunks: chunks(s, partial),
    result: { mock: false, sourceRevision: s.id, sourceHash: s.hash, segments: (partial ? s.blocks.slice(2) : s.blocks).map((block: any) => ({ anchors: [block.anchor], text: '한국어 번역 ' + block.anchor })) } });
  return { chat: { id: 'chat', settings: { translation: true } }, profile, branches: [{ id: 'main:chat', default: true, headRevision: second.id }],
    sources: [first, second], runs: [{ id: first.runId, status: 'completed', sourceRevision: first.id, snapshot: { ...snapshot, parentRevision: null } },
      { id: second.runId, status: 'completed', sourceRevision: second.id, snapshot }], jobs: [job(first, false), job(second, true)], attempts: [native('old')] };
}
function recovered(before: any): any {
  const after = structuredClone(before); const target = after.jobs[1]; target.status = 'completed'; target.generation = 2; target.error = null;
  target.chunks = target.chunks.map((chunk: any, index: number) => index === 2 ? chunk : { ...chunk, status: 'completed', attempt: 2, error: null, result: { segments: [{ anchors: ['second' + ['a','b'][index]], text: '새 한국어 번역' }] } });
  target.result.segments = after.sources[1].blocks.map((block: any) => ({ anchors: [block.anchor], text: '한국어 번역' }));
  after.attempts.push(native('retry', 'translation', target.id)); return after;
}
function candidate(before: any): any {
  const after = structuredClone(before); const run = { ...structuredClone(before.runs[1]), id: 'candidate-run', sourceRevision: 'candidate-source' };
  run.snapshot = { ...run.snapshot, branchId: 'candidate-branch', candidateOf: before.runs[1].id };
  const source = { ...structuredClone(before.sources[1]), id: run.sourceRevision, runId: run.id };
  const translation = { ...structuredClone(before.jobs[1]), id: 'candidate-job', sourceRevision: source.id, generation: 1,
    result: { ...before.jobs[1].result, sourceRevision: source.id } };
  after.runs.push(run); after.sources.push(source); after.jobs.push(translation); after.attempts.push(native('candidate-main'), native('candidate-trans', 'translation', translation.id)); return after;
}
function retranslated(before: any): any {
  const after = structuredClone(before); const translation = structuredClone(before.jobs[0]); translation.id = 'first-retranslated'; translation.revision = 2;
  after.jobs.push(translation); after.attempts.push(native('first-new', 'translation', translation.id)); return after;
}

describe('live journey resume and evidence checks without network', () => {
  test('requires explicit resume and first-retranslation flags and does not default to execution', () => {
    expect(parseLiveJourneyOptions(['--source', 'old'])).toEqual({ source: 'old', execute: false, resumeChat: null, retranslateFirst: false });
    expect(parseLiveJourneyOptions(['--source', 'old', '--resume-chat', 'chat-id', '--retranslate-first', '--execute'])).toEqual({ source: 'old', execute: true, resumeChat: 'chat-id', retranslateFirst: true });
  });
  test.each([['--source'], ['--source','x','--resume-chat'], ['--source','x','--resume-chat','--execute'], ['--source','x','--retranslate-first'],
    ['--source','x','--execute','--execute'], ['--source','x','--resume-chat','chat','--resume-chat','chat'], ['--source','x','--retranslate-first','--retranslate-first']])('rejects ambiguous options %j', (...args: string[]) => {
    expect(() => parseLiveJourneyOptions(args)).toThrow();
  });
  test('imports but rejects all retired browser execution before page/network/file operations', async () => {
    await expect(runLiveJourney({ execute: false })).rejects.toThrow('LIVE_JOURNEY_LEGACY_CANDIDATE_UI_RETIRED');
    await expect(runLiveJourney({ execute: false, resumeChat: 'chat' })).rejects.toThrow('LIVE_JOURNEY_LEGACY_CANDIDATE_UI_RETIRED');
    await expect(runResumeJourney({ execute: false })).rejects.toThrow('LIVE_JOURNEY_LEGACY_CANDIDATE_UI_RETIRED');
  });
  test('counts native attempts separately from exact local mocks', () => {
    const before = [native('old')]; const after = [...before, native('fresh'), mock()];
    expect(summarizeJourneyAttempts(before, after, { requestCount: 1 }, { requestCount: 2 })).toMatchObject({
      additionalRequestCount: 1, totalRequestCount: 2, additionalAttemptCount: 2, localMockAttemptCount: 1, confirmedFlexResponseCount: 1,
    });
    expect(() => summarizeJourneyAttempts(before, after, { requestCount: 1 }, { requestCount: 3 })).toThrow('LIVE_JOURNEY_LEDGER_COUNT_MISMATCH');
  });
  test('keeps transport errors counted and explicitly marks missing response traffic', () => {
    const attempt = { ...native('failed'), status: 'error', error: 'TRANSPORT_ERROR', rawUsage: null };
    expect(summarizeJourneyAttempts([], [attempt], { requestCount: 0 }, { requestCount: 1 })).toMatchObject({ additionalRequestCount: 1, allResponseTrafficConfirmed: false, unconfirmedTrafficAttempts: [{ id: 'failed' }] });
  });
  test('does not hide malformed mock, foreign native protocol or standard response traffic', () => {
    expect(() => splitJourneyAttempts([{ ...mock(), inputTokens: 1 }])).toThrow('LIVE_JOURNEY_NON_VERTEX_ATTEMPT');
    const foreign = native('foreign'); foreign.request.protocol = 'openai-responses-v1';
    expect(() => splitJourneyAttempts([foreign])).toThrow('LIVE_JOURNEY_NON_VERTEX_ATTEMPT');
    const standard = native('standard'); standard.rawUsage.trafficType = 'ON_DEMAND';
    expect(() => summarizeJourneyAttempts([], [standard], { requestCount: 0 }, { requestCount: 1 })).toThrow('LIVE_JOURNEY_NON_FLEX_RESPONSE');
  });
  test('selects saved completed continuation with one reusable and two failed chunks', () => {
    const input = fixture(); const plan = selectResumePlan(input, 'chat');
    expect(plan.run.id).toBe('r-second'); expect(plan.completed.map((chunk: any) => chunk.id)).toEqual(['second-chunk-2']);
    expect(plan.failed.map((chunk: any) => chunk.id)).toEqual(['second-chunk-0', 'second-chunk-1']);
    plan.completed[0].attempt = 9; expect(input.jobs[1].chunks[2].attempt).toBe(1);
  });
  test('uses the model service tier and rejects missing or standard tier even with a legacy connection field', () => {
    const selected = model('main'); expect(() => validateJourneyModel(selected)).not.toThrow();
    for (const serviceTier of [undefined, 'standard']) {
      const outdated = { ...selected, serviceTier, connection: { ...selected.connection, requestTier: 'flex' } };
      expect(() => validateJourneyModel(outdated)).toThrow('LIVE_RESUME_REQUIRED_MODEL_UNAVAILABLE');
    }
  });
  test.each(['active', 'completed', 'candidate', 'model', 'hash'])('rejects changed resume state %s before a retry', mode => {
    const input = fixture();
    if (mode === 'active') input.jobs[1].status = 'running';
    if (mode === 'completed') input.jobs[1].status = 'completed';
    if (mode === 'candidate') input.runs.push({ id: 'already-candidate', status: 'completed', snapshot: { candidateOf: 'r-second' } });
    if (mode === 'model') input.runs[1].snapshot.profile.models.translation.timeoutMs = 300000;
    if (mode === 'hash') input.sources[1].text = 'changed';
    expect(() => selectResumePlan(input, 'chat')).toThrow();
  });
  test('accepts one failed-chunk generation while preserving completed chunks and old rows', () => {
    const before = fixture(); const after = recovered(before);
    expect(checkRetriedTranslation(selectResumePlan(before, 'chat'), before, after).translation.generation).toBe(2);
  });
  test.each(['completed-chunk', 'double-retry', 'source', 'other-job', 'wrong-target'])('rejects retry damage %s', mode => {
    const before = fixture(); const after = recovered(before);
    if (mode === 'completed-chunk') after.jobs[1].chunks[2].attempt++;
    if (mode === 'double-retry') after.jobs[1].chunks[0].attempt++;
    if (mode === 'source') after.sources[1].text = 'changed';
    if (mode === 'other-job') after.jobs[0].result.segments[0].text = 'changed';
    if (mode === 'wrong-target') after.attempts.at(-1).jobId = 'other';
    expect(() => checkRetriedTranslation(selectResumePlan(before, 'chat'), before, after)).toThrow();
  });
  test('accepts one sibling with original snapshot, source and completed translation intact', () => {
    const original = fixture(); const before = recovered(original); const after = candidate(before);
    expect(checkCandidatePreservation(selectResumePlan(original, 'chat'), before, after, 'candidate-run').source.parentRevision).toBe('first');
    after.runs.at(-1).snapshot.request = 'new request';
    expect(() => checkCandidatePreservation(selectResumePlan(original, 'chat'), before, after, 'candidate-run')).toThrow('LIVE_RESUME_CANDIDATE_SNAPSHOT_MISMATCH');
  });
  test('accepts a separate first-source translation revision with the old result intact', () => {
    const before = candidate(recovered(fixture())); const after = retranslated(before);
    expect(checkFirstRetranslation(before.sources[0], before, after, 'first-retranslated').translation.revision).toBe(2);
    after.jobs[0].result.segments[0].text = 'overwritten';
    expect(() => checkFirstRetranslation(before.sources[0], before, after, 'first-retranslated')).toThrow('LIVE_RESUME_RETRANSLATION_CHANGED_ORIGINAL');
  });
});



test('retired CLI preflight and execute stop before source validation, copying, authentication or provider work', () => {
  const script = fileURLToPath(new URL('../scripts/verify-live-journey.mjs', import.meta.url));
  for (const args of [[], ['--execute', '--source', 'THIS_SOURCE_MUST_NEVER_BE_OPENED']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'BLOCKED', legacy: true, mode: args.length ? 'execute' : 'preflight', code: 'LIVE_JOURNEY_LEGACY_CANDIDATE_UI_RETIRED', preflight: { ready: false, sourceRead: false, databaseCopied: false, authenticationAttempted: false, networkRequests: 0 } });
  }
});

test('explicit execute cannot reactivate either retired browser path', async () => {
  const page = new Proxy({}, { get: () => { throw Error('PAGE_MUST_NOT_BE_USED'); } });
  await expect(runLiveJourney({ execute: true, page })).rejects.toThrow('LIVE_JOURNEY_LEGACY_CANDIDATE_UI_RETIRED');
  await expect(runLiveJourney({ execute: true, page, resumeChat: 'chat' })).rejects.toThrow('LIVE_JOURNEY_LEGACY_CANDIDATE_UI_RETIRED');
  await expect(runResumeJourney({ execute: true, page })).rejects.toThrow('LIVE_JOURNEY_LEGACY_CANDIDATE_UI_RETIRED');
});
