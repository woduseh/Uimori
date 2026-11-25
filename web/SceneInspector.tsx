import { t, useI18n, formatNumber, message as uiMessage } from './i18n.js';
import { useState, type ReactNode } from 'react';
import type { Job, ReaderRun, Run, Source } from '../core/types.js';
import type { Illustration, IllustrationUsageReport } from '../core/illustration.js';
import { labels } from './api.js';
import { LoadingState } from './LoadingState.js';
import { LoreContextDiagnostics } from './LoreContextDiagnostics.js';
import { ProviderRejectionNotice } from './provider-rejection.js';
import {
  LoreSelectionStatus,
  RunCancelButton,
  RunNotices,
  rawRunRecord,
} from './RunTaskDetails.js';
import { SceneReceipt } from './SceneUsage.js';
import { AuxiliaryError, JobActions, jobPayloadRecord, jobTitle } from './SourceReader.js';
import { PartialResponse, StreamingResponse } from './StreamingResponse.js';
import { CopyTextButton, TaskStatusBadge, taskStatusTone } from './TaskHistory.js';
import { statusGlyph } from './TurnStatus.js';
import { IllustrationPhases, IllustrationUsageReportView } from './IllustrationActivity.js';
import { illustrationProgress } from './illustration-progress.js';
import { sceneCostLabels } from './pricing-display.js';
import { usageCompact } from './usage-display.js';
import { useApiRecord } from './useApiRecord.js';
import './scene-inspector.css';

function RunNumbers({ run }: { run: ReaderRun }) {
  useI18n();
  const cost = sceneCostLabels(run.estimatedCost);
  const usage = run.sceneUsage;
  const tokens = (
    key: 'reader.inspectorInput' | 'reader.inspectorOutput',
    value?: number | null
  ) =>
    value == null ? null : (
      <span key={key} title={formatNumber(value)}>
        {t(key, { count: usageCompact(value) })}
      </span>
    );
  const items = [
    cost && (
      <span key="cost" data-testid="scene-text-cost" title={cost.full}>
        <span aria-hidden="true">{cost.short}</span>
        <span className="sr-only">{t('reader.estimatedTextCostValue', { v0: cost.full })}</span>
      </span>
    ),
    tokens('reader.inspectorInput', usage?.inputTokens),
    tokens('reader.inspectorOutput', usage?.outputTokens),
  ].filter(Boolean);
  return items.length ? <span className="scene-inspector-numbers">{items}</span> : null;
}

function LinkedJob({
  job,
  refresh,
  onError,
}: {
  job: Job;
  refresh: () => Promise<void>;
  onError: (message: string) => void;
}) {
  useI18n();
  const tone = taskStatusTone(job.status);
  const Glyph = statusGlyph[tone];
  const expanded = job.status !== 'completed' || !!job.error || !!job.rejection;
  return (
    <li
      className="scene-job"
      data-testid={`job-${job.kind}`}
      data-source-id={job.sourceRevision}
      data-job-id={job.id}
      data-tone={tone}
      data-expanded={expanded || undefined}
    >
      <span className="scene-job-line">
        <Glyph
          size={14}
          aria-hidden="true"
          className={tone === 'running' ? 'activity-spinner' : undefined}
        />
        <span>{t('reader.jobHeading', { mock: !!job.result?.mock, title: jobTitle(job) })}</span>
        <span className={job.status === 'completed' ? 'sr-only' : 'scene-job-state'}>
          {labels[job.status] ?? job.status}
        </span>
      </span>
      {expanded && (
        <div className="scene-job-detail">
          {job.error && <AuxiliaryError error={job.error} />}
          {job.rejection && <ProviderRejectionNotice rejection={job.rejection} />}
          <div className="scene-job-actions">
            <JobActions job={job} refresh={refresh} onError={onError} />
          </div>
        </div>
      )}
    </li>
  );
}

