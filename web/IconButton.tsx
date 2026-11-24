import { translateMessage, useI18n } from './i18n.js';
import { useId, type ComponentPropsWithRef } from 'react';
import type { LucideIcon } from 'lucide-react';
import './ui-controls.css';
import './tooltip.css';

type Props = Omit<ComponentPropsWithRef<'button'>, 'children' | 'aria-label'> & {
  label: string;
  icon: LucideIcon;
  size?: number;
  text?: string;
};

export function IconButton({
  label,
  icon: Icon,
  size = 20,
  className = '',
  title = label,
  type = 'button',
  text,
  ...props
}: Props) {
  useI18n();
  const tooltipId = useId();
  const tooltip = title ? translateMessage(title) : '';
  return (
    <button
      {...props}
      {...(tooltip ? { interestfor: tooltipId } : {})}
      type={type}
      className={`icon-button ui-icon-button${text ? ' ui-icon-text-button' : ''} ${className}`}
      aria-label={translateMessage(label)}
    >
      <Icon size={size} aria-hidden="true" />
      {text && <span className="ui-icon-button-text">{text}</span>}
      {tooltip && (
        <span
          id={tooltipId}
          className="ui-tooltip"
          popover="hint"
          role="tooltip"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {tooltip}
        </span>
      )}
    </button>
  );
}
