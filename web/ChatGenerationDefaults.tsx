import { useEffect, useRef, useState } from 'react';
import {
  MAX_MAIN_MODEL_CALLS,
  type ChatGenerationDefaults as Defaults,
} from '../core/chat-settings.js';
import { api } from './api.js';
import { Switch } from './BooleanControls.js';
import { Dialog } from './Dialog.js';
import { DraftDiscardActions } from './DraftDiscardActions.js';
import { message as uiMessage, t, translateMessage, useI18n } from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { SaveButton } from './SaveButton.js';
import { StoryUiStyleSelect } from './StoryUiStyleSelect.js';
import { TransientNotice } from './TransientNotice.js';
import { useSettingsSaveHandler, type SettingsSaveRegistration } from './useSettingsSaveHandler.js';

export function ChatGenerationDefaults({
  onDirtyChange,
  onSaveHandlerChange,
}: {
  onDirtyChange: (dirty: boolean) => void;
  onSaveHandlerChange: SettingsSaveRegistration;
}) {
  useI18n();
  const form = useRef<HTMLFormElement>(null);
  const [value, setValue] = useState<Defaults | null>(null);
  const [saved, setSaved] = useState<Defaults | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const [confirmReload, setConfirmReload] = useState(false);
  const dirty =
    !!value &&
    !!saved &&
    (value.maxCalls !== saved.maxCalls ||
      value.storyUi !== saved.storyUi ||
      value.storyUiStyle !== saved.storyUiStyle);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit retries reissue the read.
  useEffect(() => {
    let active = true;
    void api<Defaults>('/chat-generation-defaults')
      .then((next) => {
        if (!active) return;
        setValue(next);
        setSaved(next);
        setError('');
      })
      .catch((cause) => {
        if (active) setError((cause as Error).message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [reload]);
  useEffect(() => {
    onDirtyChange(dirty || saving);
  }, [dirty, saving, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useSettingsSaveHandler(onSaveHandlerChange, save);
  function update<K extends 'maxCalls' | 'storyUi' | 'storyUiStyle'>(key: K, next: Defaults[K]) {
    setValue((current) => current && { ...current, [key]: next });
    setNotice('');
  }
  async function save() {
    if (!value || saving || loading) return false;
    if (!dirty) return true;
    if (!form.current?.reportValidity()) return false;
    if (
      !Number.isInteger(value.maxCalls) ||
      value.maxCalls < 1 ||
      value.maxCalls > MAX_MAIN_MODEL_CALLS
    ) {
      setError(uiMessage('settings.m78'));
      return false;
    }
    setSaving(true);
    setError('');
    try {
      const next = await api<Defaults>(
        '/chat-generation-defaults',
        {
          expectedRevision: value.revision,
          maxCalls: value.maxCalls,
          storyUi: value.storyUi,
          storyUiStyle: value.storyUiStyle,
        },
        'PUT'
      );
      setValue(next);
      setSaved(next);
      setNotice(uiMessage('settings.newChatDefaultsSaved'));
      return true;
    } catch (cause) {
      setError((cause as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  }
  function reloadDefaults() {
    setLoading(true);
    setReload((current) => current + 1);
    setConfirmReload(false);
  }
  return (
    <section className="settings-group" aria-label={t('settings.newChatDefaults')}>
      <h4>{t('settings.newChatDefaults')}</h4>
      <p>{t('settings.newChatDefaultsScope')}</p>
      <LoadingState
        presentation="placeholder"
        loading={loading}
        error={!value ? error : ''}
        label={t('settings.newChatDefaultsLoading')}
        errorLabel={t('settings.newChatDefaultsLoadFailed')}
        onRetry={reloadDefaults}
      />
      {value && (
        <form
          ref={form}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={saving || loading}>
            <div className="settings-group-body">
              <label className="settings-row">
                <span className="settings-row-copy">
                  <strong>{t('settings.m92')}</strong>
                  <small>{t('settings.m93')}</small>
                </span>
                <input
                  aria-label={t('settings.m92')}
                  type="number"
                  min={1}
                  max={MAX_MAIN_MODEL_CALLS}
                  step={1}
                  required
                  value={Number.isFinite(value.maxCalls) ? value.maxCalls : ''}
                  onChange={(event) => update('maxCalls', event.target.valueAsNumber)}
                />
              </label>
              <label className="settings-row settings-row-toggle">
                <span className="settings-row-copy">
                  <strong>{t('storyUi.enable')}</strong>
                </span>
                <span className="settings-row-control">
                  <Switch
                    aria-label={t('storyUi.enable')}
                    checked={value.storyUi}
                    onChange={(event) => update('storyUi', event.target.checked)}
                  />
                </span>
              </label>
              <label className="settings-row">
                <span className="settings-row-copy">
                  <strong>{t('storyUi.style')}</strong>
                </span>
                <StoryUiStyleSelect
                  aria-label={t('storyUi.style')}
                  value={value.storyUiStyle}
                  onChange={(style) => update('storyUiStyle', style)}
                />
              </label>
            </div>
            <div className="form-actions settings-save-actions">
              <SaveButton
                label={t('settings.newChatDefaultsSave')}
                disabled={!dirty || saving}
                aria-busy={saving}
              />
            </div>
          </fieldset>
          {error && (
            <NoticeBanner tone="error">
              {translateMessage(error)}{' '}
              <button
                type="button"
                className="link-button"
                disabled={saving || loading}
                onClick={() => {
                  if (dirty) setConfirmReload(true);
                  else reloadDefaults();
                }}
              >
                {t('settings.m103')}
              </button>
            </NoticeBanner>
          )}
          <TransientNotice message={notice} />
        </form>
      )}
      <Dialog
        open={confirmReload}
        title={t('settings.m96')}
        variant="confirmation"
        role="alertdialog"
        onClose={() => setConfirmReload(false)}
      >
        <p>{t('settings.m97')}</p>
        <DraftDiscardActions
          open={confirmReload}
          onContinue={() => setConfirmReload(false)}
          onDiscard={reloadDefaults}
          discardLabel={t('settings.m98')}
        />
      </Dialog>
    </section>
  );
}
