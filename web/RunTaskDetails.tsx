import { useState, type ReactNode } from 'react';
import type { Job, ReaderRun, Run } from '../core/types.js';
import { api, labels } from './api.js';
import { ContextSummaryStatus } from './ContextSummaryStatus.js';
import { LazyDiagnostics } from './LazyDiagnostics.js';
import { LoreContextDiagnostics } from './LoreContextDiagnostics.js';
import { ProviderRejectionNotice } from './provider-rejection.js';
import { JobCard } from './SourceReader.js';
import { DiagnosticReport } from './DiagnosticReport.js';
import { mainJudgmentError } from './main-judgment-error.js';

/**
 * One line per attached package the 모델 선별 step decided for. The receipt records ids, so the chars
 * are summed from the run's own frozen resources rather than counted again.
 */
function LoreSelectionStatus({ snapshot }: { snapshot: Run['snapshot'] }) {
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
    <ul className="muted" aria-label="로어 선별 결과">
      {receipt.entries.map((entry) => (
        <li key={entry.key}>
          {entry.error
            ? `로어 선별을 건너뛰었어요 (${entry.error})`
            : `로어 선별 · ${entry.selected.length}개 선택 · 문자 ${chars(entry.key, entry.selected).toLocaleString()} / 예산 ${entry.budget.toLocaleString()} · 제외 ${entry.omitted.length}`}
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
  const [copiedOutput, setCopiedOutput] = useState(false);
  const canCancel = ['queued', 'running'].includes(run.status);
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
          <p className="error">{mainJudgmentError(run.error) ?? run.error}</p>
        )}
      {run.rejection && <ProviderRejectionNotice rejection={run.rejection} />}
      {run.status === 'refused' && (
        <p className="error">요청에 대한 생성이 거절됐어요. 대체 원고를 자동 생성하지 않았어요.</p>
      )}
      {!canCancel && run.partialText && (
        <details className="partial-result">
          <summary>보존된 출력 · 확정 원문에 합류하지 않음</summary>
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
                  onError('출력을 복사하지 못했어요. 아래 글을 직접 선택해 복사해 주세요.');
                }
              }}
            >
              {copiedOutput ? '출력 복사됨' : '출력 복사'}
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
              title={`${{ translation: '번역', image: '이미지', status: '장면 해설' }[job.kind]} · ${labels[job.status]} · 작업 관리`}
            >
              {(full) => <JobCard job={full} refresh={refresh} onError={onError} hideText />}
            </LazyDiagnostics>
          )
        )}
      <DiagnosticReport scope={{ scope: 'chat', chatId: run.chatId, runId: run.id }} />
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
            <LoreSelectionStatus snapshot={full.snapshot} />
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
