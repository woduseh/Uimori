import { useI18n } from './i18n.js';
import type { ReactNode } from 'react';
import { Info, TriangleAlert } from 'lucide-react';
import { displayMessage, isUiMessage, type DisplayMessage, type UiMessage } from './ui-message.js';
import './notices.css';

export function NoticeBanner({
  children,
  actions,
  label,
  tone = 'info',
  className = '',
}: {
  children: ReactNode | UiMessage;
  actions?: ReactNode;
  label?: DisplayMessage;
  tone?: 'info' | 'error';
  className?: string;
}) {
  useI18n();
  const Icon = tone === 'error' ? TriangleAlert : Info;
  return (
    <aside
      className={`notice-banner notice-${tone} ${className}`}
      role={tone === 'error' ? 'alert' : 'status'}
      aria-label={label ? displayMessage(label) : undefined}
    >
      <Icon size={18} className="notice-banner-icon" aria-hidden="true" />
      <div className="notice-banner-message">
        {typeof children === 'string' || isUiMessage(children)
          ? displayMessage(children)
          : children}
      </div>
      {actions && <div className="notice-banner-actions">{actions}</div>}
    </aside>
  );
}
