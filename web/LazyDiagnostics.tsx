import { t, useI18n } from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from './api.js';

export function LazyDiagnostics<T>({
  path,
  revision,
  title,
  initiallyOpen = false,
  disclosure = true,
  actions,
  children,
}: {
  path: string;
  revision: number | string;
  title: ReactNode;
  initiallyOpen?: boolean;
  disclosure?: boolean;
  /** Kept mounted during reloads so an action's open dialog retains its state. */
  actions?: ReactNode;
  children: (value: T) => ReactNode;
}) {
  useI18n();
  const [open, setOpen] = useState(initiallyOpen);
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const expanded = !disclosure || open;
  useEffect(() => {
    setOpen(initiallyOpen);
  }, [initiallyOpen]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Revision updates and explicit retries reload diagnostics at the same path.
  useEffect(() => {
    if (!expanded) {
      setValue(null);
      return;
    }
    let active = true;
    setValue(null);
    setError('');
    void api<T>(path)
      .then((result) => {
        if (active) setValue(result);
      })
      .catch((cause) => {
        if (active) setError((cause as Error).message);
      });
    return () => {
      active = false;
    };
  }, [path, revision, expanded, retry]);
  const content = (
    <>
      {actions && <div className="form-actions">{actions}</div>}
      {expanded &&
        (error || value === null ? (
          <LoadingState
            presentation="inline"
            loading={!error}
            error={error}
            label={t('shared.loadingDetails')}
            onRetry={() => setRetry((value) => value + 1)}
          />
        ) : (
          children(value)
        ))}
    </>
  );
  return disclosure ? (
    <details
      className="inspector"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{title}</summary>
      {content}
    </details>
  ) : (
    <div className="inspector">{content}</div>
  );
}
