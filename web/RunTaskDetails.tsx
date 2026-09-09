import { useState, type ReactNode } from 'react';
import type { Job, ReaderRun, Run } from '../core/types.js';
import { api, labels } from './api.js';
import { ContextSummaryStatus } from './ContextSummaryStatus.js';
import { LazyDiagnostics } from './LazyDiagnostics.js';
import { LoreContextDiagnostics } from './LoreContextDiagnostics.js';
import { ProviderRejectionNotice } from './provider-rejection.js';
import { JobCard } from './SourceReader.js';

export function RunTaskDetails({
  run,
  jobs,
  inlineJobs,
  revision,
  refresh,
  onError,
  children,
  initiallyInspect = false,
}: {
  run: ReaderRun;
  jobs: Pick<Job, 'id' | 'sourceRevision' | 'kind' | 'status' | 'error' | 'attempt'>[];
  inlineJobs?: Job[];
  revision: number;
  refresh: () => Promise<void>;
  onError: (message: string) => void;
  children?: ReactNode;
  initiallyInspect?: boolean;
}) {
  const [cancelling, setCancelling] = useState(false);
  const canCancel = ['queued', 'running', 'waiting_for_state'].includes(run.status);
  return (
    <div className="run-task-details">
      <div className="task-heading">
        <strong>{run.snapshot.forkedFrom ? '복사한 원고' : `원문 ${labels[run.status]}`}</strong>
        <small>
          {run.packageStart?.mode === 'authored'
            ? '작성된 도입문 · 모델 호출 없음'
            : run.modelTitle || 'Scripted mock · 모의 생성'}
        </small>
      </div>
      <ContextSummaryStatus summary={run.contextSummary} />
      {run.error &&
        !(run.contextSummary?.status === 'failed' && run.contextSummary.error === run.error) && (
          <p className="error">{run.error}</p>
        )}
      {run.rejection && <ProviderRejectionNotice rejection={run.rejection} />}
      {run.status === 'refused' && (
        <p className="error">요청에 대한 생성이 거절됐어요. 대체 원고를 자동 생성하지 않았어요.</p>
      )}
      {run.partialText && (
        <details className="partial-result">
          <summary>보존된 부분 출력 · 확정 원문에 합류하지 않음</summary>
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
            원문 생성 취소
          </button>
        </div>
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
              title={`${{ translation: '번역', image: '이미지', status: '장면 상태' }[job.kind]} · ${labels[job.status]} · 작업 관리`}
            >
              {(full) => <JobCard job={full} refresh={refresh} onError={onError} hideText />}
            </LazyDiagnostics>
          )
        )}
      <LazyDiagnostics<Run>
        path={`/runs/${run.id}`}
        revision={revision}
        initiallyOpen={initiallyInspect}
        title="실행과 실제 입력 확인"
      >
        {(full) => (
          <>
            <p>
              Run {full.id} · 실행 요청 {full.usage.modelCalls}회 · 입력{' '}
              {full.usage.inputTokens ?? '미확인'} / 출력 {full.usage.outputTokens ?? '미확인'} 토큰
              · 비용 {full.usage.costUsd === null ? '미확인' : `$${full.usage.costUsd}`}
            </p>
            <LoreContextDiagnostics
              snapshot={full.snapshot.loreContext}
              reset={full.snapshot.loreContextReset}
            />
            <pre>
              {JSON.stringify(
                { snapshot: full.snapshot, inputs: full.inputs, toolEvents: full.toolEvents },
                null,
                2
              )}
            </pre>
          </>
        )}
      </LazyDiagnostics>
    </div>
  );
}
