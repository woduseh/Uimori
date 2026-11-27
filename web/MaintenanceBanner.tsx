import { useI18n } from './i18n.js';
import { useEffect, useState } from 'react';
import { type MaintenanceStatus, selfHostEndpoints } from '#contracts';
import { callEndpoint, knownMaintenance, maintenanceChangedEvent } from './api.js';
import { NoticeBanner } from './NoticeBanner.js';

type Maintenance = MaintenanceStatus & { activeWork?: number };

export function MaintenanceBanner() {
  const { t } = useI18n();
  const [state, setState] = useState<Maintenance | null>(knownMaintenance);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const next = await callEndpoint(selfHostEndpoints.readMaintenance);
        if (!alive) return;
        setState(next);
        if (next.status === 'closed') timer = setTimeout(() => void refresh(), 15_000);
      } catch {}
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
