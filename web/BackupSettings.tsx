import './scheduled-backups.css';
import { useEffect, useState } from 'react';
import { DatabaseBackup, Download, RefreshCw } from 'lucide-react';
import type { BackupSettings as Settings, BackupStatus } from '../core/backups.js';
import { api } from './api.js';
import { Switch } from './BooleanControls.js';
import { SaveButton } from './SaveButton.js';
import { Dialog } from './Dialog.js';
import { DraftDiscardActions } from './DraftDiscardActions.js';
import { useSettingsSaveHandler, type SettingsSaveRegistration } from './useSettingsSaveHandler.js';

const date = (value: string) =>
  new Date(value).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
export function BackupSettings({
  onDirtyChange,
  onSaveHandlerChange,
}: {
  onDirtyChange?: (dirty: boolean) => void;
  onSaveHandlerChange?: SettingsSaveRegistration;
}) {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [confirmReload, setConfirmReload] = useState(false);
  function reloadSettings() {
    setConfirmReload(false);
    setError('');
    setDraft(null);
    setDirty(false);
    setReload((value) => value + 1);
  }
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
  const invalid =
    !!draft &&
    (!Number.isInteger(draft.retain) ||
      draft.retain < 1 ||
      draft.retain > 30 ||
      !Number.isInteger(draft.hour) ||
      draft.hour < 0 ||
      draft.hour > 23 ||
      !Number.isInteger(draft.minute) ||
      draft.minute < 0 ||
      draft.minute > 59);
  const change = (value: Partial<Settings>) => {
    setDraft((old) => old && { ...old, ...value });
    setDirty(true);
  };
  async function save(): Promise<boolean> {
    if (!draft || invalid || busy) return false;
    if (!dirty) return true;
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
      return true;
    } catch (caught) {
      setError((caught as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  useSettingsSaveHandler(onSaveHandlerChange, save);
  async function start() {
    if (busy) return;
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
    <section
      className="settings-card archive-management-card scheduled-backups"
      aria-label="자동 백업"
    >
      <header className="backup-heading">
        <div>
          <h3>자동 백업</h3>
          <p className="muted">매일 서버에 복구용 사본을 보관해요.</p>
        </div>
        {draft && (
          <Switch
            aria-label="매일 자동 백업"
            checked={draft.enabled}
            disabled={busy}
            onChange={(event) => change({ enabled: event.target.checked })}
          />
        )}
      </header>
      {draft && (
        <fieldset disabled={busy}>
          <div className="backup-fields">
            {draft.enabled && (
              <label>
                백업 시간 <small>한국 시간</small>
                <input
                  type="time"
                  aria-label="백업 시간"
                  required
                  value={
                    Number.isFinite(draft.hour + draft.minute)
                      ? `${String(draft.hour).padStart(2, '0')}:${String(draft.minute).padStart(2, '0')}`
                      : ''
                  }
                  onChange={(event) => {
                    const [hour, minute] = event.target.value
                      ? event.target.value.split(':').map(Number)
                      : [NaN, NaN];
                    change({ hour, minute });
                  }}
                />
              </label>
            )}
            <label>
              보관 개수 <small>1–30개</small>
              <input
                type="number"
                min={1}
                max={30}
                required
                aria-label="성공본 보관 개수"
                value={Number.isFinite(draft.retain) ? draft.retain : ''}
                aria-invalid={
                  !Number.isInteger(draft.retain) || draft.retain < 1 || draft.retain > 30
                }
                onChange={(event) => change({ retain: event.target.valueAsNumber })}
              />
            </label>
          </div>
          {invalid && (
            <p role="alert" className="error">
              백업 시간과 보관 개수를 확인해 주세요.
            </p>
          )}
        </fieldset>
      )}
      {status && (
        <>
          <dl className="backup-status" aria-live="polite">
            <div>
              <dt>최근 백업</dt>
              <dd>
                {status.status === 'running'
                  ? '생성·검증 중…'
                  : status.lastSuccess
                    ? `${date(status.lastSuccess.createdAt)} · 성공`
                    : '아직 없음'}
              </dd>
            </div>
            <div>
              <dt>다음 백업</dt>
              <dd>
                {status.settings.nextRunAt ? date(status.settings.nextRunAt) : '예약 안 함'}
                {dirty && <small>저장된 설정 기준</small>}
              </dd>
            </div>
          </dl>
          {status.error && (
            <p role="alert" className="error">
              {status.error}
            </p>
          )}
          {status.warning && <p role="status">{status.warning}</p>}
          <div className="backup-actions">
            <button
              type="button"
              disabled={busy || status.status === 'running'}
              onClick={() => void start()}
            >
              <DatabaseBackup size={16} aria-hidden="true" /> 지금 백업
            </button>
            <SaveButton
              type="button"
              label="백업 설정 저장"
              text={busy ? '처리 중…' : '설정 저장'}
              disabled={busy || !dirty || invalid}
              onClick={() => void save()}
            />
          </div>
          {status.backups.length ? (
            <details className="backup-list">
              <summary>
                저장된 백업 <span>{status.backups.length}개</span>
              </summary>
              {status.backups.map((item) => (
                <div key={item.id} className="archive-action-row">
                  <span>
                    {date(item.createdAt)}
                    <small>
                      {(item.bytes / 1048576).toFixed(1)} MiB · DB {item.schema}
                    </small>
                  </span>
                  <a
                    href={`/api/backups/${item.id}/download`}
                    download
                    aria-label={`${date(item.createdAt)} 백업 다운로드`}
                  >
                    <Download size={16} aria-hidden="true" /> 다운로드
                  </a>
                </div>
              ))}
            </details>
          ) : (
            <div className="backup-empty">
              <span>저장된 백업</span>
              <span>0개</span>
            </div>
          )}
          <small className="muted">서버 장애에 대비한 백업은 별도 기기에 보관해 주세요.</small>
        </>
      )}
      {!status && !error && <p role="status">백업 설정을 불러오는 중…</p>}
      {error && (
        <div className="settings-service-error">
          <p role="alert" className="error">
            {error}
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (dirty) setConfirmReload(true);
              else reloadSettings();
            }}
          >
            <RefreshCw size={16} aria-hidden="true" /> 다시 확인
          </button>
        </div>
      )}
      <Dialog
        open={confirmReload}
        title="백업 설정 변경 버리기"
        variant="confirmation"
        role="alertdialog"
        onClose={() => setConfirmReload(false)}
      >
        <p>작성 중인 백업 설정을 버리고 최신 설정을 불러올까요?</p>
        <DraftDiscardActions
          open={confirmReload}
          disabled={busy}
          onContinue={() => setConfirmReload(false)}
          onDiscard={reloadSettings}
          discardLabel="초안 버리고 불러오기"
        />
      </Dialog>
    </section>
  );
}
