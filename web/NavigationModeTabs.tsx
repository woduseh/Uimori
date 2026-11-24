import type { HTMLAttributes, ReactNode } from 'react';

export type NavigationModeTab<T extends string> = {
  value: T;
  label: ReactNode;
  accessibleName?: string;
};

export function NavigationModeTabs<T extends string>({
  label,
  tabs,
  active,
  panelId,
  onSelect,
  actions,
  headerProps,
}: {
  label: string;
  tabs: NavigationModeTab<T>[];
  active: T;
  panelId: string;
  onSelect: (value: T) => void;
  actions?: ReactNode;
  headerProps?: HTMLAttributes<HTMLDivElement>;
}) {
  return (
    <div
      {...headerProps}
      className={`bot-navigation-header bot-tree-section-heading ${headerProps?.className ?? ''}`}
    >
      <div
        className="bot-navigation-modes"
        role="tablist"
        aria-label={label}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const index = tabs.findIndex((tab) => tab.value === active);
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? tabs.length - 1
                : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
          onSelect(tabs[next].value);
          event.currentTarget
            .querySelector<HTMLElement>(`[data-navigation-mode="${tabs[next].value}"]`)
            ?.focus();
        }}
      >
        {tabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            id={`${panelId}-${tab.value}`}
            data-navigation-mode={tab.value}
            aria-selected={tab.value === active}
            aria-controls={panelId}
            aria-label={tab.accessibleName}
            tabIndex={tab.value === active ? 0 : -1}
            onClick={() => onSelect(tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {actions}
    </div>
  );
}
