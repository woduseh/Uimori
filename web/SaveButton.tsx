import type { ComponentPropsWithRef } from 'react';
import type { LucideIcon } from 'lucide-react';
import { SaveIcon } from './ui-icons.js';
import './settings-actions.css';

type Props = Omit<ComponentPropsWithRef<'button'>, 'children' | 'aria-label'> & {
  /** Full action name including its target. Speech input and tooltips use it. */
  label: string;
  /** Optional visible text. Empty by default: the glyph carries the meaning and
   * `label` supplies the tooltip and the spoken name. */
  text?: string;
  icon?: LucideIcon;
};

/** Primary confirm action of a settings form: the shared glyph, named by `label`. */
export function SaveButton({
  label,
  text = '',
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
      {text && <span>{text}</span>}
    </button>
  );
}
