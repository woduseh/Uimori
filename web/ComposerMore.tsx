import { useI18n } from './i18n.js';
import { Switch } from './BooleanControls.js';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Ellipsis, X } from 'lucide-react';
import './composer-more.css';

type Props = { selected: boolean; disabled: boolean; onChange: (value: boolean) => void };

export function LoreResetChip({ selected, disabled, onChange }: Props) {
  const { t } = useI18n();
  return selected ? (
    <div className="composer-request-chips">
      <button
        type="button"
        className="lore-reset-chip"
        disabled={disabled}
        aria-label={t('prompts.uiIncludeRetrievedLoreAgain')}
        onClick={() => onChange(false)}
      >
        {t('prompts.uiExcludeRetrievedLore')}
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  ) : null;
}

export function ComposerMore({
  selected,
  disabled,
  onChange,
  children,
}: Props & { children?: ReactNode }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    choice = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const first = [
      ...(root.current?.querySelectorAll<HTMLElement>(
        '.composer-extra-settings button, .composer-extra-settings select'
      ) ?? []),
    ].find((node) => !node.matches(':disabled') && node.checkVisibility());
    (first ?? choice.current)?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  return (
    <div
      className="composer-more"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if ((event.target as HTMLElement).closest('dialog[open]')) return;
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        data-composer-more
        type="button"
        className="icon-button"
        aria-label={t('prompts.uiMoreInputOptions')}
        title={t('prompts.uiChatSettingsAndRequestOptions')}
        aria-expanded={open}
        aria-controls={id}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <Ellipsis size={18} />
      </button>
      {open && (
        <div
          id={id}
          className="composer-more-panel"
          role="group"
          aria-label={t('prompts.uiOptionsForThisRequest')}
        >
          {children && (
            <div
              className="composer-extra-settings"
              aria-label={t('prompts.uiInputToolsAndSettings')}
            >
              {children}
            </div>
          )}
          <label className="composer-lore-toggle">
            <span className="composer-lore-copy">
              {t('prompts.uiExcludeRetrievedLoreFromNextGeneration')}
            </span>
            <Switch
              ref={choice}
              checked={selected}
              onChange={(event) => {
                onChange(event.target.checked);
                setOpen(false);
                trigger.current?.focus();
              }}
            />
          </label>
        </div>
      )}
    </div>
  );
}
