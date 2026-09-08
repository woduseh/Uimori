import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { MoreIcon } from './ui-icons.js';
import './ui-controls.css';

export function ActionMenu({
  label,
  children,
  className = '',
  icon: Icon = MoreIcon,
  placement = 'bottom',
}: {
  label: string;
  children: ReactNode;
  className?: string;
  icon?: LucideIcon;
  placement?: 'top' | 'bottom';
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      const node = ref.current;
      if (
        node &&
        event.target instanceof Node &&
        !node.contains(event.target) &&
        !node.querySelector('dialog[open]')
      )
        node.open = false;
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  return (
    <details
      ref={ref}
      className={`action-menu${placement === 'top' ? ' action-menu-up' : ''} ${className}`}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !event.currentTarget.open) return;
        // An inner native dialog owns Escape, including when this menu is itself in a dialog.
        const targetDialog = (event.target as Element).closest('dialog[open]');
        if (targetDialog && targetDialog !== event.currentTarget.closest('dialog[open]')) return;
        event.stopPropagation();
        event.preventDefault();
        event.currentTarget.open = false;
        event.currentTarget.querySelector('summary')?.focus();
      }}
      onBlur={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          !event.currentTarget.contains(event.relatedTarget) &&
          !event.currentTarget.querySelector('dialog[open]')
        )
          event.currentTarget.open = false;
      }}
    >
      <summary aria-label={label} title={label}>
        <Icon size={20} aria-hidden="true" />
        <span className="sr-only">{label}</span>
      </summary>
      <div className="action-menu-body">{children}</div>
    </details>
  );
}
