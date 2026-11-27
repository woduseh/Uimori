import { useEffect, useState } from 'react';
import { api } from './api.js';
import { t, useI18n } from './i18n.js';
import { toUiMessage } from './api-errors.js';
import { uiMessage, type UiMessage } from './ui-message.js';
import { LoadingState } from './LoadingState.js';

export function InvalidStoryUi({ text }: { text: string }) {
  useI18n();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [error, setError] = useState<UiMessage | null>(null);
  const compilable = text.startsWith('<a2ui>');
  useEffect(() => {
    if (!open || !compilable || reason !== null) return;
    const controller = new AbortController();
    setError(null);
    void api<{ failures: string[] }>('/story-ui/preview', { text }, 'POST', controller.signal)
      .then((result) => setReason(result.failures[0] ?? ''))
      .catch((cause) => {
        if (!controller.signal.aborted) setError(toUiMessage(cause));
      });
    return () => controller.abort();
  }, [open, compilable, reason, text]);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{t('storyUi.invalid')}</summary>
      {compilable &&
        (reason ? (
          <p className="story-ui-failure">
            <strong>{t('storyUi.failureReason')}</strong> <code>{reason}</code>
          </p>
        ) : (
          <LoadingState
            presentation="inline"
            loading={reason === null}
            error={error}
            label={uiMessage('storyUi.checkingFailure')}
          />
        ))}
      <pre>{text}</pre>
    </details>
  );
}
