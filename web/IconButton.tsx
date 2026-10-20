import { translateMessage, useI18n } from './i18n.js';
import type { ComponentPropsWithRef } from 'react';
import type { LucideIcon } from 'lucide-react';
import './ui-controls.css';

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
  return (
    <button
      {...props}
      type={type}
      className={`icon-button ui-icon-button ${className}`}
      aria-label={translateMessage(label)}
      title={title ? translateMessage(title) : title}
    >
      <Icon size={size} aria-hidden="true" />
    </button>
  );
}
