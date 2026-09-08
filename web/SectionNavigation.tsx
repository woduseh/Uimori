import type { LucideIcon } from 'lucide-react';
import './section-navigation.css';

export type SectionNavigationItem<K extends string> = {
  id: K;
  title: string;
  icon?: LucideIcon;
  description?: string;
  panelId?: string;
};

/** The parent owns panel visibility and draft lifetime; this only navigates between sections. */
export function SectionNavigation<K extends string>({
  label,
  items,
  value,
  onSelect,
  compact,
  idPrefix,
  hidden,
}: {
  label: string;
  items: readonly SectionNavigationItem<K>[];
  value: K;
  onSelect: (id: K) => void;
  compact: boolean;
  idPrefix: string;
  hidden?: boolean;
}) {
  return (
    <div
      className="section-navigation"
      role={compact ? 'navigation' : 'tablist'}
      aria-label={label}
      aria-orientation={compact ? undefined : 'vertical'}
      data-compact={compact}
      hidden={hidden}
      onKeyDown={(event) => {
        if (compact || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const current = items.findIndex((item) => item.id === value);
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        if (!items[next]) return;
        onSelect(items[next].id);
        event.currentTarget.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
      }}
    >
      {items.map(({ id, title, icon: Icon, description, panelId }) => (
        <button
          type="button"
          role={compact ? undefined : 'tab'}
          id={`${idPrefix}-${id}-tab`}
          aria-controls={panelId ?? `${idPrefix}-${id}-panel`}
          aria-label={title}
          aria-describedby={description ? `${idPrefix}-${id}-description` : undefined}
          aria-selected={compact ? undefined : value === id}
          aria-current={compact && value === id ? 'page' : undefined}
          tabIndex={compact || value === id ? 0 : -1}
          key={id}
          onClick={() => onSelect(id)}
        >
          {Icon && <Icon size={20} aria-hidden="true" />}
          <span>
            <span className="section-navigation-title">{title}</span>
            {description && <small id={`${idPrefix}-${id}-description`}>{description}</small>}
          </span>
        </button>
      ))}
    </div>
  );
}
