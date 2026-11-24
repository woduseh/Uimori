import { t, useI18n, translateMessage, formatNumber, message as uiMessage } from './i18n.js';
import { useState, type ReactNode } from 'react';
import type { Job, ReaderRun, Run } from '../core/types.js';
import { api, labels } from './api.js';
import { ContextSummaryStatus } from './ContextSummaryStatus.js';
import { LazyDiagnostics } from './LazyDiagnostics.js';
import { LoadingState } from './LoadingState.js';
import { LoreContextDiagnostics } from './LoreContextDiagnostics.js';
import { ProviderRejectionNotice } from './provider-rejection.js';
import { JobCard } from './SourceReader.js';
import { mainJudgmentError } from './main-judgment-error.js';
import { SceneUsage } from './SceneUsage.js';
import { PartialResponse, StreamingResponse } from './StreamingResponse.js';
import { CopyTextButton, TaskHistorySection } from './TaskHistory.js';
import { RunAttempts } from './AttemptInspector.js';
import { formatUsd } from './pricing-display.js';
import { useRetryableEffect } from './useRetryableEffect.js';
import './run-task-details.css';

type RunJob = Pick<Job, 'id' | 'sourceRevision' | 'kind' | 'status' | 'error' | 'attempt'>;

function LoreSelectionStatus({ snapshot }: { snapshot: Run['snapshot'] }) {
  useI18n();
  const receipt = snapshot.loreSelection;
  if (!receipt?.entries.length) return null;
  const chars = (key: string, ids: string[]) => {
    const [reference, role] = key.split(':');
    const prefix = `package:${reference.split('@')[0]}:${role}:lore:`;
    return ids.reduce(
      (total, id) =>
        total + (snapshot.resources.find((item) => item.id === `${prefix}${id}`)?.text.length ?? 0),
      0
    );
  };
  return (
    <ul className="muted" aria-label={t('visuals.m273')}>
      {receipt.entries.map((entry) => (
        <li key={entry.key}>
          {entry.error
            ? t('visuals.m274', { v0: entry.error })
            : t('visuals.m275', {
                v0: entry.selected.length,
                v1: formatNumber(chars(entry.key, entry.selected)),
                v2: formatNumber(entry.budget),
                v3: entry.omitted.length,
              })}
        </li>
      ))}
    </ul>
  );
}

export function RunNotices({
  run,
  readyContext = true,
}: {
  run: ReaderRun;
  readyContext?: boolean;
}) {
  useI18n();
  if (run.packageStart?.mode === 'authored') return null;
  const showError =
    run.error &&
    !(run.status === 'cancelled' && run.error === 'Run cancelled') &&
    !(run.contextSummary?.status === 'failed' && run.contextSummary.error === run.error);
  return (
    <>
      {(readyContext || run.contextSummary?.status !== 'ready') && (
        <ContextSummaryStatus summary={run.contextSummary} />
      )}
      {showError && <p className="error">{mainJudgmentError(run.error) ?? run.error}</p>}
      {run.rejection && <ProviderRejectionNotice rejection={run.rejection} />}
      {run.status === 'refused' && <p className="error">{t('visuals.m278')}</p>}
    </>
  );
}

export function RunCancelButton({
  run,
  refresh,
  onError,
}: {
  run: Pick<ReaderRun, 'id' | 'status'>;
  refresh: () => Promise<void>;
  onError: (message: string) => void;
}) {
  useI18n();
  const [cancelling, setCancelling] = useState(false);
  if (!['queued', 'running'].includes(run.status)) return null;
  return (
    <button
      type="button"
      className="secondary"
      disabled={cancelling}
      onClick={async () => {
        if (cancelling) return;
        setCancelling(true);
        onError('');
        try {
          await api(`/runs/${run.id}/cancel`, {});
          await refresh();
        } catch (error) {
          onError((error as Error).message);
        } finally {
          setCancelling(false);
        }
      }}
    >
      {t('visuals.m283')}
    </button>
  );
}

function RunJobs({
  run,
  jobs,
  inlineJobs,
  revision,
  refresh,
  onError,
  disclosure,
}: {
  run: ReaderRun;
  jobs: RunJob[];
  inlineJobs?: Job[];
  revision: number;
  refresh: () => Promise<void>;
  onError: (message: string) => void;
  disclosure: boolean;
}) {
  useI18n();
  const items = jobs
    .filter((job) => run.sourceRevision && job.sourceRevision === run.sourceRevision)
    .map((job) => {
      const inline = inlineJobs?.find((item) => item.id === job.id);
      return inline ? (
        <JobCard key={job.id} job={inline} refresh={refresh} onError={onError} hideText />
      ) : (
        <LazyDiagnostics<Job>
          key={job.id}
          path={`/jobs/${job.id}`}
          revision={revision}
          disclosure={disclosure}
          title={t('visuals.m284', {
            v0: {
              translation: t('visuals.translation'),
              image: t('visuals.image'),
              status: t('visuals.legacyJob'),
            }[job.kind],
            v1: translateMessage(labels[job.status]),
          })}
        >
          {(full) => <JobCard job={full} refresh={refresh} onError={onError} hideText />}
        </LazyDiagnostics>
      );
    });
  return <>{items}</>;
}

