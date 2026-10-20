import {
  t,
  useI18n,
  translateMessage,
  formatDate,
  formatNumber,
  message as retainedMessage,
} from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { TransientNotice } from './TransientNotice.js';
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
  formatDate(new Date(value), {
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
  useI18n();
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [operation, setOperation] = useState<'save' | 'backup' | null>(null);
  const busy = operation !== null;
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [reload, setReload] = useState(0);
  const [confirmReload, setConfirmReload] = useState(false);
  function reloadSettings() {
    setConfirmReload(false);
    setError('');
    setMessage('');
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
    setMessage('');
  };
  async function save(): Promise<boolean> {
    if (!draft || invalid || busy) return false;
    if (!dirty) return true;
    setOperation('save');
    setError('');
    setMessage('');
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
      setMessage(retainedMessage('transfer.m150'));
      setReload((value) => value + 1);
      return true;
    } catch (caught) {
      setError((caught as Error).message);
      return false;
    } finally {
      setOperation(null);
    }
  }
  useSettingsSaveHandler(onSaveHandlerChange, save);
  async function start() {
    if (busy) return;
    setOperation('backup');
    setError('');
    try {
      await api('/backups', {});
      setReload((value) => value + 1);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setOperation(null);
    }
  }
  return (
    <section className="settings-group scheduled-backups" aria-label={t('transfer.m151')}>
      <header className="settings-group-heading">
        <h3>{t('transfer.m151')}</h3>
      </header>
      <div className="settings-group-body archive-management-card">
        <div className="backup-heading settings-row settings-row-toggle">
          <div className="settings-row-copy">
            <strong>{t('transfer.m152')}</strong>
            <p className="muted">{t('transfer.m153')}</p>
          </div>
          {draft && (
            <Switch
              aria-label={t('transfer.m152')}
              checked={draft.enabled}
              disabled={busy}
              onChange={(event) => change({ enabled: event.target.checked })}
            />
          )}
        </div>
        {draft && (
          <fieldset disabled={busy}>
            <div className="backup-fields">
              {draft.enabled && (
                <label>
                  <span>
                    {t('transfer.m154')}
                    <small>{t('transfer.m155')}</small>
                  </span>
                  <input
                    type="time"
                    aria-label={t('transfer.m154')}
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
                <span>
                  {t('transfer.m156')}
                  <small>{t('transfer.m157')}</small>
                </span>
                <input
                  type="number"
                  min={1}
                  max={30}
                  required
                  aria-label={t('transfer.m158')}
                  value={Number.isFinite(draft.retain) ? draft.retain : ''}
                  aria-invalid={
                    !Number.isInteger(draft.retain) || draft.retain < 1 || draft.retain > 30
                  }
                  onChange={(event) => change({ retain: event.target.valueAsNumber })}
                />
              </label>
            </div>
            {invalid && <NoticeBanner tone="error">{t('transfer.m159')}</NoticeBanner>}
          </fieldset>
        )}
        {error && (
          <NoticeBanner
            tone="error"
            actions={
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (dirty) setConfirmReload(true);
                  else reloadSettings();
                }}
              >
                <RefreshCw size={16} aria-hidden="true" />
                {t('transfer.m160')}
              </button>
            }
          >
            {translateMessage(error)}
          </NoticeBanner>
        )}
        {status && (
          <>
            <dl className="backup-status" aria-live="polite">
              <div>
                <dt>{t('transfer.m161')}</dt>
                <dd>
                  {status.status === 'running'
                    ? t('transfer.m162')
                    : status.lastSuccess
                      ? t('transfer.d008', { v0: date(status.lastSuccess.createdAt) })
                      : t('transfer.m163')}
                </dd>
              </div>
              <div>
                <dt>{t('transfer.m164')}</dt>
                <dd>
                  {status.settings.nextRunAt ? date(status.settings.nextRunAt) : t('transfer.m165')}
                  {dirty && <small>{t('transfer.m166')}</small>}
                </dd>
              </div>
            </dl>
            {status.error && (
              <NoticeBanner tone="error">{translateMessage(status.error)}</NoticeBanner>
            )}
            {status.warning && <NoticeBanner>{translateMessage(status.warning)}</NoticeBanner>}
            <div className="backup-actions">
              <button
                type="button"
                disabled={busy || status.status === 'running'}
                onClick={() => void start()}
              >
                <DatabaseBackup size={16} aria-hidden="true" />
                {t('transfer.m167')}
              </button>
              <SaveButton
                type="button"
                label={t('transfer.m168')}
                aria-busy={operation === 'save'}
                disabled={busy || !dirty || invalid}
                onClick={() => void save()}
              />
            </div>
            {status.backups.length ? (
              <details className="backup-list">
                <summary>
                  {t('transfer.m169')}
                  <span>{t('transfer.count', { count: status.backups.length })}</span>
                </summary>
                {status.backups.map((item) => (
                  <div key={item.id} className="archive-action-row">
                    <span>
                      {date(item.createdAt)}
                      <small>
                        {t('transfer.backupSize', {
                          size: formatNumber(item.bytes / 1048576, {
                            minimumFractionDigits: 1,
                            maximumFractionDigits: 1,
                          }),
                          schema: item.schema,
                        })}
                      </small>
                    </span>
                    <a
                      href={`/api/backups/${item.id}/download`}
                      download
                      aria-label={t('transfer.d009', { v0: date(item.createdAt) })}
                    >
                      <Download size={16} aria-hidden="true" />
                      {t('transfer.m170')}
                    </a>
                  </div>
                ))}
              </details>
            ) : (
              <div className="backup-empty">
                <span>{t('transfer.m169')}</span>
                <span>{t('transfer.count', { count: 0 })}</span>
              </div>
            )}
            <small className="muted">{t('transfer.m172')}</small>
          </>
        )}
        {!status && !error && (
          <LoadingState presentation="placeholder" label={t('transfer.m173')} />
        )}
        <TransientNotice message={message} />
        <Dialog
          open={confirmReload}
          title={t('transfer.m174')}
          variant="confirmation"
          role="alertdialog"
          onClose={() => setConfirmReload(false)}
        >
          <p>{t('transfer.m175')}</p>
          <DraftDiscardActions
            open={confirmReload}
            disabled={busy}
            onContinue={() => setConfirmReload(false)}
            onDiscard={reloadSettings}
            discardLabel={t('transfer.m176')}
          />
        </Dialog>
      </div>
    </section>
  );
}
