import { t, translateMessage, useI18n } from './i18n.js';
import type { ComponentPropsWithRef } from 'react';
import type { LucideIcon } from 'lucide-react';
import { RunningIcon, SaveIcon } from './ui-icons.js';
import './settings-actions.css';
import './activity-status.css';

type Props = Omit<ComponentPropsWithRef<'button'>, 'children' | 'aria-label'> & {
  /** Full action name including its target. Speech input and tooltips use it. */
  label: string;
  /** Short visible action. Use an empty string only for an existing icon toolbar. */
  text?: string;
  icon?: LucideIcon;
};

/** Primary confirm action of a settings form, named fully by `label`. */
export function SaveButton({
  label,
  text = '저장',
  icon: Icon = SaveIcon,
  className = '',
  type = 'submit',
  disabled,
  'aria-busy': ariaBusy,
  ...props
}: Props) {
  useI18n();
  const busy = ariaBusy === true || ariaBusy === 'true';
  const pendingText = text
    ? text === '저장' || text === t('shared.save')
      ? t('shared.saving')
      : t('shared.working')
    : '';
  return (
    <button
      {...props}
      type={type}
      className={`settings-save-button ${className}`}
      aria-label={translateMessage(label)}
      title={translateMessage(label)}
      disabled={disabled || busy}
      aria-busy={ariaBusy}
    >
      {busy ? (
        <RunningIcon size={18} className="activity-spinner" aria-hidden="true" />
      ) : (
        <Icon size={18} aria-hidden="true" />
      )}
      {text && (
        <span className="settings-save-label" data-pending-label={pendingText}>
          <span>{busy ? pendingText : translateMessage(text)}</span>
        </span>
      )}
    </button>
  );
}
