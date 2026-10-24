import { t, useI18n, translateMessage, message as retainedMessage } from './i18n.js';
import { BackupSettings } from './BackupSettings.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BackupFileImport } from './BackupFileImport.js';
import { DownloadIcon } from './ui-icons.js';
import {
  useSettingsSaveHandler,
  type SettingsSaveHandler,
  type SettingsSaveRegistration,
} from './useSettingsSaveHandler.js';

export function ArchivePanel({
  onImported,
  onError,
  onDirtyChange,
  onSaveHandlerChange,
  expanded = false,
}: {
  onImported: () => Promise<void>;
  onError: (error: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSaveHandlerChange?: SettingsSaveRegistration;
  expanded?: boolean;
}) {
  useI18n();
  const [busy, setBusy] = useState(false);
  const [importDirty, setImportDirty] = useState(false);
  const [backupDirty, setBackupDirty] = useState(false);
  const [error, setError] = useState('');
  const backupSave = useRef<SettingsSaveHandler | null>(null);
  const registerBackupSave = useCallback<SettingsSaveRegistration>((handler) => {
    backupSave.current = handler;
  }, []);
  useEffect(() => {
    onDirtyChange?.(busy || importDirty || backupDirty);
  }, [busy, importDirty, backupDirty, onDirtyChange]);
  useSettingsSaveHandler(onSaveHandlerChange, async () => {
    if (importDirty)
      throw new Error(
        '데이터 관리에 선택한 가져오기 파일이 있어요. 계속 편집에서 가져오기를 완료하거나 선택을 취소해 주세요.'
      );
    if (busy) return false;
    return !backupDirty || !!(await backupSave.current?.());
  });
  const Container = expanded ? 'section' : 'details';
  return (
    <Container
      className={expanded ? 'archive-settings' : 'workspace-tools'}
      data-testid="archive-panel"
      aria-label={t('transfer.m178')}
    >
      {!expanded && <summary>{t('transfer.m179')}</summary>}
      <section className="settings-group" aria-label={t('transfer.m180')}>
        <header className="settings-group-heading archive-card-heading">
          <h3>{t('transfer.m182')}</h3>
        </header>
        <div className="settings-group-body archive-management-card">
          <div className="archive-action-row settings-row">
            <div className="settings-row-copy">
              <p className="muted">{t('transfer.m183')}</p>
            </div>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError('');
                onError('');
                try {
                  const response = await fetch('/api/backup');
                  if (!response.ok)
                    throw new Error(retainedMessage('transfer.d010', { v0: response.status }));
                  const url = URL.createObjectURL(await response.blob());
                  const link = document.createElement('a');
                  link.href = url;
                  link.download = 'uimori-backup.sqlite';
                  link.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                } catch (caught) {
                  setError((caught as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <DownloadIcon size={18} aria-hidden="true" />
              {busy ? t('transfer.m184') : t('transfer.m185')}
            </button>
          </div>
          <details className="archive-restore-details">
            <summary>{t('transfer.m186')}</summary>
            <p className="muted">{t('transfer.m187')}</p>
          </details>
          {error && (
            <p role="alert" className="error">
              {translateMessage(error)}
            </p>
          )}
        </div>
      </section>
      <BackupSettings onDirtyChange={setBackupDirty} onSaveHandlerChange={registerBackupSave} />
      <BackupFileImport onImported={onImported} onDirtyChange={setImportDirty} disabled={busy} />
    </Container>
  );
}
