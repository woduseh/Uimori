import { translateMessage, useI18n } from './i18n.js';
import { useId, type ComponentPropsWithRef } from 'react';
import type { LucideIcon } from 'lucide-react';
import './ui-controls.css';
import './tooltip.css';

type Props = Omit<ComponentPropsWithRef<'button'>, 'children' | 'aria-label'> & {
  label: string;
  icon: LucideIcon;
  size?: number;
};

export function IconButton({
  label,
  icon: Icon,
  size = 20,
  className = '',
  title = label,
  type = 'button',
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
      className={`icon-button ui-icon-button ${className}`}
      aria-label={translateMessage(label)}
    >
      <Icon size={size} aria-hidden="true" />
      {tooltip && (
        <span
          id={tooltipId}
          className="ui-tooltip"
          popover="hint"
          role="tooltip"
          onClick={(event) => {
            // Keep the hoverable text from activating its owning button.
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
