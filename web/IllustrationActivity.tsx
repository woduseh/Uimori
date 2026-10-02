import { useRef, useState } from 'react';
import type { Usage } from '../core/types.js';
import type { Illustration, IllustrationUsageReport } from '../core/illustration.js';
import { api, labels } from './api.js';
import { LazyDiagnostics } from './LazyDiagnostics.js';
import { illustrationProgress, illustrationTaskNames } from './illustration-progress.js';
import './illustrations.css';

export function IllustrationUsageLine({ usage }: { usage: Usage }) {
  return (
    <p className="illustration-usage">
      모델 요청 {usage.modelCalls}회 · 입력 {usage.inputTokens?.toLocaleString() ?? '미확인'} / 출력{' '}
      {usage.outputTokens?.toLocaleString() ?? '미확인'} 토큰
    </p>
  );
}

export function IllustrationPlacementButton({
  sourceId,
  sourceHash,
  pending,
  refresh,
  onError,
}: {
  sourceId: string;
  sourceHash: string;
  pending: boolean;
  refresh: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="secondary"
      disabled={pending || busy}
      title="그림은 그대로 두고 번역문 위치만 다시 계산해요."
      onClick={async () => {
        if (locked.current) return;
        locked.current = true;
        setBusy(true);
        try {
          await api(`/sources/${sourceId}/illustration-placement`, {
            expectedSourceHash: sourceHash,
          });
          await refresh();
        } catch (cause) {
          onError((cause as Error).message);
        } finally {
          locked.current = false;
          setBusy(false);
        }
      }}
    >
      {pending || busy ? '번역 위치 연결 중…' : '번역 위치 다시 연결'}
    </button>
  );
}

export function IllustrationActivity({
  items,
  sourceId,
  sourceHash,
  refresh,
  onError,
}: {
  items: Illustration[];
  sourceId: string;
  sourceHash: string;
  refresh: () => Promise<void>;
  onError: (message: string) => void;
}) {
  if (!items.length) return null;
  const progress = illustrationProgress(items);
  const revision = items.map((item) => `${item.id}:${item.status}:${item.updatedAt}`).join('|');
  return (
    <section className="job illustration-job" aria-label="이 응답의 삽화 작업">
      <h3>
        삽화{' '}
        <small>
          {progress.status === 'partial'
            ? '위치 확인 필요'
            : (labels[progress.status] ?? progress.status)}
        </small>
      </h3>
      <dl className="illustration-phases">
        {progress.phases.map((phase) => (
          <div key={phase.task}>
            <dt>{illustrationTaskNames[phase.task]}</dt>
            <dd>
              {phase.task === 'placement' && phase.status === 'completed' && progress.unresolved
                ? '일부 미지정'
                : (labels[phase.status] ?? phase.status)}
              {phase.detail && ` · ${phase.detail}`}
            </dd>
          </div>
        ))}
      </dl>
      {progress.unresolved > 0 && (
        <IllustrationPlacementButton
          sourceId={sourceId}
          sourceHash={sourceHash}
          pending={items.some(
            (item) => item.task === 'placement' && ['queued', 'running'].includes(item.status)
          )}
          refresh={refresh}
          onError={onError}
        />
      )}
      <LazyDiagnostics<IllustrationUsageReport>
        path={`/sources/${sourceId}/illustration-usage`}
        revision={revision}
        title="삽화 호출과 토큰"
      >
        {(report) => (
          <>
            <IllustrationUsageLine usage={report.total} />
            <dl className="illustration-phases">
              {progress.phases.map(({ task }) => (
                <div key={task}>
                  <dt>{illustrationTaskNames[task]}</dt>
                  <dd>
                    <IllustrationUsageLine usage={report.stages[task]} />
                  </dd>
                </div>
              ))}
            </dl>
            <small>
              이 원문의 삽화 작업 누적값이에요. 다시 그리기·위치 재연결을 포함하고, 공급자가 JEV
              사전 판정도 포함해요. 요청 수는 Uimori 기준이며 Codex 내부 모델 호출 수는
              미확인이에요. 공급자가 보고하지 않은 토큰은 미확인으로 표시하고, ComfyUI의 실제 그림
              생성은 모델 토큰에 포함하지 않아요.
            </small>
          </>
        )}
      </LazyDiagnostics>
    </section>
  );
}
