import { useEffect, useState } from 'react';
import { RunningIcon } from './ui-icons.js';
import './loading-state.css';
import './activity-status.css';

/** Fast reads stay quiet; slow reads and failures use the same recovery surface. */
export function LoadingState({
  error = '',
  loading = !error,
  label = '불러오는 중이에요…',
  errorLabel = '불러오지 못했어요.',
  onRetry,
  retryLabel = '다시 불러오기',
  compact = false,
}: {
  loading?: boolean;
  error?: string;
  label?: string;
  errorLabel?: string;
  onRetry?: () => void;
  retryLabel?: string;
  compact?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    setVisible(false);
    if (!loading || error) return;
    const timer = setTimeout(() => setVisible(true), 200);
    return () => clearTimeout(timer);
  }, [loading, error]);
  if (!error && (!loading || !visible)) return null;
  return (
    <div className={`loading-state${compact ? ' loading-state-compact' : ''}`}>
      {error ? (
        <>
          <div role="alert">
            <p>{errorLabel}</p>
            <p className="muted">{error}</p>
          </div>
          {onRetry && (
            <button type="button" className="secondary" disabled={loading} onClick={onRetry}>
              {retryLabel}
            </button>
          )}
        </>
      ) : (
        <div role="status">
          <RunningIcon size={22} className="activity-spinner" aria-hidden="true" />
          <p>{label}</p>
        </div>
      )}
    </div>
  );
}
