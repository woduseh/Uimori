import { useCallback, useEffect, useId, useState } from 'react';
import { api, rememberMaintenance, type MaintenanceStatus } from './api.js';

type Maintenance = MaintenanceStatus & { activeWork?: number };

/** The operator's own gate for an update: it pauses new work without stopping the app. */
export function MaintenanceControl() {
  const id = useId();
  const [state, setState] = useState<Maintenance | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setState(await api<Maintenance>('/maintenance'));
    } catch (caught) {
      setError((caught as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const change = async (status: 'open' | 'closed') => {
    setBusy(true);
    setError('');
    try {
      const next = await api<Maintenance>('/maintenance', { status });
      setState(next);
      setConfirming(false);
      rememberMaintenance(next);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!state) return null;
  const closed = state.status === 'closed';
  return (
    <section aria-label="유지보수 모드">
      <h3>유지보수 모드</h3>
      <p className="muted" id={`${id}-help`}>
        업데이트 전에 새 저장·생성·가져오기만 멈춰요. 읽기와 진행 중인 작업의 취소는 그대로 사용할
        수 있고, 이미 시작한 작업은 끝까지 저장돼요. 닫은 상태는 서버를 다시 시작해도 유지돼요.
      </p>
      <p role="status">
        현재 <strong>{closed ? '닫힘 · 새 작업을 받지 않아요' : '열림 · 정상 사용 중'}</strong>
        {closed && ` · 유지보수 ${state.epoch}회차`}
        {!!state.activeWork && ` · 정리 중인 작업 ${state.activeWork}개`}
      </p>
      {state.forcedClosed ? (
        <p className="muted">
          후보 검증 부팅(<code>NR_MAINTENANCE=1</code>)이라 이 화면에서 열 수 없어요.
        </p>
      ) : closed ? (
        <button type="button" disabled={busy} onClick={() => void change('open')}>
          쓰기 재개
        </button>
      ) : confirming ? (
        <div className="archive-backup-option">
          <button type="button" disabled={busy} onClick={() => void change('closed')}>
            유지보수 시작
          </button>
          <button type="button" className="secondary" onClick={() => setConfirming(false)}>
            취소
          </button>
          <p className="muted">다른 기기에서도 새 저장이 거절돼요.</p>
        </div>
      ) : (
        <button
          type="button"
          className="secondary"
          aria-describedby={`${id}-help`}
          onClick={() => setConfirming(true)}
        >
          유지보수 시작
        </button>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