function LinkedIllustrations({
  items,
  source,
  refresh,
  onError,
}: {
  items: Illustration[];
  source: Source;
  refresh: () => Promise<void>;
  onError: (message: string) => void;
}) {
  useI18n();
  const progress = illustrationProgress(items);
  const tone = taskStatusTone(progress.status);
  const Glyph = statusGlyph[tone];
  const expanded = progress.status !== 'completed';
  return (
    <li
      className="scene-job"
      data-testid="job-illustration"
      data-tone={tone}
      data-expanded={expanded || undefined}
    >
      <span className="scene-job-line">
        <Glyph
          size={14}
          aria-hidden="true"
          className={tone === 'running' ? 'activity-spinner' : undefined}
        />
        <span>
          {progress.total
            ? t('reader.illustrationCount', {
                completed: progress.completed,
                total: progress.total,
              })
            : t('visuals.m098')}
        </span>
        <span className={expanded ? 'scene-job-state' : 'sr-only'}>
          {progress.status === 'partial'
            ? t('visuals.m172')
            : (labels[progress.status] ?? progress.status)}
        </span>
      </span>
      {expanded && (
        <div className="scene-job-detail">
          <IllustrationPhases
            items={items}
            sourceId={source.id}
            sourceHash={source.hash}
            refresh={refresh}
            onError={onError}
          />
        </div>
      )}
    </li>
  );
}

type RawTab = { key: string; label: string; path: string; revision: string | number };
type ApiRecord<T> = ReturnType<typeof useApiRecord<T>>;

