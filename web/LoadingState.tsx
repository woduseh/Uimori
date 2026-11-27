import { useI18n } from './i18n.js';
import { useEffect, useState } from 'react';
import { RunningIcon } from './ui-icons.js';
import { displayMessage, uiMessage, type DisplayMessage } from './ui-message.js';
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
  error?: DisplayMessage | null;
  label?: DisplayMessage;
  errorLabel?: DisplayMessage;
  onRetry?: () => void;
  retryLabel?: DisplayMessage;
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
            <p>{displayMessage(errorLabel)}</p>
            <p className="muted">{displayMessage(error)}</p>
          </div>
          {onRetry && (
            <button type="button" className="secondary" disabled={loading} onClick={onRetry}>
              {displayMessage(retryLabel)}
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
          <p>{displayMessage(label)}</p>
        </div>
      ) : null}
    </div>
  );
}
