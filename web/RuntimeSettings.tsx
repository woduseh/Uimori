import { t, translateMessage, useI18n, messageRef, message as uiMessage } from './i18n.js';
import { TransientNotice } from './TransientNotice.js';
import { NoticeBanner } from './NoticeBanner.js';
import { Dialog } from './Dialog.js';
import { DraftDiscardActions } from './DraftDiscardActions.js';
import { useSettingsSaveHandler, type SettingsSaveRegistration } from './useSettingsSaveHandler.js';
import { UndoIcon } from './ui-icons.js';
import { SaveButton } from './SaveButton.js';
import { Switch } from './BooleanControls.js';
import './settings-actions.css';
import { useEffect, useRef, useState } from 'react';
import type { Chat, Settings } from '../core/types.js';
import { MAX_MAIN_MODEL_CALLS, type AutoTranslationDefaults } from '../core/chat-settings.js';
import { api } from './api.js';
import { StoryUiStyleSelect } from './StoryUiStyleSelect.js';
export function SettingsEditor({
  chat,
  onSaved,
  onError,
  onDirtyChange,
  onSaveHandlerChange,
  onDiscardHandlerChange,
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
  onDiscardHandlerChange?: SettingsSaveRegistration;
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
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    onDirtyChange?.(dirty || saving);
  }, [dirty, saving, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useSettingsSaveHandler(onSaveHandlerChange, save);
  useSettingsSaveHandler(onDiscardHandlerChange, async () => {
    discard();
    return true;
  });
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
  function discard() {
    setValue(chat.settings);
    setRevision(chat.settingsRevision);
    setDirty(false);
    setLocalError('');
    setMessage('');
    onError('');
  }
  async function save() {
    if (saving) return false;
    if (!dirty) return true;
    if (!form.current?.reportValidity()) return false;
    if (
      !Number.isInteger(value.maxCalls) ||
      value.maxCalls < 1 ||
      value.maxCalls > MAX_MAIN_MODEL_CALLS
    ) {
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
      setSaving(false);
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
            <div className="settings-group-body">
              <label className="settings-row">
                <span className="settings-row-copy">
                  <strong>{t('settings.m85')}</strong>
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
                  <option value="inherit">
                    {globalAutoTranslate === null
                      ? t('settings.m88')
                      : t('library.globalValue', {
                          value: globalAutoTranslate ? t('settings.m73') : t('settings.m74'),
                        })}
                  </option>
                  <option value="on">{t('settings.m89')}</option>
                  <option value="off">{t('settings.m90')}</option>
                </select>
              </label>
              <label className="settings-row settings-row-toggle">
                <span className="settings-row-copy">
                  <strong>{t('storyUi.enable')}</strong>
                </span>
                <span className="settings-row-control">
                  <Switch
                    aria-label={t('storyUi.enable')}
                    checked={value.storyUi === true}
                    onChange={(event) => update('storyUi', event.target.checked)}
                  />
                </span>
              </label>
              {value.storyUi === true && (
                <label className="settings-row">
                  <span className="settings-row-copy">
                    <strong>{t('storyUi.style')}</strong>
                  </span>
                  <StoryUiStyleSelect
                    value={value.storyUiStyle ?? 'auto'}
                    onChange={(style) => update('storyUiStyle', style)}
                  />
                </label>
              )}
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
                  max={MAX_MAIN_MODEL_CALLS}
                  step={1}
                  required
                  value={Number.isFinite(value.maxCalls) ? value.maxCalls : ''}
                  onChange={(event) => update('maxCalls', event.target.valueAsNumber)}
                />
              </label>
            </div>
          </details>
          {!hideSaveActions && (
            <div className="form-actions full settings-save-actions">
              {dirty && (
                <button type="button" className="secondary" onClick={() => setConfirmReload(true)}>
                  <UndoIcon size={18} aria-hidden="true" />
                  {t('settings.m94')}
                </button>
              )}
              <SaveButton
                label={t('settings.m95')}
                disabled={!dirty || saving}
                aria-busy={saving}
              />
            </div>
          )}
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
            discard();
            setConfirmReload(false);
          }}
          discardLabel={t('settings.m98')}
        />
      </Dialog>
    </section>
  );
}
