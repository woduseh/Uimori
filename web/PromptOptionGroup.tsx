import { useState, type ReactNode } from 'react';
import { readOptionalStorage } from './optional-storage.js';
import { removeRecentStorage, storageKeys, writeRecentStorage } from './storage-keys.js';

const storedOpen = (key: string) => readOptionalStorage('local', key) === 'open';

export function PromptOptionGroup({
  identity,
  className,
  summary,
  children,
}: {
  identity: string;
  className: string;
  summary: ReactNode;
  children: ReactNode;
}) {
  const key = storageKeys.promptOptionGroup(identity);
  const [state, setState] = useState(() => ({ key, open: storedOpen(key) }));
  const open = state.key === key ? state.open : storedOpen(key);
  if (state.key !== key) setState({ key, open });
  return (
    <details
      className={className}
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        if (next === open) return;
        setState({ key, open: next });
        if (next) writeRecentStorage(key, 'open');
        else removeRecentStorage(key);
      }}
    >
      <summary>{summary}</summary>
      {children}
    </details>
  );
}