function RawRecords({
  tabs,
  selected,
  onSelect,
  record,
  illustrations,
  onError,
}: {
  tabs: RawTab[];
  selected: RawTab;
  onSelect: (key: string) => void;
  record: ApiRecord<unknown>;
  illustrations: Illustration[];
  onError: (message: string) => void;
}) {
  useI18n();
  const json = (value: unknown) =>
    selected.key === 'main'
      ? rawRunRecord(value as Run)
      : selected.key === 'illustration'
        ? JSON.stringify(value, null, 2)
        : jobPayloadRecord(value as Job);
  return (
    <div className="scene-raw" data-testid="scene-raw-record">
      {(tabs.length > 1 || record.value !== null) && (
        <div className="scene-raw-head">
          {tabs.length > 1 && (
            <div
              className="segmented compact scene-raw-tabs"
              role="group"
              aria-label={t('reader.rawRecordKind')}
            >
              {tabs.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  aria-pressed={item.key === selected.key}
                  onClick={() => onSelect(item.key)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
          {record.value !== null && (
            <CopyTextButton
              text={() => json(record.value)}
              label={t('reader.copyJson')}
              copiedLabel={t('visuals.historyCopied')}
              onFailure={() => onError(uiMessage('visuals.historyCopyFailed'))}
            />
          )}
        </div>
      )}
      {record.value === null ? (
        <LoadingState
          presentation="inline"
          loading={!record.error}
          error={record.error}
          label={t('shared.loadingDetails')}
          onRetry={record.retry}
        />
      ) : selected.key === 'illustration' ? (
        <div className="scene-raw-usage">
          <IllustrationUsageReportView
            report={record.value as IllustrationUsageReport}
            items={illustrations}
          />
        </div>
      ) : (
        <pre>{json(record.value)}</pre>
      )}
    </div>
  );
}

export function SceneInspector({
  run,
  source,
  jobs,
  illustrations,
  connected,
  revision,
  refresh,
  onError,
  onInspect,
}: {
  run: ReaderRun;
  source?: Source;
  jobs: Job[];
  illustrations: Illustration[];
  connected: boolean;
  revision: number;
  refresh: () => Promise<void>;
  onError: (message: string) => void;
  onInspect?: (runId: string) => void;
}) {
  useI18n();
  const [loreOpen, setLoreOpen] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const [rawTab, setRawTab] = useState('main');
  const authored = run.packageStart?.mode === 'authored';
  const settled = !['queued', 'running'].includes(run.status);
  const usage = run.sceneUsage;
  const noRecord = !authored && settled && !!run.sourceRevision && !usage;
  const modelTitle = usage?.receipt?.model.title || run.modelTitle;
  const modelId = usage?.receipt?.model.modelId;
  const illustrationRevision = illustrations
    .map((item) => `${item.id}:${item.status}:${item.updatedAt}`)
    .join('|');
  const tabs: RawTab[] = [
    { key: 'main', label: t('helpers.m216'), path: `/runs/${run.id}`, revision },
    ...jobs.map((job) => ({
      key: job.id,
      label: jobTitle(job),
      path: `/jobs/${job.id}`,
      revision: `${job.status}:${job.attempt}:${job.revision}`,
    })),
    ...(source && illustrations.length
      ? [
          {
            key: 'illustration',
            label: t('visuals.m098'),
            path: `/sources/${source.id}/illustration-usage`,
            revision: illustrationRevision,
          },
        ]
      : []),
  ];
  const selectedTab = tabs.find((item) => item.key === rawTab) ?? tabs[0];
  const mainSelected = selectedTab.key === 'main';
  const record = useApiRecord<Run>(
    `/runs/${run.id}`,
    revision,
    loreOpen || (rawOpen && mainSelected)
  );
  const tabRecord = useApiRecord<unknown>(
    selectedTab.path,
    selectedTab.revision,
    rawOpen && !mainSelected
  );
  const loreDetails: ReactNode = record.value ? (
    <>
      {record.value.snapshot.loreContext && (
        <LoreContextDiagnostics
          snapshot={record.value.snapshot.loreContext}
          reset={record.value.snapshot.loreContextReset}
        />
      )}
      <LoreSelectionStatus snapshot={record.value.snapshot} />
    </>
  ) : (
    <LoadingState
      presentation="inline"
      loading={!record.error}
      error={record.error}
      label={t('shared.loadingDetails')}
      onRetry={record.retry}
    />
  );
  const linked = jobs.length > 0 || (!!source && illustrations.length > 0);
  return (
    <div className="scene-inspector" data-testid="scene-inspector">
      {!connected && (
        <p className="connection-notice" role="status">
          {t('helpers.m254')}
        </p>
      )}
      {!authored && (
        <section className="scene-inspector-region" aria-label={t('reader.inspectorRun')}>
          <div className="scene-inspector-head">
            <span className="scene-inspector-title">
              <TaskStatusBadge
                tone={taskStatusTone(run.status)}
                label={labels[run.status] ?? run.status}
              />
              {modelTitle && <strong>{modelTitle}</strong>}
              {modelId && modelId.trim() !== modelTitle?.trim() && <small>{modelId}</small>}
            </span>
            <RunNumbers run={run} />
            <RunCancelButton run={run} refresh={refresh} onError={onError} />
          </div>
          <RunNotices run={run} readyContext={false} />
          {settled && run.partialText && (
            <div className="scene-inspector-partial">
              <div className="scene-inspector-partial-head">
                <p>{t('visuals.m279')}</p>
                <CopyTextButton
                  text={() => run.partialText!}
                  label={t('visuals.m282')}
                  copiedLabel={t('visuals.m281')}
                  onFailure={() => onError(uiMessage('visuals.m280'))}
                />
              </div>
              <pre>{run.partialText}</pre>
            </div>
          )}
          {run.status === 'cancelled' && !run.partialText && !run.sourceRevision && (
            <PartialResponse>
              <StreamingResponse taskKind="main" taskId={run.id} taskStatus={run.status} settled />
            </PartialResponse>
          )}
          {noRecord && (
            <p className="scene-inspector-empty">
              {t('reader.noCallRecordUsageIsNotEstimatedForImported')}
            </p>
          )}
          {(usage || run.contextSummary?.status === 'ready') && (
            <SceneReceipt
              usage={usage}
              contextSummary={run.contextSummary}
              loreDetails={loreDetails}
              onLoreToggle={setLoreOpen}
            />
          )}
        </section>
      )}
      {linked && (
        <ul className="scene-jobs" aria-label={t('reader.linkedJobs')}>
          {jobs.map((job) => (
            <LinkedJob key={job.id} job={job} refresh={refresh} onError={onError} />
          ))}
          {source && illustrations.length > 0 && (
            <LinkedIllustrations
              items={illustrations}
              source={source}
              refresh={refresh}
              onError={onError}
            />
          )}
        </ul>
      )}
      {!authored && (
        <div className="scene-inspector-tools">
          {onInspect && (
            <button type="button" className="secondary" onClick={() => onInspect(run.id)}>
              {t('reader.openInTaskHistory')}
            </button>
          )}
          <button
            type="button"
            className="secondary scene-inspector-raw-toggle"
            aria-pressed={rawOpen}
            onClick={() => setRawOpen((old) => !old)}
          >
            {t('visuals.historyRaw')}
          </button>
        </div>
      )}
      {rawOpen && (
        <RawRecords
          tabs={tabs}
          selected={selectedTab}
          onSelect={setRawTab}
          record={mainSelected ? record : tabRecord}
          illustrations={illustrations}
          onError={onError}
        />
      )}
    </div>
  );
}
