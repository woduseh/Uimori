import { t, useI18n } from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from './api.js';
import { useRetryableEffect } from './useRetryableEffect.js';

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
  actions?: ReactNode;
  children: (value: T) => ReactNode;
}) {
  useI18n();
  const [open, setOpen] = useState(initiallyOpen);
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState('');
  const expanded = !disclosure || open;
  useEffect(() => {
    setOpen(initiallyOpen);
  }, [initiallyOpen]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Revision updates reload diagnostics at the same path.
  const retry = useRetryableEffect(() => {
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
  }, [path, revision, expanded]);
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
            onRetry={retry}
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
