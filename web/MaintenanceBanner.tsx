import { useI18n } from './i18n.js';
import { useEffect, useState } from 'react';
import { api, knownMaintenance, maintenanceChangedEvent, type MaintenanceStatus } from './api.js';
import { NoticeBanner } from './NoticeBanner.js';

type Maintenance = MaintenanceStatus & { activeWork?: number };

/** Says plainly that writes are paused, so a rejected save never looks like a lost draft. */
export function MaintenanceBanner() {
  const { t } = useI18n();
  const [state, setState] = useState<Maintenance | null>(knownMaintenance);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The session read owns the normal case; this screen only follows a gate it already knows
    // is closed, or a write the server just refused.
    const refresh = async () => {
      try {
        const next = await api<Maintenance>('/maintenance');
        if (!alive) return;
        setState(next);
        if (next.status === 'closed') timer = setTimeout(() => void refresh(), 15_000);
      } catch {
        /* A status read failure keeps the last known state and the usual request errors. */
      }
    };
    const changed = () => {
      clearTimeout(timer);
      const known = knownMaintenance();
      setState(known);
      if (known?.status === 'closed') void refresh();
    };
    if (knownMaintenance()?.status === 'closed') void refresh();
    window.addEventListener(maintenanceChangedEvent, changed);
    return () => {
      alive = false;
      clearTimeout(timer);
      window.removeEventListener(maintenanceChangedEvent, changed);
    };
  }, []);
  if (!state || state.status !== 'closed') return null;
  return (
    <NoticeBanner label={t('outside.maintenanceLabel')} className="maintenance-banner">
      <strong>{t('outside.maintenanceTitle')}</strong> {t('outside.maintenancePaused')}
      <details>
        <summary>{t('outside.details')}</summary>
        <p>
          {t('outside.maintenanceBody')}
          {!!state.activeWork && t('outside.activeWork', { count: state.activeWork })}
        </p>
      </details>
    </NoticeBanner>
  );
}
