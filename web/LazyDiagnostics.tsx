import { t, useI18n } from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useApiRecord } from './useApiRecord.js';

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
  const { value, error, retry } = useApiRecord<T>(path, revision, !disclosure || open);
  const expanded = !disclosure || open;
  useEffect(() => {
    setOpen(initiallyOpen);
  }, [initiallyOpen]);
  const content = (
    <>
      {actions && <div className="form-actions">{actions}</div>}
      {expanded && (error || value === null) && (
        <LoadingState
          presentation="inline"
          loading={!error}
          error={error}
          label={t('shared.loadingDetails')}
          onRetry={retry}
        />
      )}
      {expanded && value !== null && children(value)}
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
