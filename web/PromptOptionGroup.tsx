import { useState, type ReactNode } from 'react';

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
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(key) === 'open';
    } catch {
      return false;
    }
  });
  return (
    <details
      className={className}
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen(next);
        try {
          localStorage.setItem(key, next ? 'open' : 'closed');
        } catch {}
      }}
    >
      <summary>{summary}</summary>
      {children}
    </details>
  );
}
