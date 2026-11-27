import { useI18n } from './i18n.js';
import { useEffect, useState } from 'react';
import { RunningIcon } from './ui-icons.js';
import { formatUiMessage, uiMessage, type UiMessage } from './ui-message.js';
import './loading-state.css';
import './activity-status.css';

export function LoadingState({
  error = null,
  loading = !error,
  label = uiMessage('shared.loading'),
  errorLabel = uiMessage('shared.loadFailed'),
  onRetry,
  retryLabel = uiMessage('visuals.m033'),
  presentation = 'region',
}: {
  loading?: boolean;
  error?: UiMessage | null;
  label?: UiMessage;
  errorLabel?: UiMessage;
  onRetry?: () => void;
  retryLabel?: UiMessage;
  presentation?: 'region' | 'placeholder' | 'inline';
}) {
  useI18n();
  const [visible, setVisible] = useState(false);
  const failed = Boolean(error);
  useEffect(() => {
    setVisible(false);
    if (!loading || failed) return;
    const timer = setTimeout(() => setVisible(true), 200);
    return () => clearTimeout(timer);
  }, [loading, failed]);
  if (!error && (!loading || (!visible && presentation !== 'region'))) return null;
  return (
    <div className={`loading-state loading-state-${presentation}`}>
      {error ? (
        <>
          <div role="alert">
            <p>{formatUiMessage(errorLabel)}</p>
            <p className="muted">{formatUiMessage(error)}</p>
          </div>
          {onRetry && (
            <button type="button" className="secondary" disabled={loading} onClick={onRetry}>
              {formatUiMessage(retryLabel)}
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
          <p>{formatUiMessage(label)}</p>
        </div>
      ) : null}
    </div>
  );
}
