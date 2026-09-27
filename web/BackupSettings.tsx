import { useEffect, useState } from 'react';
import type { BackupSettings as Settings, BackupStatus } from '../core/backups.js';
import { api } from './api.js';

const date = (value: string) => new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
export function BackupSettings({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    onDirtyChange?.(dirty || busy);
  }, [dirty, busy, onDirtyChange]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit refresh restarts this bounded status read.
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const value = await api<BackupStatus>('/backups', undefined, 'GET', controller.signal);
        if (controller.signal.aborted) return;
        setStatus(value);
        setDraft((old) => old ?? value.settings);
        if (value.status === 'running') timer = setTimeout(() => void load(), 1500);
      } catch (caught) {
        if (!controller.signal.aborted) setError((caught as Error).message);
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [reload]);
  const change = (value: Partial<Settings>) => {
    setDraft((old) => old && { ...old, ...value });
    setDirty(true);
  };
  async function save() {
    if (!draft) return;
    setBusy(true);
    setError('');
    try {
      const saved = await api<Settings>(
        '/backups/settings',
        {
          expectedRevision: draft.revision,
          enabled: draft.enabled,
          hour: draft.hour,
          minute: draft.minute,
          retain: draft.retain,
        },
        'PUT'
      );
      setDraft(saved);
      setDirty(false);
      setReload((value) => value + 1);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function start() {
    setBusy(true);
    setError('');
    try {
      await api('/backups', {});
      setReload((value) => value + 1);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-card archive-management-card" aria-label="자동 백업">
      <header className="archive-card-heading">
        <h3>자동 백업</h3>
        <p className="muted">
          서버의 별도 저장 위치에 복구 지점을 남겨요. 같은 서버의 백업은 디스크 손실에 대비한 외부
          백업은 아니에요.
        </p>
      </header>
      {draft && (
        <fieldset disabled={busy}>
          <label>
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => change({ enabled: event.target.checked })}
            />{' '}
            매일 자동 백업
          </label>
          <div className="archive-action-row">
            <label>
              백업 시각 · 한국 시간{' '}
              <input
                type="time"
                value={`${String(draft.hour).padStart(2, '0')}:${String(draft.minute).padStart(2, '0')}`}
                onChange={(event) => {
                  const [hour, minute] = event.target.value.split(':').map(Number);
                  change({ hour, minute });
                }}
              />
            </label>
            <label>
              성공본 보관 개수{' '}
              <input
                type="number"
                min={1}
                max={30}
                value={draft.retain}
                onChange={(event) => change({ retain: Number(event.target.value) })}
              />
            </label>
            <button type="button" disabled={!dirty} onClick={() => void save()}>
              백업 설정 저장
            </button>
          </div>
        </fieldset>
      )}
      {status && (
        <>
          <p role="status">
            {status.status === 'running'
              ? '백업 생성·검증 중…'
              : status.lastSuccess
                ? `마지막 성공: ${date(status.lastSuccess.createdAt)}`
                : '아직 자동 백업 성공 기록이 없어요.'}
          </p>
          {status.settings.nextRunAt && (
            <p className="muted">다음 예정: {date(status.settings.nextRunAt)}</p>
          )}
          {status.error && (
            <p role="alert" className="error">
              {status.error}
            </p>
          )}
          {status.warning && <p role="status">{status.warning}</p>}
          <button
            type="button"
            disabled={busy || status.status === 'running'}
            onClick={() => void start()}
          >
            지금 백업
          </button>
          <details>
            <summary>저장된 백업 {status.backups.length}개</summary>
            {status.backups.map((item) => (
              <div key={item.id} className="archive-action-row">
                <span>
                  {date(item.createdAt)} · {(item.bytes / 1048576).toFixed(1)} MiB · DB{' '}
                  {item.schema}
                </span>
                <a href={`/api/backups/${item.id}/download`} download>
                  다운로드
                </a>
              </div>
            ))}
          </details>
        </>
      )}
      {error && (
        <p role="alert" className="error">
          {error}{' '}
          <button
            type="button"
            onClick={() => {
              setError('');
              setReload((value) => value + 1);
            }}
          >
            다시 확인
          </button>
        </p>
      )}
    </section>
  );
}
