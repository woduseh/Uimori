import { t, useI18n, translateMessage, formatNumber, message as uiMessage } from './i18n.js';
import { useState } from 'react';
import type { Job, ReaderRun, Run } from '../core/types.js';
import { api, labels } from './api.js';
import { ContextSummaryStatus } from './ContextSummaryStatus.js';
import { LazyDiagnostics } from './LazyDiagnostics.js';
import { LoreContextDiagnostics } from './LoreContextDiagnostics.js';
import { ProviderRejectionNotice } from './provider-rejection.js';
import { JobCard } from './SourceReader.js';
import { mainJudgmentError } from './main-judgment-error.js';
import { SceneReceipt } from './SceneUsage.js';
import { PartialResponse, StreamingResponse } from './StreamingResponse.js';
import { CopyTextButton, TaskHistorySection } from './TaskHistory.js';
import {
  TraceCallTable,
  TraceFooter,
  TraceLoading,
  TraceSummary,
  useChatTrace,
} from './TaskTrace.js';
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
  jobs,
  revision,
  refresh,
  onError,
}: {
  jobs: RunJob[];
  revision: number;
  refresh: () => Promise<void>;
  onError: (message: string) => void;
}) {
  useI18n();
  return (
    <>
      {jobs.map((job) => (
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

export const rawRunRecord = (full: Run) =>
  JSON.stringify(
    { snapshot: full.snapshot, inputs: full.inputs, toolEvents: full.toolEvents },
    null,
    2
  );

export function RunTaskDetails({
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
  const authored = run.packageStart?.mode === 'authored';
  const record = useApiRecord<Run>(`/runs/${run.id}`, revision, !authored);
  const trace = useChatTrace(run.chatId, revision);
  const calls = trace.value?.filter((call) => call.sceneRunId === run.id) ?? [];
  const settled = !['queued', 'running'].includes(run.status);
  const partial = !authored && settled && run.partialText;
  const cancelledStream =
    !authored && run.status === 'cancelled' && !run.partialText && !run.sourceRevision;
  const pendingJobs = jobs.filter(
    (job) =>
      run.sourceRevision &&
      job.sourceRevision === run.sourceRevision &&
      (job.status !== 'completed' || !!job.error)
  );
  const snapshot = record.value?.snapshot;
  return (
    <div className="run-task-details task-history-sections">
      {(partial || cancelledStream) && (
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
        </TaskHistorySection>
      )}
      {(!authored || !trace.value || trace.error || calls.length > 0) && (
        <TaskHistorySection title={t('visuals.historyCalls')}>
          {trace.value && <TraceSummary calls={calls} groups />}
          {(!trace.value || trace.error) && (
            <TraceLoading error={trace.error} retry={trace.retry} />
          )}
          {!authored &&
            (run.sceneUsage ? (
              <SceneReceipt usage={run.sceneUsage} contextSummary={run.contextSummary} />
            ) : (
              run.contextSummary?.status === 'ready' && (
                <ContextSummaryStatus summary={run.contextSummary} />
              )
            ))}
        </TaskHistorySection>
      )}
      {(calls.length > 0 || pendingJobs.length > 0 || snapshot?.loreContext) && (
        <TaskHistorySection title={t('taskTrace.flow')}>
          {calls.length > 0 && (
            <TraceCallTable calls={calls} revision={revision} label={t('taskTrace.flow')} />
          )}
          <RunJobs jobs={pendingJobs} revision={revision} refresh={refresh} onError={onError} />
          {snapshot?.loreContext && (
            <LoreContextDiagnostics
              snapshot={snapshot.loreContext}
              reset={snapshot.loreContextReset}
            />
          )}
          {snapshot && <LoreSelectionStatus snapshot={snapshot} />}
        </TaskHistorySection>
      )}
      {!authored && (!record.value || record.error) && (
        <TraceLoading error={record.error} retry={record.retry} />
      )}
      {!authored && (
        <TraceFooter
          id={run.id}
          raw={record.value ? () => rawRunRecord(record.value!) : undefined}
          onCopyFailed={() => onError(uiMessage('visuals.historyCopyFailed'))}
        />
      )}
    </div>
  );
}
