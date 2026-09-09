import { useRef, useState } from 'react';
import { CloseIcon, RefreshIcon, RunningIcon } from './ui-icons.js';
import type { Illustration } from '../core/illustration.js';
import { api } from './api.js';
import { DeleteButton } from './DeleteButton.js';
import {
  illustrationActive,
  illustrationErrorMessage,
  illustrationGeneratorLabels,
  illustrationReconcilable,
  illustrationRetryable,
  illustrationSkipped,
  illustrationStatusLabels,
} from './illustration-labels.js';
import './illustrations.css';

/** Illustrations belong to the response that requested them; the strip never edits story text. */
export function IllustrationStrip({
  sourceId,
  sourceHash,
  illustrations,
  refresh,
  onError,
}: {
  sourceId: string;
  /** Current text hash; illustrations of an earlier revision are labeled, never hidden. */
  sourceHash: string;
  illustrations: Illustration[];
  refresh: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const items = illustrations.filter((item) => item.sourceRevision === sourceId);
  if (!items.length) return null;
  return (
    <section
      className="illustrations"
      aria-label="이 장면의 삽화"
      data-testid="illustrations"
      data-source-id={sourceId}
    >
      {items.map((item) => (
        <IllustrationCard
          key={item.id}
          item={item}
          stale={item.sourceHash !== sourceHash}
          refresh={refresh}
          onError={onError}
        />
      ))}
    </section>
  );
}

function IllustrationCard({
  item,
  stale,
  refresh,
  onError,
}: {
  item: Illustration;
  stale: boolean;
  refresh: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function act(path: string) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      await api(path, {});
      await refresh();
    } catch (cause) {
      const message = (cause as Error).message;
      setError(message);
      onError(message);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  const active = illustrationActive(item);
  const skipped = illustrationSkipped(item);
  const retries = item.diagnostic?.retries.length ?? 0;
  const comfy = item.diagnostic?.comfyui;
  const hasDiagnostic =
    !!comfy?.nodeErrors?.length ||
    !!comfy?.statusMessages?.length ||
    !!item.diagnostic?.prompt ||
    !!item.diagnostic?.revisedPrompt ||
    retries > 0;
  return (
    <article
      className={skipped ? 'illustration illustration-skipped' : 'illustration'}
      data-testid="illustration"
      data-illustration-id={item.id}
      data-status={item.status}
      data-skipped={skipped ? 'true' : undefined}
    >
      <div className="illustration-head">
        <span>
          <strong>삽화</strong>{' '}
          <small>
            {illustrationGeneratorLabels[item.generator]} ·{' '}
            {item.origin === 'automatic' ? '자동' : '직접 요청'}
            {item.attempt > 1 ? ` · ${item.attempt}번째 시도` : ''} ·{' '}
            {skipped ? '생략' : illustrationStatusLabels[item.status]}
            {stale ? ' · 수정 전 원문의 삽화' : ''}
          </small>
        </span>
        <div className="illustration-actions">
          {active && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void act(`/illustrations/${encodeURIComponent(item.id)}/cancel`)}
            >
              <CloseIcon size={16} aria-hidden="true" /> 취소
            </button>
          )}
          {illustrationReconcilable(item) && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              title="ComfyUI에 접수된 작업의 결과만 읽어요. 새로 그리지 않아요."
              onClick={() => void act(`/illustrations/${encodeURIComponent(item.id)}/reconcile`)}
            >
              <RefreshIcon size={16} aria-hidden="true" /> 결과 확인
            </button>
          )}
          {illustrationRetryable(item) && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void act(`/illustrations/${encodeURIComponent(item.id)}/retry`)}
            >
              <RefreshIcon size={16} aria-hidden="true" /> 다시 요청
            </button>
          )}
          {!active && (
            <DeleteButton
              path={`/illustrations/${encodeURIComponent(item.id)}`}
              title={item.images[0]?.caption || '이 삽화'}
              label="삽화 삭제"
              description="이 삽화와 생성 기록을 삭제해요. 원문과 다른 삽화는 유지돼요."
              disabled={busy}
              iconOnly
              onDeleted={refresh}
              onError={onError}
            />
          )}
        </div>
      </div>
      {active && (
        <p className="illustration-progress" role="status">
          <RunningIcon size={16} aria-hidden="true" />
          {item.status === 'queued'
            ? '삽화 생성을 기다리고 있어요. 본문 읽기와 다음 요청은 계속할 수 있어요.'
            : item.diagnostic?.stage === 'prompt'
              ? '장면을 그림 설명으로 옮기는 중이에요.'
              : item.diagnostic?.stage === 'reconcile'
                ? 'ComfyUI에서 결과를 확인하는 중이에요.'
                : '삽화를 그리는 중이에요. 본문 읽기와 다음 요청은 계속할 수 있어요.'}
        </p>
      )}
      {skipped && (
        <p className="muted illustration-skip-note">
          이 장면은 삽화를 생략했어요. {item.diagnostic?.skipped}
        </p>
      )}
      {item.status === 'completed' && !skipped && (
        <div className="illustration-images">
          {item.images.map((image) => (
            <figure key={image.id}>
              <a href={image.url} target="_blank" rel="noreferrer">
                <img src={image.url} alt={image.caption || '장면 삽화'} loading="lazy" />
              </a>
              {image.caption && <figcaption>{image.caption}</figcaption>}
            </figure>
          ))}
        </div>
      )}
      {!active && item.status !== 'completed' && (
        <div className="error" role="alert">
          <p>{illustrationErrorMessage(item.error)} 원문은 보존돼요.</p>
          {item.error && <small>오류 코드: {item.error}</small>}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {hasDiagnostic && (
        <details className="illustration-diagnostic">
          <summary>생성 상세</summary>
          {retries > 0 && (
            <p>
              자동 재요청 {retries}회 · 한도 {item.maxAutoRetries}회
              {item.diagnostic?.retries.length
                ? ` · 마지막 실패 ${item.diagnostic.retries.at(-1)!.code}`
                : ''}
            </p>
          )}
          {item.diagnostic?.prompt && <pre>{item.diagnostic.prompt.prompt}</pre>}
          {item.diagnostic?.revisedPrompt && <pre>{item.diagnostic.revisedPrompt}</pre>}
          {comfy?.promptId && <p>ComfyUI prompt_id: {comfy.promptId}</p>}
          {comfy?.statusMessages?.length ? (
            <ul>
              {comfy.statusMessages.map((message, index) => (
                <li key={`${index}-${message}`}>{message}</li>
              ))}
            </ul>
          ) : null}
          {comfy?.nodeErrors?.length ? (
            <ul>
              {comfy.nodeErrors.map((node) => (
                <li key={node.nodeId}>
                  노드 {node.nodeId} ({node.classType})
                  {node.messages.length ? `: ${node.messages.join(' / ')}` : ''}
                </li>
              ))}
            </ul>
          ) : null}
        </details>
      )}
    </article>
  );
}
