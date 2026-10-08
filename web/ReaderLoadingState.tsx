import { useEffect, useState } from 'react';
import { RunningIcon } from './ui-icons.js';
import './reader-loading.css';
import './activity-status.css';

/** Short reads leave the space quiet; failed reads keep an explicit recovery action. */
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
  useEffect(() => {
    setVisible(false);
    if (!loading || error) return;
    const timer = setTimeout(() => setVisible(true), 200);
    return () => clearTimeout(timer);
  }, [loading, error]);
  if (error)
    return (
      <div className="reader-loading-state">
        <div role="alert">
          <p>본문을 불러오지 못했어요.</p>
          <p className="muted">{error}</p>
        </div>
        <button type="button" className="secondary" disabled={loading} onClick={onRetry}>
          본문 다시 불러오기
        </button>
      </div>
    );
  return visible && loading ? (
    <div className="reader-loading-state" role="status">
      <RunningIcon size={22} className="activity-spinner" aria-hidden="true" />
      <p>본문을 불러오는 중이에요…</p>
    </div>
  ) : null;
}
