import { useRef, useState } from 'react';
import type { ReaderRun } from '../core/types.js';
import { t, translateMessage, useI18n } from './i18n.js';
import { RequestMessage } from './RequestMessage.js';
import { HistoryIcon, StopIcon } from './ui-icons.js';
import './cancelled-run.css';

/** A confirmed cancellation keeps its request recoverable without repeating failure diagnostics. */
export function CancelledRun({
  run,
  disabled,
  onRetry,
  onSubmit,
  onConfirm,
  onDismiss,
  onHistory,
}: {
  run: ReaderRun;
  disabled: boolean;
  onRetry?: () => void;
  onSubmit?: (text: string) => Promise<boolean>;
  onConfirm?: () => Promise<boolean>;
  onDismiss: () => Promise<void>;
  onHistory: () => void;
}) {
  useI18n();
  const [editing, setEditing] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  async function dismiss() {
    if (lock.current || editing || disabled) return;
    lock.current = true;
    setDismissing(true);
    setError('');
    try {
      await onDismiss();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      lock.current = false;
      setDismissing(false);
    }
  }
  return (
    <article className="pending-turn" data-testid="pending-run" data-run-id={run.id}>
      <RequestMessage
        runId={run.id}
        request={run.request}
        images={run.snapshot.requestImages}
        disabled={disabled || dismissing}
        editHint={t('main.m094')}
        onSubmit={onSubmit}
        onConfirm={onConfirm}
        onEditingChange={setEditing}
      />
      <div className="cancelled-run" role="group" aria-label={t('shared.cancelledRequest')}>
        <p className="cancelled-run-status" role="status">
          <StopIcon size={15} aria-hidden="true" />
          {t('shared.cancelled')}
        </p>
        <div className="cancelled-run-actions">
          {onRetry && (
            <button
              type="button"
              className="secondary"
              disabled={disabled || dismissing || editing}
              onClick={onRetry}
            >
              {t('shared.retry')}
            </button>
          )}
          <button
            type="button"
            className="secondary"
            disabled={disabled || dismissing || editing}
            aria-busy={dismissing}
            onClick={() => void dismiss()}
          >
            {t('shared.dismissFromReader')}
          </button>
          <button type="button" className="secondary" onClick={onHistory}>
            <HistoryIcon size={18} aria-hidden="true" />
            {t('shared.history')}
          </button>
        </div>
        {error && (
          <p className="error" role="alert">
            {translateMessage(error)}
          </p>
        )}
      </div>
    </article>
  );
}
