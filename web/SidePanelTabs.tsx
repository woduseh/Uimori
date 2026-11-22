import { useI18n } from './i18n.js';
import { IconButton } from './IconButton.js';
import { CloseIcon } from './ui-icons.js';
import type { SidePanelTab } from './side-panel.js';

export const sidePanelSurfaceIds: Record<SidePanelTab, string> = {
  helper: 'helper-panel',
  outline: 'outline-panel',
  options: 'chat-prompt-options',
};

export function focusSidePanelTab(tab: SidePanelTab) {
  const target = [...document.querySelectorAll<HTMLElement>(`[data-side-panel-tab="${tab}"]`)].find(
    (node) => node.checkVisibility()
  );
  target?.focus({ preventScroll: true });
}

export function sidePanelTabsShown() {
  return [...document.querySelectorAll<HTMLElement>('[data-side-panel-tab]')].some((node) =>
    node.checkVisibility()
  );
}

export function SidePanelTabs({
  tabs,
  active,
  closeLabel,
  onSelect,
  onClose,
}: {
  tabs: SidePanelTab[];
  active: SidePanelTab;
  closeLabel: string;
  onSelect: (tab: SidePanelTab) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const labels: Record<SidePanelTab, string> = {
    helper: t('main.m062'),
    outline: t('main.m007'),
    options: t('main.m121'),
  };
  return (
    <div className="side-panel-tabs">
      <div
        role="tablist"
        aria-label={t('workspace.sidePanel')}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const index = tabs.indexOf(active);
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? tabs.length - 1
                : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
          onSelect(tabs[next]);
        }}
      >
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            data-side-panel-tab={tab}
            aria-selected={tab === active}
            aria-controls={sidePanelSurfaceIds[tab]}
            tabIndex={tab === active ? 0 : -1}
            onClick={() => onSelect(tab)}
          >
            {labels[tab]}
          </button>
        ))}
      </div>
      <IconButton label={closeLabel} icon={CloseIcon} onClick={onClose} />
    </div>
  );
}
