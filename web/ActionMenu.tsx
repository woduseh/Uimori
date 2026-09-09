import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
} from 'react';
import type { LucideIcon } from 'lucide-react';
import { MoreIcon } from './ui-icons.js';
import './ui-controls.css';

export function ActionMenu({
  label,
  children,
  className = '',
  icon: Icon = MoreIcon,
  placement = 'bottom',
  viewport = false,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  icon?: LucideIcon;
  placement?: 'top' | 'bottom';
  viewport?: boolean;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>();
  useLayoutEffect(() => {
    if (!open || !viewport) return;
    const place = () => {
      const anchor = ref.current?.querySelector('summary')?.getBoundingClientRect();
      const menu = body.current;
      if (!anchor || !menu) return;
      const height = Math.min(menu.scrollHeight + 2, window.innerHeight - 16);
      const below = window.innerHeight - anchor.bottom - 8;
      const above = anchor.top - 8;
      const upward =
        placement === 'top' ? above >= height || above > below : below < height && above > below;
      setPosition({
        position: 'fixed',
        left: Math.max(
          8,
          Math.min(anchor.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8)
        ),
        right: 'auto',
        top: Math.max(
          8,
          upward
            ? anchor.top - height - 4
            : Math.min(anchor.bottom + 4, window.innerHeight - height - 8)
        ),
        bottom: 'auto',
        maxHeight: 'calc(100dvh - 16px)',
        overflowY: 'auto',
      });
    };
    const scroll = (event: Event) => {
      if (event.target instanceof Node && body.current?.contains(event.target)) return;
      if (ref.current && !ref.current.querySelector('dialog[open]')) ref.current.open = false;
    };
    place();
    const observer = new ResizeObserver(place);
    if (body.current) observer.observe(body.current);
    window.addEventListener('resize', place);
    document.addEventListener('scroll', scroll, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', scroll, true);
    };
  }, [open, viewport, placement]);
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
      <div ref={body} className="action-menu-body" style={viewport ? position : undefined}>
        {children}
      </div>
    </details>
  );
}
