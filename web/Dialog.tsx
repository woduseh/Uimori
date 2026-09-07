import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

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
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  className?: string;
  scopeKey?: string;
  role?: 'dialog' | 'alertdialog';
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
      aria-labelledby={id}
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
        <h2 id={id}>{title}</h2>
        <button
          type="button"
          className="icon-button secondary"
          aria-label={`${title} 닫기`}
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </header>
      <div className="dialog-body">{(open || visited === scopeKey) && children}</div>
    </dialog>
  );
}
