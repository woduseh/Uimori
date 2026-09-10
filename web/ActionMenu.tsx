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

/** Below this width menus open as bottom sheets instead of anchored popovers (ui-controls.css). */
export const SHEET_MEDIA = '(max-width: 600px)';

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
  const [sheet, setSheet] = useState(false);
  // Narrow screens open every menu as a bottom sheet (CSS): a popover anchored to its trigger has
  // no room above or below once it holds more than a few rows, and gets clipped by the header.
  useLayoutEffect(() => {
    if (!open) return;
    const media = matchMedia(SHEET_MEDIA);
    const update = () => setSheet(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [open]);
  useLayoutEffect(() => {
    if (!open || (!viewport && !sheet)) return;
    const place = () => {
      const anchor = ref.current?.querySelector('summary')?.getBoundingClientRect();
      const menu = body.current;
      if (!anchor || !menu) return;
      // Sheet geometry lives in ui-controls.css (see SHEET_MEDIA there) so the first painted
      // frame is already the sheet; the details toggle event arrives after that frame.
      if (sheet) {
        setPosition(undefined);
        return;
      }
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
    // An anchored popover drifts from its trigger when the page scrolls, so it closes; a sheet is
    // pinned to the viewport behind a scrim and only closes by pointer, Escape or blur.
    if (!sheet) document.addEventListener('scroll', scroll, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', scroll, true);
    };
  }, [open, viewport, placement, sheet]);
  useEffect(() => {
    // Reads the native open state: the details toggle event is asynchronous, so a tap right
    // after opening must still dismiss. The sheet's scrim is the details' own ::before, so a tap
    // on it reports the details itself.
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
    // A dialog opened from an item (delete confirmation, picker) finishes the choice when it
    // closes, whichever way: the menu closes with it and focus returns to the trigger.
    const node = ref.current;
    if (!node) return;
    const closed = (event: Event) => {
      if (!(event.target instanceof HTMLDialogElement) || !node.open) return;
      if (event.target.closest('details.action-menu') !== node) return;
      node.open = false;
      node.querySelector('summary')?.focus();
    };
    node.addEventListener('close', closed, true);
    return () => node.removeEventListener('close', closed, true);
  }, []);
  // A dialog *inside* the menu (confirmation, picker) owns its own controls; the menu itself may
  // sit inside a dialog such as the navigation drawer, which must not count.
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
      <div
        ref={body}
        className="action-menu-body"
        style={viewport && !sheet ? position : undefined}
        onClick={(event) => {
          // Choosing an item closes the menu, unless the item opens something inside it (a
          // confirmation dialog, a picker). The check runs after the item's own handler committed.
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
