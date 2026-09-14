import { useRef, useState, type ReactNode } from 'react';
import type { Job, ReaderRun, Run } from '../core/types.js';
import { api, labels } from './api.js';
import { ContextSummaryStatus } from './ContextSummaryStatus.js';
import { LazyDiagnostics } from './LazyDiagnostics.js';
import { LoreContextDiagnostics } from './LoreContextDiagnostics.js';
import { ProviderRejectionNotice } from './provider-rejection.js';
import { JobCard } from './SourceReader.js';
import { DiagnosticReport } from './DiagnosticReport.js';

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
  const [skipping, setSkipping] = useState(false);
  const [copiedOutput, setCopiedOutput] = useState(false);
  const stateSkipKey = useRef<string | null>(null);
  const packageSkipKey = useRef<string | null>(null);
  const afterResponseSkipKey = useRef<string | null>(null);
  const canCancel = ['queued', 'running', 'waiting_for_state'].includes(run.status);
  const packagePreparing =
    !!run.packagePreparation && ['pending', 'running'].includes(run.packagePreparation.status);
  const packagePreparationInterrupted = packagePreparing && !canCancel;
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
      {run.hasPackageIssues && (
        <p role="status" className="muted">
          일부 자료의 자동 처리나 지침을 적용하지 못했어요. 원본 자료와 기록을 보존하고 채팅을
          계속해요. 자세한 내용은 진단에서 확인할 수 있어요.
        </p>
      )}
      {packagePreparing && !packagePreparationInterrupted && (
        <p role="status" className="muted">
          자료의 자동 행동을 준비하고 있어요. {run.packagePreparation!.completed}/
          {run.packagePreparation!.total} 완료했어요. 준비가 끝나면 원문 생성을 시작해요.
        </p>
      )}
      {packagePreparationInterrupted && (
        <p role="status" className="muted">
          자료의 자동 행동 준비가 끝나기 전에 원문 작업이 중단됐어요. 준비 중인 결과는 채택하지
          않았어요.
        </p>
      )}
      {run.packagePreparation?.status === 'failed' && (
        <p role="status" className="muted">
          자료의 자동 행동을 준비하지 못해 해당 결과를 적용하지 않았어요. 원문 생성은 계속할 수
          있어요.
        </p>
      )}
      {run.packagePreparation?.status === 'skipped' && (
        <p role="status" className="muted">
          자료의 자동 행동 준비를 건너뛰었어요. 준비 중이던 결과는 적용하지 않고 원문 생성을
          계속해요.
        </p>
      )}
      {run.packageAfterResponse?.status === 'running' && (
        <p role="status" className="muted">
          {canCancel
            ? `응답을 읽고 자료 상태를 갱신하고 있어요. ${run.packageAfterResponse.completed}/${run.packageAfterResponse.total} 완료했어요.`
            : '자료의 응답 후 처리가 끝나기 전에 작업이 중단됐어요. 미완료 결과는 적용하지 않았어요.'}
        </p>
      )}
      {!!run.packageAfterResponse?.failed && (
        <p role="status" className="muted">
          일부 자료의 응답 후 처리를 적용하지 못했어요. 해당 후처리 전의 유효한 상태를 유지하며
          원문은 그대로 보존해요.
        </p>
      )}
      {run.packageAfterResponse?.status === 'skipped' && (
        <p role="status" className="muted">
          응답 후 처리를 건너뛰어 해당 상태 결과를 적용하지 않았어요.
          {canCancel && ' 진행 중인 호출을 정리한 뒤 원문을 저장해요.'}
        </p>
      )}
      {run.statePreparation && ['failed', 'skipped'].includes(run.statePreparation.status) && (
        <p role="status" className="muted">
          {run.statePreparation.status === 'skipped'
            ? '상태 준비를 건너뛰고'
            : '상태를 갱신하지 못해'}{' '}
          채팅을 계속해요.{' '}
          {run.statePreparation.hasState
            ? '마지막 확인 상태를 참고해요.'
            : '사용할 수 있는 확인 상태가 없어요.'}
          {run.statePreparation.missingSources > 0 && (
            <> 원문 {run.statePreparation.missingSources}개의 상태 변화는 반영되지 않았어요.</>
          )}
        </p>
      )}
      {run.error &&
        !(run.contextSummary?.status === 'failed' && run.contextSummary.error === run.error) && (
          <p className="error">{run.error}</p>
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
          {run.packageAfterResponse?.status === 'running' && run.snapshot.branchId && (
            <button
              type="button"
              className="secondary"
              disabled={skipping || cancelling}
              onClick={async () => {
                if (skipping || cancelling) return;
                setSkipping(true);
                afterResponseSkipKey.current ??= crypto.randomUUID();
                onError('');
                try {
                  await api(`/runs/${run.id}/skip-package-after-response`, {
                    chatId: run.chatId,
                    branchId: run.snapshot.branchId,
                    expectedRevision: run.parentRevision,
                    idempotencyKey: afterResponseSkipKey.current,
                  });
                  await refresh();
                } catch (error) {
                  onError((error as Error).message);
                } finally {
                  setSkipping(false);
                }
              }}
            >
              응답 후 처리 건너뛰기
            </button>
          )}
          {packagePreparing && run.snapshot.branchId && (
            <button
              type="button"
              className="secondary"
              disabled={skipping || cancelling}
              onClick={async () => {
                if (skipping || cancelling) return;
                setSkipping(true);
                packageSkipKey.current ??= crypto.randomUUID();
                onError('');
                try {
                  await api(`/runs/${run.id}/skip-package-preparation`, {
                    chatId: run.chatId,
                    branchId: run.snapshot.branchId,
                    expectedRevision: run.parentRevision,
                    idempotencyKey: packageSkipKey.current,
                  });
                  await refresh();
                } catch (error) {
                  onError((error as Error).message);
                } finally {
                  setSkipping(false);
                }
              }}
            >
              자료 자동 준비 건너뛰기
            </button>
          )}
          {run.status === 'waiting_for_state' && run.snapshot.branchId && (
            <button
              type="button"
              className="secondary"
              disabled={skipping || cancelling}
              onClick={async () => {
                if (skipping || cancelling) return;
                setSkipping(true);
                stateSkipKey.current ??= crypto.randomUUID();
                onError('');
                try {
                  await api(`/runs/${run.id}/skip-state-wait`, {
                    chatId: run.chatId,
                    branchId: run.snapshot.branchId,
                    expectedRevision: run.parentRevision,
                    idempotencyKey: stateSkipKey.current,
                  });
                  await refresh();
                } catch (error) {
                  onError((error as Error).message);
                } finally {
                  setSkipping(false);
                }
              }}
            >
              상태 준비 건너뛰기
            </button>
          )}
          <button
            type="button"
            className="secondary"
            disabled={cancelling || skipping}
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
