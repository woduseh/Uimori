import type { ReactNode } from 'react';
import { Info, TriangleAlert } from 'lucide-react';
import './notices.css';

export function NoticeBanner({
  children,
  actions,
  label,
  tone = 'info',
  className = '',
}: {
  children: ReactNode;
  actions?: ReactNode;
  label?: string;
  tone?: 'info' | 'error';
  className?: string;
}) {
  const Icon = tone === 'error' ? TriangleAlert : Info;
  return (
    <aside
      className={`notice-banner notice-${tone} ${className}`}
      role={tone === 'error' ? 'alert' : 'status'}
      aria-label={label}
    >
      <Icon size={18} className="notice-banner-icon" aria-hidden="true" />
      <div className="notice-banner-message">{children}</div>
      {actions && <div className="notice-banner-actions">{actions}</div>}
    </aside>
  );
}
