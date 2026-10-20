import { t, useI18n, translateMessage, formatNumber, message as uiMessage } from './i18n.js';
import { TransientNotice } from './TransientNotice.js';
import { NoticeBanner } from './NoticeBanner.js';
import { useEffect, useRef, useState } from 'react';
import { PACKAGE_IMAGE_MIMES } from '../core/package-images.js';
import {
  defaultThemeBackground,
  resolveThemeBackground,
  type ThemeBackground,
} from '../core/theme-background.js';
import { api, ApiError } from './api.js';
import { useThemes } from './ThemeContext.js';
import { uploadPackageImage } from './package-image-upload.js';
import { backgroundStyle } from './ThemeBackground.js';
import { useSettingsSaveHandler, type SettingsSaveRegistration } from './useSettingsSaveHandler.js';
import { IconButton } from './IconButton.js';
import { SaveButton } from './SaveButton.js';
import { CloseIcon, ResetIcon } from './ui-icons.js';

export function ThemeBackgroundSettings({
  scope,
  disabled = false,
  targetId,
  onDirtyChange,
  onSaveHandlerChange,
}: {
  scope: 'global' | 'bot' | 'chat';
  disabled?: boolean;
  targetId?: string;
  onDirtyChange: (dirty: boolean) => void;
  onSaveHandlerChange: SettingsSaveRegistration;
}) {
  useI18n();
  const state = useThemes();
  const p = state.catalog.preferences;
  const selected =
    scope === 'global'
      ? p.defaultBackground
      : scope === 'bot'
        ? p.botBackgrounds?.[targetId ?? '']
        : p.chatBackgrounds?.[targetId ?? ''];
  const inherited = resolveThemeBackground(
    p,
    scope === 'global' ? {} : scope === 'bot' ? { botId: targetId } : state.scope
  );
  const [draft, setDraft] = useState<ThemeBackground>(selected ?? inherited);
  const [operation, setOperation] = useState<'save' | 'upload' | null>(null);
  const busy = operation !== null;
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const upload = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const locked = useRef(false);
  const [baseline, setBaseline] = useState(JSON.stringify(selected ?? inherited));
  const dirty = JSON.stringify(draft) !== baseline;
  useEffect(() => {
    if (!dirty && !busy) {
      setDraft(selected ?? inherited);
      setBaseline(JSON.stringify(selected ?? inherited));
    }
  }, [selected, inherited, dirty, busy]);
  useEffect(() => {
    onDirtyChange(dirty || busy);
  }, [dirty, busy, onDirtyChange]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      upload.current?.abort();
      onDirtyChange(false);
    };
  }, [onDirtyChange]);
  async function saveValue(background: ThemeBackground | null): Promise<boolean> {
    if (disabled || locked.current) return false;
    locked.current = true;
    setOperation('save');
    setError('');
    setNotice('');
    try {
      await api('/themes/background', {
        scope,
        targetId,
        background,
        expectedRevision: p.revision,
      });
      if (alive.current) {
        setBaseline(JSON.stringify(background ?? inherited));
        setDraft(background ?? inherited);
      }
      await state.refresh(true);
      if (alive.current) setNotice(uiMessage('visuals.m001'));
      return true;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) await state.refresh();
      if (alive.current) setError((cause as Error).message);
      return false;
    } finally {
      locked.current = false;
      if (alive.current) setOperation(null);
    }
  }
  useSettingsSaveHandler(onSaveHandlerChange, () =>
    dirty ? saveValue(draft) : Promise.resolve(!busy)
  );
  async function chooseFile(file: File) {
    if (disabled || locked.current) return;
    locked.current = true;
    const controller = new AbortController();
    upload.current = controller;
    setOperation('upload');
    setError('');
    setNotice('');
    try {
      const image = await uploadPackageImage(file, controller.signal, 'profile');
      if (alive.current && !controller.signal.aborted)
        setDraft((value) => ({ ...value, imageHash: image.blobHash }));
    } catch (cause) {
      if (alive.current && !controller.signal.aborted) setError((cause as Error).message);
    } finally {
      if (upload.current === controller) upload.current = null;
      locked.current = false;
      if (alive.current) setOperation(null);
    }
  }
  return (
    <section className="theme-dimension" aria-labelledby="theme-background-heading">
      <div className="theme-dimension-heading">
        <div>
          <h3 id="theme-background-heading">{t('visuals.m002')}</h3>
          <p>{t('visuals.m003')}</p>
        </div>
        {scope !== 'global' && (
          <button
            disabled={disabled || busy || state.loading || !selected}
            onClick={() => void saveValue(null)}
          >
            {t('visuals.m004')}
          </button>
        )}
      </div>
      {scope !== 'global' && !selected && <p className="theme-inherited">{t('visuals.m005')}</p>}
      {draft.imageHash && (
        <div
          className="theme-background-preview"
          aria-label={t('visuals.m006')}
          style={backgroundStyle(draft)}
        />
      )}
      <fieldset className="theme-background-controls" disabled={disabled || busy || state.loading}>
        <label className="settings-row theme-background-file">
          <span className="settings-row-copy">
            <strong>{t('visuals.m007')}</strong>
            {!draft.imageHash && <small>{t('visuals.m008')}</small>}
          </span>
          <input
            type="file"
            aria-label={t('visuals.m007')}
            accept={PACKAGE_IMAGE_MIMES.join(',')}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void chooseFile(file);
            }}
          />
        </label>
        <div className="theme-background-sliders" role="group" aria-label={t('visuals.m009')}>
          <label>
            {t('visuals.blur', { value: formatNumber(draft.blur) })}
            <input
              aria-label={t('visuals.m011')}
              type="range"
              min="0"
              max="30"
              value={draft.blur}
              onChange={(event) => setDraft({ ...draft, blur: Number(event.target.value) })}
            />
          </label>
          <label>
            {t('visuals.lightOverlay', { value: formatNumber(draft.lightOverlay) })}
            <input
              aria-label={t('visuals.m013')}
              type="range"
              min="0"
              max="100"
              value={draft.lightOverlay}
              onChange={(event) => setDraft({ ...draft, lightOverlay: Number(event.target.value) })}
            />
          </label>
          <label>
            {t('visuals.darkOverlay', { value: formatNumber(draft.darkOverlay) })}
            <input
              aria-label={t('visuals.m015')}
              type="range"
              min="0"
              max="100"
              value={draft.darkOverlay}
              onChange={(event) => setDraft({ ...draft, darkOverlay: Number(event.target.value) })}
            />
          </label>
        </div>
      </fieldset>
      <div className="theme-toolbar theme-background-actions">
        <SaveButton
          type="button"
          label={t('visuals.m016')}
          text=""
          aria-busy={operation === 'save'}
          disabled={disabled || busy || state.loading || !dirty}
          onClick={() => void saveValue(draft)}
        />
        <button
          className="theme-background-reset"
          aria-label={t('visuals.m017')}
          title={t('visuals.m018')}
          disabled={disabled || busy || state.loading || !draft.imageHash}
          onClick={() => setDraft({ ...defaultThemeBackground })}
        >
          <ResetIcon size={18} aria-hidden="true" />
          {t('visuals.m019')}
        </button>
        {dirty && (
          <IconButton
            label={t('visuals.m020')}
            icon={CloseIcon}
            disabled={disabled || busy}
            onClick={() => {
              setDraft(selected ?? inherited);
              setBaseline(JSON.stringify(selected ?? inherited));
            }}
          />
        )}
      </div>
      {error && <NoticeBanner tone="error">{translateMessage(error)}</NoticeBanner>}
      <TransientNotice message={notice} />
    </section>
  );
}
