import type { ComponentPropsWithRef } from 'react';
import type { LucideIcon } from 'lucide-react';
import { SaveIcon } from './ui-icons.js';
import './settings-actions.css';

type Props = Omit<ComponentPropsWithRef<'button'>, 'children' | 'aria-label'> & {
  /** Full action name including its target. Speech input and tooltips use it. */
  label: string;
  /** Visible text. It stays inside `label` so the shown name is part of the spoken one. */
  text?: string;
  icon?: LucideIcon;
};

/** Primary confirm action of a settings form: the shared glyph with a visible name. */
export function SaveButton({
  label,
  text = '저장',
  icon: Icon = SaveIcon,
  className = '',
  type = 'submit',
  ...props
}: Props) {
  return (
    <button
      {...props}
      type={type}
      className={`settings-save-button ${className}`}
      aria-label={label}
      title={label}
    >
      <Icon size={18} aria-hidden="true" />
      <span>{text}</span>
    </button>
  );
}
