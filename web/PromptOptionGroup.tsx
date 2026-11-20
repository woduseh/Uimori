import { useState, type ReactNode } from 'react';
import { readOptionalStorage, writeOptionalStorage } from './optional-storage.js';

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
  const key = `uimori:prompt-option-group:${identity}`;
  const [open, setOpen] = useState(() => readOptionalStorage('local', key) === 'open');
  return (
    <details
      className={className}
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen(next);
        writeOptionalStorage('local', key, next ? 'open' : 'closed');
      }}
    >
      <summary>{summary}</summary>
      {children}
    </details>
  );
}
