import { rejectRetiredLiveJourney } from './retired-live-journey.mjs';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { root } from './lib.mjs';
import { checkJourney as check, sameJourney as same, activeJourney as active, sourceHash, selectResumePlan,
  checkRetriedTranslation, checkCandidatePreservation, checkFirstRetranslation, checkTranslationComplete } from './live-journey-evidence.mjs';

const safeCode = error => /^[A-Z0-9_]+$/u.test(error?.code ?? '') ? error.code : 'LIVE_RESUME_FAILED';
const ref = model => ({ id: model.id, revision: model.revision });

/** Import is inert. The runner alone owns copied evidence, processes and budget. */
export async function runResumeJourney({ execute = false, page, baseURL, output, resumeChat, retranslateFirst = false,
  referenceEvidence, timeoutMs = 1800000, onCheckpoint = async () => {} }) {
  rejectRetiredLiveJourney();
  check(execute === true, 'LIVE_BROWSER_EXPLICIT_EXECUTE_REQUIRED');
  check(process.env.NR_VERTEX_REQUEST_TIER === 'flex' && process.env.NR_LIVE_MAX_REQUESTS === '1000' &&
    process.env.NR_LIVE_MAX_USD === '100', 'LIVE_BROWSER_APPROVED_LIMITS_REQUIRED');
  check(typeof resumeChat === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(resumeChat) &&
    typeof retranslateFirst === 'boolean' && referenceEvidence?.chatId === resumeChat &&
    /^[a-f0-9]{64}$/u.test(referenceEvidence.summarySha256 ?? ''), 'LIVE_RESUME_REFERENCE_REQUIRED');
  const origin = new URL(baseURL);
  check(origin.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(origin.hostname) && !origin.username &&
    !origin.password && !origin.search && !origin.hash, 'LIVE_BROWSER_LOOPBACK_APP_REQUIRED');
  const directory = path.resolve(output); const relative = path.relative(path.join(root, 'output', 'live'), directory);
  check(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'LIVE_BROWSER_OUTPUT_OUTSIDE_EVIDENCE');
  check(page && Number.isSafeInteger(timeoutMs) && timeoutMs >= 30000 && timeoutMs <= 3600000, 'LIVE_BROWSER_ARGUMENTS_INVALID');
  await mkdir(directory, { recursive: true }); await mkdir(path.join(directory, 'screenshots'), { recursive: true });
  const summary = { schema: 1, mode: 'execute', status: 'RUNNING', scope: 'Resume the saved synthetic Vertex Flex story through the actual UI',
    startedAt: new Date().toISOString(), resumedFrom: referenceEvidence, retranslateFirst, steps: [], sources: [], screenshots: [], failures: [],
    quality: 'NOT_REVIEWED', cleanup: { status: 'NOT_RUN', scope: 'Restore viewport and detach listeners; caller owns browser/server/DB cleanup' },
    limitations: ['Initial bot, persona, preset and first-scene steps are referenced from the original evidence and are not repeated.',
      'Only one failed-chunk retry action and one candidate action are allowed. An optional first-source retranslation requires its explicit flag.',
      'A failed action is not retried automatically. Provider calls within one authorized job can include tool rounds and multiple unfinished chunks.',
      'Mechanical coverage and Korean-text checks do not assess translation or literary quality. Browser viewports do not establish physical-phone behavior.',
      'Earlier transport errors and uncertain billing remain in the shared ledger. This run does not relabel the original failure.'] };
  const originalViewport = page.viewportSize(); const mutations = []; const pageErrors = [];
  const onError = () => pageErrors.push({ at: new Date().toISOString() });
  const onRequest = request => {
    const url = new URL(request.url());
    if (url.origin !== origin.origin || !url.pathname.startsWith('/api/') || ['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return;
    let body; try { body = request.postDataJSON(); } catch { body = null; }
    mutations.push({ method: request.method(), path: url.pathname, body });
  };
  page.on('pageerror', onError); page.on('request', onRequest);
  let currentStep = 'preflight'; let record; let plan;
  const checkpoint = async () => { await writeFile(path.join(directory, 'journey-summary.json'), JSON.stringify(summary, null, 2)); await onCheckpoint(structuredClone(summary)); };
  const api = async route => { const response = await page.request.get(origin.origin + '/api' + route, { timeout: 15000 }); check(response.ok(), 'LIVE_RESUME_APP_HTTP_' + response.status()); return response.json(); };
  const detail = () => api('/chats/' + encodeURIComponent(resumeChat));
  const capture = async name => {
    const file = String(summary.screenshots.length + 1).padStart(2, '0') + '-' + name + '.png';
    await page.screenshot({ path: path.join(directory, 'screenshots', file) });
    summary.screenshots.push({ file: 'screenshots/' + file, step: currentStep, viewport: page.viewportSize(), at: new Date().toISOString() }); await checkpoint();
  };
  const step = async (name, operation) => {
    currentStep = name; record = { name, status: 'RUNNING', startedAt: new Date().toISOString() }; summary.steps.push(record); await checkpoint();
    const result = await operation(); record.status = 'PASS'; record.finishedAt = new Date().toISOString(); await checkpoint(); return result;
  };
  const waitFor = async (get, predicate, code) => {
    const deadline = Date.now() + timeoutMs; let heartbeat = Date.now();
    while (Date.now() < deadline) { const value = await get(); if (predicate(value)) return value;
      if (Date.now() - heartbeat >= 20000) { heartbeat = Date.now(); await checkpoint(); } await delay(1000); }
    check(false, code);
  };
  const sourceView = source => page.locator('[data-testid="source"][data-source-id="' + source.id + '"]');
  const assertActions = paths => {
    check(same(mutations.map(item => item.method + ' ' + item.path), paths.map(item => 'POST ' + item)), 'LIVE_RESUME_UNEXPECTED_OR_REPEATED_ACTION');
  };
  const clickOnce = async (button, urlPath) => {
    const [response] = await Promise.all([page.waitForResponse(item => new URL(item.url()).pathname === urlPath && item.request().method() === 'POST', { timeout: 20000 }), button.click()]);
    check(response.ok(), 'LIVE_RESUME_ACTION_HTTP_' + response.status()); return response.json();
  };
  const waitJob = async (jobId, generation) => waitFor(detail, value => {
    const job = value.jobs.find(item => item.id === jobId); check(job, 'LIVE_RESUME_JOB_MISSING');
    if (job.generation < generation || active(job.status)) return false;
    check(job.status === 'completed', /^[A-Z0-9_]+$/u.test(job.error ?? '') ? job.error : 'LIVE_RESUME_TRANSLATION_INCOMPLETE');
    return !value.jobs.some(item => active(item.status));
  }, 'LIVE_RESUME_TRANSLATION_TIMEOUT');
  const writeArtifact = async (label, source, translation, text, translationFilename = label + '-translation.txt') => {
    check(sourceHash(source.text) === source.hash, 'LIVE_RESUME_SOURCE_HASH_MISMATCH');
    const words = source.text.trim().split(/\s+/u).filter(Boolean).length; check(words >= 1000, 'LIVE_RESUME_LONG_SOURCE_TOO_SHORT');
    await writeFile(path.join(directory, label + '-source.txt'), source.text);
    await writeFile(path.join(directory, translationFilename), text);
    summary.sources.push({ label, sourceId: source.id, sourceHash: source.hash, parentRevision: source.parentRevision, words,
      requestedWords: { min: 1000, max: 1400 }, withinRequestedRange: words >= 1000 && words <= 1400,
      translationJobId: translation.id, translationRevision: translation.revision, chunks: translation.chunks.length,
      anchors: translation.result.segments.flatMap(segment => segment.anchors).length, translationFile: translationFilename });
    const rendered = sourceView(source); await rendered.waitFor(); await rendered.getByRole('button', { name: '번역 보기', exact: true }).click();
    await rendered.getByTestId('translation-text').waitFor();
    check(/[가-힣]/u.test(await rendered.getByTestId('translation-text').innerText()), 'LIVE_RESUME_TRANSLATION_NOT_RENDERED');
  };
  try {
    const health = await api('/health'); check(health.liveBudgetConfigured && health.vertexRequestTier === 'flex', 'LIVE_RESUME_SERVER_BUDGET_REQUIRED');
    const initial = await detail(); plan = selectResumePlan(initial, resumeChat); summary.chat = { id: initial.chat.id, title: initial.chat.title };
    const library = await api('/library');
    for (const role of ['main', 'translation']) {
      const model = plan.run.snapshot.profile.models[role]; const saved = library.models.find(item => same(ref(item), ref(model)));
      const connection = library.connections.find(item => item.id === model.connection.id);
      check(saved && same(saved, Object.fromEntries(Object.entries(model).filter(([key]) => key !== 'connection'))) &&
        connection?.enabled && connection.revision === model.connection.revision && connection.protocol === 'vertex-gemini-v1' &&
        connection.requestTier === 'flex' && connection.endpoint === model.connection.endpoint, 'LIVE_RESUME_REQUIRED_MODEL_UNAVAILABLE');
      summary[role + 'Model'] = { ...ref(model), title: model.title, protocol: connection.protocol, requestTier: connection.requestTier };
    }
    const retryPath = '/api/jobs/' + plan.translation.id + '/retry';
    const candidatePath = '/api/runs/' + plan.run.id + '/candidate';
    await step('open_saved_story_without_generation', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(origin.origin + '/?chat=' + encodeURIComponent(resumeChat) + '&source=' + encodeURIComponent(plan.source.id));
      await page.getByLabel('다음 장면 요청').waitFor(); await sourceView(plan.source).waitFor();
      const opened = await detail(); check(same(opened.runs, initial.runs) && same(opened.sources, initial.sources) &&
        same(opened.jobs, initial.jobs) && same(opened.attempts, initial.attempts), 'LIVE_RESUME_OPEN_EXECUTED_MODEL');
      assertActions([]); await capture('saved-partial-translation-mobile');
    });
    const recovered = await step('retry_only_failed_translation_chunks_once', async () => {
      const button = sourceView(plan.source).locator('.derived-summary [data-job-id="' + plan.translation.id + '"]').getByRole('button', { name: '번역만 다시 시도', exact: true });
      const accepted = await clickOnce(button, retryPath); check(accepted.id === plan.translation.id, 'LIVE_RESUME_WRONG_RETRY_JOB');
      assertActions([retryPath]); check(same(mutations[0].body, {}), 'LIVE_RESUME_RETRY_BODY_MISMATCH');
      await capture('failed-chunks-retry-pending-mobile');
      const after = await waitJob(plan.translation.id, plan.translation.generation + 1);
      const result = checkRetriedTranslation(plan, initial, after); assertActions([retryPath]);
      record.retryActions = 1; record.reusedCompletedChunkIds = plan.completed.map(chunk => chunk.id); record.retriedChunkIds = plan.failed.map(chunk => chunk.id);
      await writeArtifact('continued-recovered', plan.source, result.translation, result.text);
      await page.setViewportSize({ width: 1440, height: 1000 }); await sourceView(plan.source).scrollIntoViewIfNeeded(); await capture('continued-recovered-desktop');
      return after;
    });
    const candidate = await step('create_one_sibling_candidate', async () => {
      const accepted = await clickOnce(sourceView(plan.source).getByRole('button', { name: '다른 응답', exact: true }), candidatePath);
      check(accepted.id && accepted.id !== plan.run.id && accepted.snapshot?.candidateOf === plan.run.id, 'LIVE_RESUME_WRONG_CANDIDATE_RUN');
      assertActions([retryPath, candidatePath]); await capture('candidate-pending-desktop');
      const settled = await waitFor(detail, value => {
        const run = value.runs.find(item => item.id === accepted.id); check(run, 'LIVE_RESUME_CANDIDATE_RUN_MISSING');
        if (active(run.status)) return false;
        check(run.status === 'completed', /^[A-Z0-9_]+$/u.test(run.error ?? '') ? run.error : 'LIVE_RESUME_CANDIDATE_INCOMPLETE');
        const translation = value.jobs.findLast(job => job.sourceRevision === run.sourceRevision && job.kind === 'translation');
        if (!translation || active(translation.status)) return false;
        check(translation.status === 'completed', /^[A-Z0-9_]+$/u.test(translation.error ?? '') ? translation.error : 'LIVE_RESUME_CANDIDATE_TRANSLATION_INCOMPLETE');
        return !value.jobs.some(job => active(job.status));
      }, 'LIVE_RESUME_CANDIDATE_TIMEOUT');
      const result = checkCandidatePreservation(plan, recovered, settled, accepted.id); assertActions([retryPath, candidatePath]);
      record.candidateActions = 1; record.preservedRunId = plan.run.id; record.candidateRunId = result.run.id; record.preservedSourceHash = plan.source.hash;
      await page.setViewportSize({ width: 390, height: 844 }); await writeArtifact('candidate', result.source, result.translation, result.text);
      await sourceView(result.source).scrollIntoViewIfNeeded(); await capture('candidate-korean-mobile'); return { ...result, detail: settled };
    });
    await step('switch_siblings_and_source_views_without_generation', async () => {
      const choose = async branch => {
        await page.getByRole('button', { name: '다른 전개', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: '다른 전개', exact: true });
        check(await dialog.locator('.dialog-body').evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'LIVE_RESUME_BRANCH_HORIZONTAL_OVERFLOW');
        await page.getByLabel('읽고 이어갈 분기').selectOption(branch);
        await page.getByRole('button', { name: '선택한 전개 읽기', exact: true }).click();
      };
      await choose(''); const original = sourceView(plan.source); await original.waitFor();
      await original.getByRole('button', { name: '원문 보기', exact: true }).click(); await original.getByTestId('source-text').waitFor();
      await capture('preserved-continued-original-mobile');
      await original.getByRole('button', { name: '번역 보기', exact: true }).click(); await original.getByTestId('translation-text').waitFor();
      await choose(candidate.run.snapshot.branchId); await sourceView(candidate.source).waitFor();
      const after = await detail(); check(same(after.runs, candidate.detail.runs) && same(after.sources, candidate.detail.sources) &&
        same(after.jobs, candidate.detail.jobs) && same(after.attempts, candidate.detail.attempts), 'LIVE_RESUME_SWITCH_EXECUTED_MODEL');
      assertActions([retryPath, candidatePath]); record.modelRequestsAdded = 0; await capture('returned-candidate-mobile');
    });
    if (retranslateFirst) await step('retranslate_first_source_once_preserving_previous_revision', async () => {
      const before = await detail(); let first = plan.source;
      while (first.parentRevision) { const parent = before.sources.find(item => item.id === first.parentRevision); check(parent, 'LIVE_RESUME_FIRST_SOURCE_MISSING'); first = parent; }
      check(first.id !== plan.source.id, 'LIVE_RESUME_FIRST_SOURCE_MISSING');
      const firstRun = before.runs.find(run => run.id === first.runId); check(firstRun?.status === 'completed', 'LIVE_RESUME_FIRST_RUN_MISSING');
      const pathName = '/api/sources/' + first.id + '/retranslate';
      await page.getByRole('button', { name: '다른 전개', exact: true }).click();
      await page.getByLabel('읽고 이어갈 분기').selectOption('');
      await page.getByLabel('읽을 원문').selectOption(first.id);
      await page.getByRole('button', { name: '선택한 전개 읽기', exact: true }).click();
      const displayed = sourceView(first); await displayed.waitFor();
      const accepted = await clickOnce(displayed.getByRole('button', { name: '다시 번역', exact: true }), pathName);
      check(accepted.id && !before.jobs.some(job => job.id === accepted.id), 'LIVE_RESUME_NEW_TRANSLATION_REQUIRED');
      assertActions([retryPath, candidatePath, pathName]); await capture('first-source-retranslation-pending-mobile');
      const settled = await waitJob(accepted.id, 1); const result = checkFirstRetranslation(first, before, settled, accepted.id);
      assertActions([retryPath, candidatePath, pathName]); check(same(mutations[2].body, {}), 'LIVE_RESUME_RETRANSLATION_BODY_MISMATCH');
      record.retranslationActions = 1; record.preservedSourceId = first.id; record.preservedRunId = firstRun.id;
      record.preservedJobIds = before.jobs.filter(job => job.sourceRevision === first.id).map(job => job.id);
      // The reader deliberately keeps the old revision selected until the user chooses the new revision.
      await displayed.getByText('번역 버전', { exact: true }).click();
      await displayed.getByLabel('번역 revision').selectOption(result.translation.id);
      check(await displayed.getByLabel('번역 revision').inputValue() === result.translation.id, 'LIVE_RESUME_TRANSLATION_REVISION_NOT_SELECTED');
      await writeArtifact('first-retranslated', first, result.translation, result.text, 'first-retranslated.txt');
      await capture('first-source-new-translation-mobile');
    });
    check(pageErrors.length === 0, 'LIVE_RESUME_PAGE_ERROR'); summary.status = 'PASS';
  } catch (error) {
    const code = safeCode(error); if (record) { record.status = 'FAIL'; record.error = code; record.finishedAt = new Date().toISOString(); }
    summary.failures.push({ step: currentStep, code }); summary.status = /BUDGET|AUTH|CREDENTIAL|UNAVAILABLE/u.test(code) ? 'BLOCKED' : /TIMEOUT/u.test(code) ? 'INCOMPLETE' : 'FAIL';
    try { await capture('failure'); } catch { summary.failures.push({ step: currentStep, code: 'LIVE_RESUME_FAILURE_SCREENSHOT_UNAVAILABLE' }); }
    try { const value = await detail(); summary.failureState = { chatId: resumeChat, runs: value.runs.map(run => ({ id: run.id, status: run.status, sourceRevision: run.sourceRevision, error: run.error })),
      jobs: value.jobs.map(job => ({ id: job.id, kind: job.kind, status: job.status, sourceRevision: job.sourceRevision, error: job.error })),
      attempts: value.attempts.map(attempt => ({ id: attempt.id, role: attempt.role, status: attempt.status, error: attempt.error })) }; }
    catch { summary.failures.push({ step: currentStep, code: 'LIVE_RESUME_FAILURE_STATE_UNAVAILABLE' }); }
  } finally {
    page.off('pageerror', onError); page.off('request', onRequest);
    summary.userActions = mutations.map(item => ({ method: item.method, path: item.path, bodyKeys: Object.keys(item.body ?? {}) }));
    try { await page.setViewportSize(originalViewport ?? { width: 1440, height: 1000 }); summary.cleanup.status = 'PASS'; }
    catch { summary.cleanup.status = 'FAIL'; if (summary.status === 'PASS') summary.status = 'FAIL'; }
    summary.pageErrorCount = pageErrors.length; summary.finishedAt = new Date().toISOString(); await checkpoint();
  }
  return summary;
}

