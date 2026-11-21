import { t, useI18n } from './i18n.js';
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { IconButton } from './IconButton.js';
import { BackIcon } from './ui-icons.js';
import './settings-layout.css';

export function SettingsDetail({
  open,
  location,
  detailKey = '',
  onBack,
  backDisabled = false,
  returnFocus,
  children,
}: {
  open: boolean;
  location: string[];
  detailKey?: string;
  onBack: () => void;
  backDisabled?: boolean;
  returnFocus?: () => HTMLElement | null | undefined;
  children: ReactNode;
}) {
  useI18n();
  const ref = useRef<HTMLElement>(null);
  const opened = useRef<{ scroll: number; opener: Element | null } | null>(null);
  const listScroll = useRef(0);
  const restoreFocus = useRef(returnFocus);
  restoreFocus.current = returnFocus;
  useLayoutEffect(() => {
    void detailKey;
    const node = ref.current!;
    const page = node.closest<HTMLElement>('.settings-page');
    if (!open) {
      const previous = opened.current;
      opened.current = null;
      if (previous && page) page.scrollTop = previous.scroll;
      listScroll.current = page?.scrollTop ?? 0;
      const remember = () => {
        listScroll.current = page?.scrollTop ?? 0;
      };
      page?.addEventListener('scroll', remember, { passive: true });
      const frame =
        previous &&
        requestAnimationFrame(() => {
          const focused = document.activeElement;
          if (
            focused instanceof HTMLElement &&
            focused !== document.body &&
            !focused.matches('.settings-page') &&
            focused.checkVisibility()
          )
            return;
          const target =
            previous.opener instanceof HTMLElement &&
            previous.opener.isConnected &&
            previous.opener.checkVisibility()
              ? previous.opener
              : restoreFocus.current?.();
          target?.focus({ preventScroll: true });
        });
      return () => {
        page?.removeEventListener('scroll', remember);
        if (frame) cancelAnimationFrame(frame);
      };
    }
    if (!opened.current)
      opened.current = { scroll: listScroll.current, opener: document.activeElement };
    if (page) page.scrollTop = 0;
    const frame = requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (focused && node.contains(focused) && (focused as HTMLElement).checkVisibility()) return;
      node.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, detailKey]);
  return (
    <section
      ref={ref}
      className="settings-detail"
      data-settings-detail=""
      hidden={!open}
      tabIndex={-1}
      aria-label={location.join(' / ')}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing)
          return;
        const target = event.target as Element;
        if (target.closest('dialog[open]') !== event.currentTarget.closest('dialog[open]')) return;
        if (target.closest('[data-settings-detail]') !== event.currentTarget) return;
        event.preventDefault();
        event.stopPropagation();
        if (!backDisabled) onBack();
      }}
    >
      <div className="settings-detail-bar">
        <IconButton
          className="secondary settings-detail-back"
          icon={BackIcon}
          size={18}
          label={t('shared.backToList')}
          disabled={backDisabled}
          onClick={onBack}
        />
        <p className="settings-detail-location">
          {location.map((part, index) => (
            <span key={index}>{part}</span>
          ))}
        </p>
      </div>
      {children}
    </section>
  );
}

export function backFromSettingsDetail(root: Element | null | undefined) {
  const back = [
    ...(root?.querySelectorAll<HTMLButtonElement>(
      '.settings-page:not([hidden]) [data-settings-detail]:not([hidden]) > .settings-detail-bar > .settings-detail-back'
    ) ?? []),
  ]
    .filter((button) => button.checkVisibility())
    .at(-1);
  if (!back) return false;
  back.click();
  return true;
}
