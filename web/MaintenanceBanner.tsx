import { useEffect, useState } from 'react';
import { api, maintenanceChangedEvent } from './api.js';

type Maintenance = {
  status: 'open' | 'closed';
  epoch: number;
  reason?: string;
  activeWork: number;
  forcedClosed: boolean;
};

/** Says plainly that writes are paused, so a rejected save never looks like a lost draft. */
export function MaintenanceBanner() {
  const [state, setState] = useState<Maintenance | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const next = await api<Maintenance>('/maintenance');
        if (!alive) return;
        setState(next);
        // Poll only while closed, so an open workspace keeps its usual request pattern.
        if (next.status === 'closed') timer = setTimeout(() => void refresh(), 15_000);
      } catch {
        /* A status read failure keeps the last known state and the usual request errors. */
      }
    };
    const changed = () => {
      clearTimeout(timer);
      void refresh();
    };
    void refresh();
    window.addEventListener(maintenanceChangedEvent, changed);
    return () => {
      alive = false;
      clearTimeout(timer);
      window.removeEventListener(maintenanceChangedEvent, changed);
    };
  }, []);
  if (!state || state.status !== 'closed') return null;
  return (
    <div className="maintenance-banner" role="status">
      <strong>유지보수 중이에요.</strong> 새 저장·생성·가져오기를 잠시 받지 않아요. 읽기와 진행 중인
      작업의 취소는 그대로 사용할 수 있고, 작성 중인 내용은 지우지 않아요.
      {state.activeWork > 0 && ` 진행 중인 작업 ${state.activeWork}개가 끝나는 중이에요.`}
    </div>
  );
}
