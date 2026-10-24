import { t, useI18n, translateMessage, formatNumber, message as uiMessage } from './i18n.js';
import { useState, type ReactNode } from 'react';
import type { Job, ReaderRun, Run } from '../core/types.js';
import { api, labels } from './api.js';
import { ContextSummaryStatus } from './ContextSummaryStatus.js';
import { LazyDiagnostics } from './LazyDiagnostics.js';
import { LoreContextDiagnostics } from './LoreContextDiagnostics.js';
import { ProviderRejectionNotice } from './provider-rejection.js';
import { JobCard } from './SourceReader.js';
import { mainJudgmentError } from './main-judgment-error.js';
import { SceneUsage } from './SceneUsage.js';
import './run-task-details.css';

/**
 * One line per attached package the 모델 선별 step decided for. The receipt records ids, so the chars
 * are summed from the run's own frozen resources rather than counted again.
 */
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
  jobs: Pick<Job, 'id' | 'sourceRevision' | 'kind' | 'status' | 'error' | 'attempt'>[];
  inlineJobs?: Job[];
  revision: number;
  refresh: () => Promise<void>;
  onError: (message: string) => void;
  children?: ReactNode;
  afterJobs?: ReactNode;
  initiallyInspect?: boolean;
  presentation?: 'detail' | 'list';
}) {
  useI18n();
  const [cancelling, setCancelling] = useState(false);
  const [copiedOutput, setCopiedOutput] = useState(false);
  const authored = run.packageStart?.mode === 'authored';
  const canCancel = ['queued', 'running'].includes(run.status);
  const compact = presentation === 'list' && run.status === 'completed' && !initiallyInspect;
  return (
    <div className="run-task-details">
      {!authored && (
        <>
          <div className="task-heading">
            <strong>{t('visuals.m276', { v0: translateMessage(labels[run.status]) })}</strong>
            <small>{run.modelTitle || t('visuals.m277')}</small>
          </div>
          {(!compact || run.contextSummary?.status !== 'ready') && (
            <ContextSummaryStatus summary={run.contextSummary} />
          )}
          {run.error &&
            !(
              run.contextSummary?.status === 'failed' && run.contextSummary.error === run.error
            ) && <p className="error">{mainJudgmentError(run.error) ?? run.error}</p>}
          {run.rejection && <ProviderRejectionNotice rejection={run.rejection} />}
          {run.status === 'refused' && <p className="error">{t('visuals.m278')}</p>}
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
          {canCancel && (
            <div className="form-actions">
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
            </div>
          )}
        </>
      )}
      {children}
      {jobs
        .filter((job) => run.sourceRevision && job.sourceRevision === run.sourceRevision)
        .map((job) =>
          inlineJobs?.find((item) => item.id === job.id) ? (
            <JobCard
              key={job.id}
              job={inlineJobs.find((item) => item.id === job.id)!}
              refresh={refresh}
              onError={onError}
              hideText
            />
          ) : (
            <LazyDiagnostics<Job>
              key={job.id}
              path={`/jobs/${job.id}`}
              revision={revision}
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
          )
        )}
      {afterJobs}
      {!authored && (
        <div className={`run-input-details${compact ? ' run-diagnostics-compact' : ''}`}>
          {run.sourceRevision && <SceneUsage usage={run.sceneUsage} compact={compact} />}
          <LazyDiagnostics<Run>
            path={`/runs/${run.id}`}
            revision={revision}
            initiallyOpen={initiallyInspect}
            title={t('visuals.m285')}
          >
            {(full) => (
              <>
                {compact && run.contextSummary?.status === 'ready' && (
                  <ContextSummaryStatus summary={run.contextSummary} />
                )}
                <p>
                  {t('visuals.runUsage', {
                    id: full.id,
                    calls: formatNumber(full.usage.modelCalls),
                    input:
                      full.usage.inputTokens == null
                        ? t('visuals.m165')
                        : formatNumber(full.usage.inputTokens),
                    output:
                      full.usage.outputTokens == null
                        ? t('visuals.m165')
                        : formatNumber(full.usage.outputTokens),
                    cost:
                      full.usage.costUsd == null
                        ? t('visuals.m165')
                        : formatNumber(full.usage.costUsd, { style: 'currency', currency: 'USD' }),
                  })}
                </p>
                <LoreContextDiagnostics
                  snapshot={full.snapshot.loreContext}
                  reset={full.snapshot.loreContextReset}
                />
                <LoreSelectionStatus snapshot={full.snapshot} />
                <details className="run-raw-record">
                  <summary>{t('visualpanels.rawExecutionRecord')}</summary>
                  <pre>
                    {JSON.stringify(
                      { snapshot: full.snapshot, inputs: full.inputs, toolEvents: full.toolEvents },
                      null,
                      2
                    )}
                  </pre>
                </details>
              </>
            )}
          </LazyDiagnostics>
        </div>
      )}
    </div>
  );
}
