import { useId, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { t, useI18n, formatNumber } from './i18n.js';
import './activity-navigation.css';
import { readOptionalJson, writeOptionalStorage } from './optional-storage.js';

type ActivitySectionId = 'unread' | 'running' | 'recent';
const sectionStorageKey = 'uimori:activity-sections:v1';
const initialExpanded: Record<ActivitySectionId, boolean> = {
  unread: true,
  running: true,
  recent: true,
};
function storedSections(storageKey: string): Record<string, unknown> {
  const stored = readOptionalJson('local', storageKey, null);
  return stored && typeof stored === 'object' && !Array.isArray(stored)
    ? (stored as Record<string, unknown>)
    : {};
}
function readExpanded(id: ActivitySectionId, storageKey: string) {
  const stored = storedSections(storageKey)[id];
  return typeof stored === 'boolean' ? stored : initialExpanded[id];
}
export function ActivitySection({
  id,
  storageKey = sectionStorageKey,
  label,
  total,
  children,
  empty,
  action,
}: {
  id: ActivitySectionId;
  storageKey?: string;
  label: string;
  total: number;
  children: (limit: number) => ReactNode;
  empty?: string;
  action?: ReactNode;
}) {
  useI18n();
  const [expanded, setExpanded] = useState(() => readExpanded(id, storageKey));
  const [limit, setLimit] = useState(5);
  const contentsId = useId();
  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    writeOptionalStorage(
      'local',
      storageKey,
      JSON.stringify({ ...storedSections(storageKey), [id]: next })
    );
  };
  if (!total && !empty) return null;
  return (
    <section className="activity-nav-section" data-activity-section={id}>
      <div className="activity-nav-heading-row">
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
        {action}
      </div>
      <div id={contentsId} className="activity-nav-contents" hidden={!expanded}>
        {expanded &&
          (total ? children(limit) : empty && <p className="activity-nav-empty">{empty}</p>)}
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
