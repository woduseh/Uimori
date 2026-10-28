import { useId, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { t, useI18n, formatNumber } from './i18n.js';
import './activity-navigation.css';

type ActivitySectionId = 'unread' | 'running' | 'recent';
const sectionStorageKey = 'uimori:activity-sections:v1';
const initialExpanded: Record<ActivitySectionId, boolean> = {
  unread: true,
  running: true,
  recent: true,
};
function readExpanded(id: ActivitySectionId, storageKey: string) {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    return stored &&
      typeof stored === 'object' &&
      !Array.isArray(stored) &&
      typeof (stored as Record<string, unknown>)[id] === 'boolean'
      ? (stored as Record<string, boolean>)[id]
      : initialExpanded[id];
  } catch {
    return initialExpanded[id];
  }
}
/** The section keeps its shown count while folded; reopening never starts over. */
export function ActivitySection({
  id,
  storageKey = sectionStorageKey,
  label,
  total,
  children,
  empty,
}: {
  id: ActivitySectionId;
  storageKey?: string;
  label: string;
  total: number;
  children: (limit: number) => ReactNode;
  empty: string;
}) {
  useI18n();
  const [expanded, setExpanded] = useState(() => readExpanded(id, storageKey));
  const [limit, setLimit] = useState(5);
  const contentsId = useId();
  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    try {
      const previous: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
      const saved =
        previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {};
      localStorage.setItem(storageKey, JSON.stringify({ ...saved, [id]: next }));
    } catch {
      // Navigation must still work when optional presentation storage is disabled.
    }
  };
  return (
    <section className="activity-nav-section" data-activity-section={id}>
      <button
        type="button"
        className="activity-nav-heading"
        aria-expanded={expanded}
        aria-controls={contentsId}
        onClick={toggle}
      >
        <span className="activity-nav-heading-label">
          {expanded ? (
            <ChevronDown size={14} aria-hidden="true" />
          ) : (
            <ChevronRight size={14} aria-hidden="true" />
          )}
          <strong>{label}</strong>
        </span>
        <span>{formatNumber(total)}</span>
      </button>
      <div id={contentsId} hidden={!expanded}>
        {expanded && (total ? children(limit) : <p className="activity-nav-empty">{empty}</p>)}
        {expanded && limit < total && (
          <button
            type="button"
            className="activity-nav-more"
            onClick={() => setLimit((current) => Math.min(current + 20, total))}
          >
            <ChevronDown size={14} aria-hidden="true" />
            {t('helpers.m331', { count: formatNumber(Math.min(20, total - limit)) })}
          </button>
        )}
      </div>
    </section>
  );
}
