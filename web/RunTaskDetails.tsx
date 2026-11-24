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
import { useApiRecord } from './useApiRecord.js';
import './run-task-details.css';

type RunJob = Pick<Job, 'id' | 'sourceRevision' | 'kind' | 'status' | 'error' | 'attempt'>;

export function LoreSelectionStatus({ snapshot }: { snapshot: Run['snapshot'] }) {
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
  revision,
  refresh,
  onError,
}: {
  run: ReaderRun;
  jobs: RunJob[];
  revision: number;
  refresh: () => Promise<void>;
  onError: (message: string) => void;
}) {
  useI18n();
  return (
    <>
      {jobs
        .filter((job) => run.sourceRevision && job.sourceRevision === run.sourceRevision)
        .map((job) => (
          <LazyDiagnostics<Job>
            key={job.id}
            path={`/jobs/${job.id}`}
            revision={revision}
            disclosure={false}
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
        ))}
    </>
  );
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

function runEstimatedCost(estimate: ReaderRun['estimatedCost']) {
  if (!estimate) return null;
  if (estimate.usd !== null) return formatUsd(estimate.usd);
  if (estimate.subtotalUsd > 0)
    return t('visualpanels.knownSubtotalIncludesUnknownItemsInCalls', {
      v0: formatUsd(estimate.subtotalUsd),
      v1: estimate.unknownCount,
    });
  return t('visualpanels.unknown');
}

export const rawRunRecord = (full: Run) =>
  JSON.stringify(
    { snapshot: full.snapshot, inputs: full.inputs, toolEvents: full.toolEvents },
    null,
    2
  );

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

export function RunTaskDetails({
  run,
  jobs,
  revision,
  refresh,
  onError,
  resultActions,
}: {
  run: ReaderRun;
  jobs: RunJob[];
  revision: number;
  refresh: () => Promise<void>;
  onError: (message: string) => void;
  resultActions?: ReactNode;
}) {
  useI18n();
  const authored = run.packageStart?.mode === 'authored';
  const record = useApiRecord<Run>(`/runs/${run.id}`, revision, !authored);
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
    <RunJobs run={run} jobs={jobs} revision={revision} refresh={refresh} onError={onError} />
  );
  return (
    <div className="run-task-details task-history-sections">
      {(partial || cancelledStream || resultActions) && (
        <TaskHistorySection
          title={t('visuals.historyResult')}
          actions={
            (partial || resultActions) && (
              <>
                {partial && (
                  <CopyTextButton
                    text={() => run.partialText!}
                    label={t('visuals.m282')}
                    copiedLabel={t('visuals.m281')}
                    onFailure={() => onError(uiMessage('visuals.m280'))}
                  />
                )}
                {resultActions}
              </>
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
                  text={() => rawRunRecord(record.value!)}
                  label={t('visuals.historyCopy')}
                  copiedLabel={t('visuals.historyCopied')}
                  onFailure={() => onError(uiMessage('visuals.historyCopyFailed'))}
                />
              </>
            )
          }
        >
          {record.value ? (
            rawOpen && <pre className="task-history-raw">{rawRunRecord(record.value)}</pre>
          ) : (
            <RunRecordLoading error={record.error} retry={record.retry} />
          )}
        </TaskHistorySection>
      )}
    </div>
  );
}
