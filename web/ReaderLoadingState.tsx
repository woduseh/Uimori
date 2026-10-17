import { useEffect, useState } from 'react';
import { LoadingState } from './LoadingState.js';
import { RunningIcon } from './ui-icons.js';
import './reader-loading.css';

export function ReaderLoadingState({
  loading,
  error,
  onRetry,
}: {
  loading: boolean;
  error: string;
  onRetry: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setVisible(false);
    setSlow(false);
    if (!loading || error) return;
    const show = setTimeout(() => setVisible(true), 200);
    const delayed = setTimeout(() => setSlow(true), 3000);
    return () => {
      clearTimeout(show);
      clearTimeout(delayed);
    };
  }, [loading, error]);

  if (error)
    return (
      <div className="reader-loading-error">
        {loading && (
          <div className="reader-loading-retry" role="status">
            <RunningIcon size={18} className="activity-spinner" aria-hidden="true" />
            <span>본문을 다시 불러오는 중이에요…</span>
          </div>
        )}
        <LoadingState
          presentation="placeholder"
          loading={loading}
          error={error}
          errorLabel="본문을 불러오지 못했어요."
          onRetry={onRetry}
          retryLabel="본문 다시 불러오기"
        />
      </div>
    );
  if (!loading || !visible) return null;

  return (
    <div className="reader-loading">
      <div className="reader-loading-status" role="status">
        <RunningIcon size={19} className="activity-spinner" aria-hidden="true" />
        <span>본문을 불러오는 중이에요…</span>
      </div>
      <div className="reader-loading-skeleton" aria-hidden="true">
        <div className="reader-loading-skeleton-title" />
        <div className="reader-loading-skeleton-paragraph">
          {[96, 100, 91, 62].map((width) => (
            <span key={width} style={{ width: `${width}%` }} />
          ))}
        </div>
        <div className="reader-loading-skeleton-paragraph">
          {[100, 94, 72].map((width) => (
            <span key={width} style={{ width: `${width}%` }} />
          ))}
        </div>
      </div>
      {slow && (
        <p className="reader-loading-slow" role="status">
          평소보다 조금 오래 걸리고 있어요.
        </p>
      )}
    </div>
  );
}
