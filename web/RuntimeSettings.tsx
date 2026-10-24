import { t, translateMessage, useI18n, messageRef, message as uiMessage } from './i18n.js';
import { TransientNotice } from './TransientNotice.js';
import { NoticeBanner } from './NoticeBanner.js';
import { Dialog } from './Dialog.js';
import { DraftDiscardActions } from './DraftDiscardActions.js';
import { useSettingsSaveHandler, type SettingsSaveRegistration } from './useSettingsSaveHandler.js';
import { RefreshIcon } from './ui-icons.js';
import { SaveButton } from './SaveButton.js';
import './settings-actions.css';
import { useEffect, useRef, useState } from 'react';
import type { Chat, Settings } from '../core/types.js';
import type { AutoTranslationDefaults } from '../core/chat-settings.js';
import { api } from './api.js';
export function SettingsEditor({
  chat,
  onSaved,
  onError,
  onDirtyChange,
  onSaveHandlerChange,
  hideHeading = false,
  hideSaveActions = false,
  onSaveRequest,
  disabled = false,
}: {
  chat: Chat;
  onSaved: () => Promise<void>;
  onError: (e: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSaveHandlerChange?: SettingsSaveRegistration;
  hideHeading?: boolean;
  hideSaveActions?: boolean;
  onSaveRequest?: () => void;
  disabled?: boolean;
}) {
  useI18n();
  const form = useRef<HTMLFormElement>(null);
  const [value, setValue] = useState<Settings>(chat.settings);
  const [revision, setRevision] = useState(chat.settingsRevision);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [localError, setLocalError] = useState('');
  const [confirmReload, setConfirmReload] = useState(false);
  const [globalAutoTranslate, setGlobalAutoTranslate] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    void api<AutoTranslationDefaults>('/auto-translation-defaults')
      .then((value) => {
        if (active) setGlobalAutoTranslate(value.autoTranslate);
      })
      .catch(() => {
        // Failure to read a label must not block the chat's independent settings editor.
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    onDirtyChange?.(dirty || saving);
  }, [dirty, saving, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useSettingsSaveHandler(onSaveHandlerChange, save);
  useEffect(() => {
    if (!dirty && chat.settingsRevision >= revision) {
      setValue(chat.settings);
      setRevision(chat.settingsRevision);
    }
  }, [chat.settings, chat.settingsRevision, dirty, revision]);
  function update<K extends keyof Settings>(key: K, next: Settings[K]) {
    setDirty(true);
    setMessage('');
    setValue((old) => ({ ...old, [key]: next }));
  }
  async function save() {
    if (saving) return false;
    if (!dirty) return true;
    if (!form.current?.reportValidity()) return false;
    if (!Number.isInteger(value.maxCalls) || value.maxCalls < 1 || value.maxCalls > 32) {
      setLocalError(uiMessage('settings.m78'));
      return false;
    }
    setSaving(true);
    setLocalError('');
    try {
      const saved = await api<Chat>(
        `/chats/${chat.id}/settings`,
        { ...value, expectedSettingsRevision: revision },
        'PATCH'
      );
      setValue(saved.settings);
      setRevision(saved.settingsRevision);
      setDirty(false);
      setMessage(uiMessage('settings.m79'));
      onError('');
      // Persisted; the refresh below is not an unsaved draft.
      setSaving(false);
      // Complete the acknowledged save before its independent reader refresh.
      void onSaved().catch((error) => {
        setLocalError(uiMessage('settings.m80', { v0: messageRef((error as Error).message) }));
      });
      return true;
    } catch (error) {
      const text = (error as Error).message;
      setLocalError(text);
      return false;
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="settings" aria-label={t('settings.m81')}>
      {!hideHeading && <h3>{t('settings.m82')}</h3>}
      <small>{t('settings.m83')}</small>
      <form
        ref={form}
        onSubmit={(event) => {
          event.preventDefault();
          if (onSaveRequest) onSaveRequest();
          else void save();
        }}
      >
        <fieldset className="editor-fields full chat-runtime-fields" disabled={saving || disabled}>
          <div className="settings-group full">
            <h4 className="settings-group-heading">{t('settings.m84')}</h4>
            <div className="settings-group-body">
              <label className="settings-row">
                <span className="settings-row-copy">
                  <strong>{t('settings.m85')}</strong>
                  <small>{t('settings.m86')}</small>
                  {globalAutoTranslate !== null && (
                    <small>
                      {t('settings.flow2', {
                        v0: globalAutoTranslate ? t('settings.m73') : t('settings.m74'),
                      })}
                    </small>
                  )}
                </span>
                <select
                  aria-label={t('settings.m85')}
                  value={
                    value.autoTranslate === undefined
                      ? 'inherit'
                      : value.autoTranslate
                        ? 'on'
                        : 'off'
                  }
                  onChange={(event) =>
                    update(
                      'autoTranslate',
                      event.target.value === 'inherit' ? undefined : event.target.value === 'on'
                    )
                  }
                >
                  <option value="inherit">{t('settings.m88')}</option>
                  <option value="on">{t('settings.m89')}</option>
                  <option value="off">{t('settings.m90')}</option>
                </select>
              </label>
            </div>
          </div>
          <details className="settings-group full">
            <summary>{t('settings.m91')}</summary>
            <div className="settings-group-body">
              <label className="settings-row">
                <span className="settings-row-copy">
                  <strong>{t('settings.m92')}</strong>
                  <small>{t('settings.m93')}</small>
                </span>
                <input
                  type="number"
                  aria-label={t('settings.m92')}
                  min={1}
                  max={32}
                  step={1}
                  required
                  value={Number.isFinite(value.maxCalls) ? value.maxCalls : ''}
                  onChange={(event) => update('maxCalls', event.target.valueAsNumber)}
                />
              </label>
            </div>
          </details>
          <div
            className="form-actions full settings-save-actions"
            hidden={hideSaveActions && !dirty}
          >
            {dirty && (
              <button type="button" className="secondary" onClick={() => setConfirmReload(true)}>
                <RefreshIcon size={18} aria-hidden="true" />
                {t('settings.m94')}
              </button>
            )}
            {!hideSaveActions && (
              <SaveButton
                label={t('settings.m95')}
                disabled={!dirty || saving}
                aria-busy={saving}
              />
            )}
          </div>
        </fieldset>
        <TransientNotice message={hideSaveActions ? '' : message} />
        {localError && (
          <NoticeBanner tone="error" className="full">
            {translateMessage(localError)}
          </NoticeBanner>
        )}
      </form>
      <Dialog
        open={confirmReload}
        title={t('settings.m96')}
        variant="confirmation"
        role="alertdialog"
        onClose={() => {
          if (!saving) setConfirmReload(false);
        }}
      >
        <p>{t('settings.m97')}</p>
        <DraftDiscardActions
          open={confirmReload}
          disabled={saving}
          onContinue={() => setConfirmReload(false)}
          onDiscard={() => {
            setValue(chat.settings);
            setRevision(chat.settingsRevision);
            setDirty(false);
            setLocalError('');
            setMessage('');
            onError('');
            setConfirmReload(false);
          }}
          discardLabel={t('settings.m98')}
        />
      </Dialog>
    </section>
  );
}
