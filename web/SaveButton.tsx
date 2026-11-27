import { t, useI18n } from './i18n.js';
import type { ComponentPropsWithRef } from 'react';
import type { LucideIcon } from 'lucide-react';
import { RunningIcon, SaveIcon } from './ui-icons.js';
import './settings-actions.css';
import './activity-status.css';

type Props = Omit<ComponentPropsWithRef<'button'>, 'children' | 'aria-label'> & {
  label: string;
  text?: string;
  icon?: LucideIcon;
};

export function SaveButton({
  label,
  text,
  icon: Icon = SaveIcon,
  className = '',
  type = 'submit',
  disabled,
  'aria-busy': ariaBusy,
  ...props
}: Props) {
  useI18n();
  const busy = ariaBusy === true || ariaBusy === 'true';
  const shown = text ?? t('shared.save');
  const pendingText = shown
    ? text === undefined || text === t('shared.save')
      ? t('shared.saving')
      : t('shared.working')
    : '';
  return (
    <button
      {...props}
      type={type}
      className={`settings-save-button ${className}`}
      aria-label={label}
      title={label}
      disabled={disabled || busy}
      aria-busy={ariaBusy}
    >
      {shown ? (
        <span className="settings-save-label" data-pending-label={pendingText}>
          <span className="settings-save-content">
            {busy ? (
              <RunningIcon size={18} className="activity-spinner" aria-hidden="true" />
            ) : (
              <Icon size={18} aria-hidden="true" />
            )}
            <span>{busy ? pendingText : shown}</span>
          </span>
        </span>
      ) : busy ? (
        <RunningIcon size={18} className="activity-spinner" aria-hidden="true" />
      ) : (
        <Icon size={18} aria-hidden="true" />
      )}
    </button>
  );
}
