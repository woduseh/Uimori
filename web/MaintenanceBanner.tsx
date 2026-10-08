import { useEffect, useState } from 'react';
import { api, knownMaintenance, maintenanceChangedEvent, type MaintenanceStatus } from './api.js';
import { NoticeBanner } from './NoticeBanner.js';

type Maintenance = MaintenanceStatus & { activeWork?: number };

/** Says plainly that writes are paused, so a rejected save never looks like a lost draft. */
export function MaintenanceBanner() {
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
    <NoticeBanner label="유지보수 안내" className="maintenance-banner">
      <strong>유지보수 중이에요.</strong> 새 저장과 생성을 잠시 받지 않아요.
      <details>
        <summary>자세히</summary>
        <p>
          읽기와 진행 중인 작업의 취소는 사용할 수 있어요. 작성 중인 내용은 유지해요. 가져오기도
          잠시 중단해요.
          {!!state.activeWork && ` 진행 중인 작업 ${state.activeWork}개가 끝나는 중이에요.`}
        </p>
      </details>
    </NoticeBanner>
  );
}
