import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ListChecks } from 'lucide-react';
import { t } from './i18n.js';

export function HelperPlanCard({ children, action }: { children: ReactNode; action?: ReactNode }) {
  const body = useRef<HTMLDivElement>(null);
  const bodyId = useId();
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const prose = body.current?.querySelector<HTMLElement>('.helper-prose');
    if (!prose || expanded) return;
    const measure = () => setOverflowing(prose.scrollHeight > prose.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(prose);
    for (const child of prose.children) observer.observe(child);
    return () => observer.disconnect();
  }, [expanded]);
  return (
    <section className="helper-plan" aria-label={t('helperPlan.title')} data-testid="helper-plan">
      <p className="helper-plan-title">
        <ListChecks size={16} aria-hidden="true" />
        <span>{t('helperPlan.title')}</span>
      </p>
      <div ref={body} id={bodyId} className="helper-plan-body" data-expanded={expanded}>
        {children}
      </div>
      {(overflowing || action) && (
        <div className="helper-plan-actions">
          {overflowing && (
            <button
              type="button"
              className="secondary helper-plan-toggle"
              aria-expanded={expanded}
              aria-controls={bodyId}
              onClick={() => setExpanded((value) => !value)}
            >
              <ChevronDown size={16} aria-hidden="true" />
              {t(expanded ? 'helperPlan.collapse' : 'helperPlan.expand')}
            </button>
          )}
          {action}
        </div>
      )}
    </section>
  );
}