const usageAmount = (value: number | null) =>
  value == null ? t('visuals.m165') : formatNumber(value);

function runUsageText(run: Pick<Run, 'id' | 'usage'>) {
  return t('visuals.runUsage', {
    id: run.id,
    calls: formatNumber(run.usage.modelCalls),
    input: usageAmount(run.usage.inputTokens),
    output: usageAmount(run.usage.outputTokens),
    cost:
      run.usage.costUsd == null
        ? t('visuals.m165')
        : formatNumber(run.usage.costUsd, { style: 'currency', currency: 'USD' }),
  });
}

export function runEstimatedCost(estimate: ReaderRun['estimatedCost']) {
  if (!estimate) return null;
  if (estimate.usd !== null) return formatUsd(estimate.usd);
  if (estimate.subtotalUsd > 0)
    return t('visualpanels.knownSubtotalIncludesUnknownItemsInCalls', {
      v0: formatUsd(estimate.subtotalUsd),
      v1: estimate.unknownCount,
    });
  return t('visualpanels.unknown');
}

const rawRecord = (full: Run) =>
  JSON.stringify(
    { snapshot: full.snapshot, inputs: full.inputs, toolEvents: full.toolEvents },
    null,
    2
  );

function useRunRecord(runId: string, revision: number, enabled: boolean) {
  const [record, setRecord] = useState<{ id: string; value: Run | null; error: string }>({
    id: runId,
    value: null,
    error: '',
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: The full record reloads for the same run when the reader revision changes.
  const retry = useRetryableEffect(() => {
    if (!enabled) return;
    let alive = true;
    setRecord((old) => ({ id: runId, value: old.id === runId ? old.value : null, error: '' }));
    void api<Run>(`/runs/${runId}`)
      .then((value) => {
        if (alive) setRecord({ id: runId, value, error: '' });
      })
      .catch((error) => {
        if (alive)
          setRecord((old) => ({ id: runId, value: old.value, error: (error as Error).message }));
      });
    return () => {
      alive = false;
    };
  }, [runId, revision, enabled]);
  const current = record.id === runId ? record : { value: null, error: '' };
  return { value: current.value, error: current.error, retry };
}

function RunRecordLoading({ error, retry }: { error: string; retry: () => void }) {
  useI18n();
  return (
    <LoadingState
      presentation="inline"
      loading={!error}
      error={error}
      label={t('shared.loadingDetails')}
      onRetry={retry}
    />
  );
}

function RunTaskSections({
  run,
  jobs,
  revision,
  refresh,
  onError,
  children,
}: {
  run: ReaderRun;
  jobs: RunJob[];
  revision: number;
  refresh: () => Promise<void>;
  onError: (message: string) => void;
  children?: ReactNode;
}) {
  useI18n();
  const authored = run.packageStart?.mode === 'authored';
  const record = useRunRecord(run.id, revision, !authored);
  const [rawOpen, setRawOpen] = useState(false);
  const settled = !['queued', 'running'].includes(run.status);
  const partial = !authored && settled && run.partialText;
  const cancelledStream =
    !authored && run.status === 'cancelled' && !run.partialText && !run.sourceRevision;
  const estimated = runEstimatedCost(run.estimatedCost);
  const hasJobs = jobs.some(
    (job) => run.sourceRevision && job.sourceRevision === run.sourceRevision
  );
  const runJobs = (
    <RunJobs
      run={run}
      jobs={jobs}
      revision={revision}
      refresh={refresh}
      onError={onError}
      disclosure={false}
    />
  );
  return (
    <div className="run-task-details task-history-sections">
      {(partial || cancelledStream || children) && (
        <TaskHistorySection
          title={t('visuals.historyResult')}
          actions={
            partial && (
              <CopyTextButton
                text={() => run.partialText!}
                label={t('visuals.m282')}
                copiedLabel={t('visuals.m281')}
                onFailure={() => onError(uiMessage('visuals.m280'))}
              />
            )
          }
        >
          {partial && (
            <div className="partial-result">
              <p>{t('visuals.m279')}</p>
              <pre>{run.partialText}</pre>
            </div>
          )}
          {cancelledStream && (
            <PartialResponse>
              <StreamingResponse taskKind="main" taskId={run.id} taskStatus={run.status} settled />
            </PartialResponse>
          )}
          {children}
        </TaskHistorySection>
      )}
      {(!authored || hasJobs) && (
        <TaskHistorySection title={t('visuals.historySteps')}>
          {!authored && run.contextSummary?.status === 'ready' && (
            <ContextSummaryStatus summary={run.contextSummary} />
          )}
          {runJobs}
          {!authored &&
            (record.value ? (
              <>
                <LoreContextDiagnostics
                  snapshot={record.value.snapshot.loreContext}
                  reset={record.value.snapshot.loreContextReset}
                />
                <LoreSelectionStatus snapshot={record.value.snapshot} />
              </>
            ) : (
              <RunRecordLoading error={record.error} retry={record.retry} />
            ))}
        </TaskHistorySection>
      )}
      {!authored && (
        <TaskHistorySection title={t('visuals.historyCalls')}>
          <p>{runUsageText(run)}</p>
          {estimated && <p>{t('visualpanels.estimatedCost', { v0: estimated })}</p>}
          {run.sourceRevision && <SceneUsage usage={run.sceneUsage} />}
          <RunAttempts chatId={run.chatId} runId={run.id} revision={revision} />
        </TaskHistorySection>
      )}
      {!authored && (
        <TaskHistorySection
          title={t('visuals.historyRaw')}
          actions={
            record.value && (
              <>
                <button
                  type="button"
                  className="secondary"
                  aria-expanded={rawOpen}
                  onClick={() => setRawOpen((old) => !old)}
                >
                  {rawOpen ? t('visuals.historyRawHide') : t('visuals.historyRawShow')}
                </button>
                <CopyTextButton
                  text={() => rawRecord(record.value!)}
                  label={t('visuals.historyCopy')}
                  copiedLabel={t('visuals.historyCopied')}
                  onFailure={() => onError(uiMessage('visuals.historyCopyFailed'))}
                />
              </>
            )
          }
        >
          {record.value ? (
            rawOpen && <pre className="task-history-raw">{rawRecord(record.value)}</pre>
          ) : (
            <RunRecordLoading error={record.error} retry={record.retry} />
          )}
        </TaskHistorySection>
      )}
    </div>
  );
}

export function RunTaskDetails({
  run,
  jobs,
  inlineJobs,
  revision,
  refresh,
  onError,
  children,
  afterJobs,
  initiallyInspect = false,
  presentation = 'detail',
}: {
  run: ReaderRun;
  jobs: RunJob[];
  inlineJobs?: Job[];
  revision: number;
  refresh: () => Promise<void>;
  onError: (message: string) => void;
  children?: ReactNode;
  afterJobs?: ReactNode;
  initiallyInspect?: boolean;
  presentation?: 'detail' | 'sections';
}) {
  useI18n();
  const [copiedOutput, setCopiedOutput] = useState(false);
  if (presentation === 'sections')
    return (
      <RunTaskSections
        run={run}
        jobs={jobs}
        revision={revision}
        refresh={refresh}
        onError={onError}
      >
        {children}
      </RunTaskSections>
    );
  const authored = run.packageStart?.mode === 'authored';
  const canCancel = ['queued', 'running'].includes(run.status);
  return (
    <div className="run-task-details">
      {!authored && (
        <>
          <div className="task-heading">
            <strong>{t('visuals.m276', { v0: translateMessage(labels[run.status]) })}</strong>
            <small>{run.modelTitle || t('visuals.m277')}</small>
          </div>
          <RunNotices run={run} />
          {!canCancel && run.partialText && (
            <details className="partial-result">
              <summary>{t('visuals.m279')}</summary>
              <div className="form-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={async () => {
                    onError('');
                    try {
                      await navigator.clipboard.writeText(run.partialText!);
                      setCopiedOutput(true);
                    } catch {
                      onError(uiMessage('visuals.m280'));
                    }
                  }}
                >
                  {copiedOutput ? t('visuals.m281') : t('visuals.m282')}
                </button>
              </div>
              <pre>{run.partialText}</pre>
            </details>
          )}
          {run.status === 'cancelled' && !run.partialText && !run.sourceRevision && (
            <PartialResponse>
              <StreamingResponse taskKind="main" taskId={run.id} taskStatus={run.status} settled />
            </PartialResponse>
          )}
          {canCancel && (
            <div className="form-actions">
              <RunCancelButton run={run} refresh={refresh} onError={onError} />
            </div>
          )}
        </>
      )}
      {children}
      <RunJobs
        run={run}
        jobs={jobs}
        inlineJobs={inlineJobs}
        revision={revision}
        refresh={refresh}
        onError={onError}
        disclosure
      />
      {afterJobs}
      {!authored && (
        <div className="run-input-details">
          {run.sourceRevision && (
            <SceneUsage usage={run.sceneUsage} estimatedCost={run.estimatedCost} />
          )}
          <LazyDiagnostics<Run>
            path={`/runs/${run.id}`}
            revision={revision}
            initiallyOpen={initiallyInspect}
            title={t('visuals.m285')}
          >
            {(full) => (
              <>
                <p>{runUsageText(full)}</p>
                <LoreContextDiagnostics
                  snapshot={full.snapshot.loreContext}
                  reset={full.snapshot.loreContextReset}
                />
                <LoreSelectionStatus snapshot={full.snapshot} />
                <details className="run-raw-record">
                  <summary>{t('visualpanels.rawExecutionRecord')}</summary>
                  <pre>{rawRecord(full)}</pre>
                </details>
              </>
            )}
          </LazyDiagnostics>
        </div>
      )}
    </div>
  );
}
