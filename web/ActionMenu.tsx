import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { MoreIcon } from './ui-icons.js';
import './ui-controls.css';

export const SHEET_MEDIA = '(max-width: 600px)';

export function ActionMenu({
  label,
  children,
  className = '',
  icon: Icon = MoreIcon,
  placement = 'bottom',
  viewport = false,
  summary,
}: {
  summary?: ReactNode;
  label: string;
  children: ReactNode;
  className?: string;
  icon?: LucideIcon;
  placement?: 'top' | 'bottom';
  viewport?: boolean;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  useLayoutEffect(() => {
    if (!open) return;
    const media = matchMedia(SHEET_MEDIA);
    const update = () => setSheet(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [open]);
  useLayoutEffect(() => {
    const node = ref.current;
    const summary = node?.querySelector<HTMLElement>(':scope > summary');
    if (!open || !viewport || sheet || !node || !summary) return;
    const dismiss = () => {
      if (!node.open || node.querySelector('dialog[open]')) return;
      const focused = node.contains(document.activeElement);
      node.open = false;
      if (focused) summary.focus({ preventScroll: true });
    };
    const position = () => {
      const rect = summary.getBoundingClientRect();
      let scrollTop = 0;
      let scrollLeft = 0;
      for (let element = summary.parentElement; element; element = element.parentElement) {
        scrollTop += element.scrollTop;
        scrollLeft += element.scrollLeft;
      }
      return {
        top: rect.top,
        left: rect.left,
        contentTop: rect.top + scrollTop,
        contentLeft: rect.left + scrollLeft,
      };
    };
    let baseline = position();
    const moved = (from: number, to: number) => Math.abs(to - from) >= 1;
    const scroll = (event: Event) => {
      if (!(event.target instanceof Node) || !event.target.contains(node)) return;
      const current = position();
      if (
        moved(baseline.contentTop, current.contentTop) ||
        moved(baseline.contentLeft, current.contentLeft)
      ) {
        baseline = current;
        return;
      }
      if (moved(baseline.top, current.top) || moved(baseline.left, current.left)) dismiss();
    };
    const hidden = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) dismiss();
    });
    hidden.observe(summary);
    document.addEventListener('scroll', scroll, true);
    return () => {
      hidden.disconnect();
      document.removeEventListener('scroll', scroll, true);
    };
  }, [open, viewport, sheet]);
  useEffect(() => {
    // https://html.spec.whatwg.org/multipage/interactive-elements.html#queue-a-details-toggle-event-task (2026-11-20):
    // a change to the details open attribute fires toggle later, from a queued element task.
    const dismiss = (event: PointerEvent) => {
      const node = ref.current;
      if (
        node?.open &&
        event.target instanceof Node &&
        (event.target === node || !node.contains(event.target)) &&
        !node.querySelector('dialog[open]')
      )
        node.open = false;
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, []);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const finish = () => {
      if (!node.open || !node.isConnected) return;
      node.open = false;
      node.querySelector<HTMLElement>(':scope > summary')?.focus();
    };
    const ownedDialogs = () =>
      new Set(
        [...node.querySelectorAll<HTMLDialogElement>('dialog[open]')].filter(
          (dialog) => dialog.closest('details.action-menu') === node
        )
      );
    const activeDialogs = ownedDialogs();
    const closed = (event: Event) => {
      if (!(event.target instanceof HTMLDialogElement)) return;
      if (event.target.closest('details.action-menu') !== node) return;
      activeDialogs.delete(event.target);
      finish();
    };
    // https://html.spec.whatwg.org/multipage/interactive-elements.html#close-the-dialog (2026-11-20):
    // closing a dialog fires its close event from a queued element task.
    const observer = new MutationObserver(() => {
      const removed = [...activeDialogs].some((dialog) => !node.contains(dialog));
      const currentDialogs = ownedDialogs();
      for (const dialog of currentDialogs) activeDialogs.add(dialog);
      for (const dialog of activeDialogs) if (!node.contains(dialog)) activeDialogs.delete(dialog);
      if (removed && currentDialogs.size === 0) finish();
    });
    observer.observe(node, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['open'],
    });
    node.addEventListener('close', closed, true);
    return () => {
      observer.disconnect();
      node.removeEventListener('close', closed, true);
    };
  }, []);
  const insideNestedDialog = (element: Element) => {
    const dialog = element.closest('dialog');
    return !!dialog && !!ref.current?.contains(dialog);
  };
  const closeAfterChoice = () => {
    const node = ref.current;
    if (!node) return;
    setTimeout(() => {
      if (node.open && !node.querySelector('dialog[open]')) node.open = false;
    }, 0);
  };
  return (
    <details
      ref={ref}
      className={`action-menu${placement === 'top' ? ' action-menu-up' : ''}${viewport ? ' action-menu-viewport' : ''} ${className}`}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !event.currentTarget.open) return;
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
        {summary ?? <Icon size={20} aria-hidden="true" />}
        <span className="sr-only">{label}</span>
      </summary>
      <div
        className="action-menu-body"
        onClick={(event) => {
          const item = (event.target as Element).closest('button');
          if (
            !item ||
            item.disabled ||
            insideNestedDialog(item) ||
            item.hasAttribute('aria-haspopup') ||
            item.hasAttribute('aria-pressed')
          )
            return;
          closeAfterChoice();
        }}
      >
        {children}
      </div>
    </details>
  );
}
