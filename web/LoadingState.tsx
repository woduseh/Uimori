import { translateMessage, useI18n, message as uiMessage } from './i18n.js';
import { useEffect, useState } from 'react';
import { RunningIcon } from './ui-icons.js';
import './loading-state.css';
import './activity-status.css';

export function LoadingState({
  error = '',
  loading = !error,
  label = uiMessage('shared.loading'),
  errorLabel = uiMessage('shared.loadFailed'),
  onRetry,
  retryLabel = uiMessage('visuals.m033'),
  presentation = 'region',
}: {
  loading?: boolean;
  error?: string;
  label?: string;
  errorLabel?: string;
  onRetry?: () => void;
  retryLabel?: string;
  presentation?: 'region' | 'placeholder' | 'inline';
}) {
  useI18n();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    setVisible(false);
    if (!loading || error) return;
    const timer = setTimeout(() => setVisible(true), 200);
    return () => clearTimeout(timer);
  }, [loading, error]);
  if (!error && (!loading || (!visible && presentation !== 'region'))) return null;
  return (
    <div className={`loading-state loading-state-${presentation}`}>
      {error ? (
        <>
          <div role="alert">
            <p>{translateMessage(errorLabel)}</p>
            <p className="muted">{translateMessage(error)}</p>
          </div>
          {onRetry && (
            <button type="button" className="secondary" disabled={loading} onClick={onRetry}>
              {translateMessage(retryLabel)}
            </button>
          )}
        </>
      ) : visible ? (
        <div role="status">
          <RunningIcon
            size={presentation === 'inline' ? 18 : 22}
            className="activity-spinner"
            aria-hidden="true"
          />
          <p>{translateMessage(label)}</p>
        </div>
      ) : null}
    </div>
  );
}
