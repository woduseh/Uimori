import { useEffect, useLayoutEffect, useId, useRef, useState, type ReactNode } from 'react';
import { IconButton } from './IconButton.js';
import { CloseIcon } from './ui-icons.js';

/** Native modal supplies background inertness, Escape, focus containment and restoration. */
export function Dialog({
  open,
  title,
  onClose,
  children,
  wide = false,
  className = '',
  scopeKey = '',
  role = 'dialog',
  headerTitle,
  headerLeading,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  className?: string;
  scopeKey?: string;
  role?: 'dialog' | 'alertdialog';
  headerTitle?: string;
  headerLeading?: ReactNode;
}) {
  const [visited, setVisited] = useState<string | null>(null);
  useEffect(() => {
    if (open) setVisited(scopeKey);
  }, [open, scopeKey]);
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const close = useRef(onClose);
  close.current = onClose;
  const isOpen = useRef(open);
  isOpen.current = open;
  useLayoutEffect(() => {
    const node = ref.current!;
    return () => {
      // Conditional panels must close before removal to restore the native opener focus.
      isOpen.current = false;
      if (node.open) node.close();
    };
  }, []);
  useEffect(() => {
    const node = ref.current!;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      role={role}
      className={`app-dialog ${wide ? 'wide' : ''} ${className}`}
      aria-labelledby={headerTitle ? undefined : id}
      aria-label={headerTitle ? title : undefined}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        event.stopPropagation();
        const candidates = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            'button, input, select, textarea, a[href], summary, [tabindex]'
          ),
        ].filter(
          (element) =>
            element.tabIndex >= 0 &&
            !element.matches(':disabled') &&
            element.checkVisibility({ checkVisibilityCSS: true })
        );
        const first = candidates[0];
        const last = candidates.at(-1);
        if (!first || !last) {
          event.preventDefault();
          event.currentTarget.focus();
          return;
        }
        const active = document.activeElement;
        if (event.shiftKey && (active === first || !event.currentTarget.contains(active))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (active === last || !event.currentTarget.contains(active))) {
          event.preventDefault();
          first.focus();
        }
      }}
      onCancel={(event) => {
        event.stopPropagation();
        event.preventDefault();
        close.current();
      }}
      onClose={(event) => {
        event.stopPropagation();
        if (isOpen.current) close.current();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const r = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < r.left ||
            event.clientX > r.right ||
            event.clientY < r.top ||
            event.clientY > r.bottom
          )
            close.current();
        }
      }}
    >
      <header className="dialog-header">
        {headerLeading}
        <h2 id={id}>{headerTitle ?? title}</h2>
        <IconButton
          className="secondary"
          label={`${title} 닫기`}
          icon={CloseIcon}
          onClick={onClose}
        />
      </header>
      <div className="dialog-body">{(open || visited === scopeKey) && children}</div>
    </dialog>
  );
}
