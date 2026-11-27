import { useEffect, useId, useRef, useState } from 'react';
import { useSettingsSaveHandler, type SettingsSaveRegistration } from './useSettingsSaveHandler.js';
import { appearanceEndpoints } from '#contracts';
import { ApiError, callEndpoint } from './api.js';
import { useFonts, type FontAsset } from './FontContext.js';
import { useThemes } from './ThemeContext.js';
import { t, useI18n, message, translateMessage } from './i18n.js';
import { UiError, uiMessage } from './ui-message.js';
import { NoticeBanner } from './NoticeBanner.js';
import { TransientNotice } from './TransientNotice.js';
import { SaveButton } from './SaveButton.js';
import { Dialog } from './Dialog.js';
import { DeleteIcon } from './ui-icons.js';
import { IconButton } from './IconButton.js';
import './fonts.css';
import { MAX_FONT_BYTES } from '../core/fonts.js';
import { LoadingState } from './LoadingState.js';
import { readingSample, readingSampleCredit } from './reading-sample.js';
import './deletion.css';
export function FontSettings({
  onDirtyChange,
  onSaveHandlerChange,
}: {
  onDirtyChange?: (dirty: boolean) => void;
  onSaveHandlerChange?: SettingsSaveRegistration;
}) {
  useI18n();
  const id = useId();
  const state = useFonts();
  const { disabled } = useThemes();
  const [file, setFile] = useState<File | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const management = useRef<HTMLDetailsElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [previewTarget, setPreviewTarget] = useState<'app' | 'reader'>('reader');
  const [deleting, setDeleting] = useState<FontAsset | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const dirty = !!file || !!title;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  async function operation(action: () => Promise<void>, success: string) {
    if (locked.current) return false;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
      setNotice(success);
      return true;
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : message('fonts.failed'));
      void state.refresh();
      return false;
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function upload() {
    if (!dirty) return true;
    if (!file || !title.trim() || !form.current?.checkValidity()) {
      if (management.current) management.current.open = true;
      form.current?.reportValidity();
      if (!file) input.current?.focus();
      else if (!title.trim()) nameInput.current?.focus();
      return false;
    }
    if (file.size > MAX_FONT_BYTES) {
      if (management.current) management.current.open = true;
      setError(message('fonts.tooLarge'));
      return false;
    }
    return operation(async () => {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]!);
        reader.onerror = () =>
          reject(new UiError(uiMessage('transfer.m190'), { cause: reader.error }));
        reader.readAsDataURL(file);
      });
      await callEndpoint(appearanceEndpoints.uploadFont, { title: title.trim(), data });
      setFile(null);
      setTitle('');
      if (input.current) input.current.value = '';
      await state.refresh();
    }, message('fonts.registered'));
  }
  useSettingsSaveHandler(onSaveHandlerChange, upload);
  function select(
    appFontId: string | null,
    readerFontId: string | null,
    target: 'app' | 'reader' = previewTarget
  ) {
    if (!state.catalog) return;
    setPreviewTarget(target);
    const expectedRevision = state.catalog.preferences.revision;
    void operation(async () => {
      const preferences = await callEndpoint(appearanceEndpoints.selectFonts, {
        expectedRevision,
        appFontId,
        readerFontId,
      });
      state.accept({ ...state.catalog!, preferences });
    }, message('fonts.saved'));
  }
  const catalog = state.catalog;
  const hasFonts = !!catalog?.fonts.length;
  return (
    <section className="font-settings" aria-label={t('fonts.title')}>
      <h3 id={`${id}-heading`}>{t('fonts.title')}</h3>
      <TransientNotice content={notice} />
      <LoadingState loading={state.loading} presentation="inline" />
      {(state.error || error) && (
        <NoticeBanner
          tone="error"
          actions={
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void state.refresh()}
            >
              {t('shared.retry')}
            </button>
          }
        >
          {translateMessage(error || state.error)}
        </NoticeBanner>
      )}
      {state.runtimeError && (
        <NoticeBanner
          actions={
            <button type="button" className="secondary" onClick={() => void state.refresh()}>
              {t('shared.retry')}
            </button>
          }
        >
          {t('fonts.loadFailed')}
        </NoticeBanner>
      )}
      {disabled && <NoticeBanner>{t('fonts.disabled')}</NoticeBanner>}
      {hasFonts && (
        <>
          <div className="font-settings-choices">
            <label htmlFor={`${id}-app`}>
              {t('fonts.app')}
              <select
                id={`${id}-app`}
                disabled={busy || !catalog}
                value={catalog?.preferences.appFontId ?? ''}
                onChange={(event) =>
                  select(event.target.value || null, catalog!.preferences.readerFontId, 'app')
                }
              >
                <option value="">{t('fonts.default')}</option>
                {catalog?.fonts.map((font) => (
                  <option key={font.id} value={font.id}>
                    {font.title}
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor={`${id}-reader`}>
              {t('fonts.reader')}
              <select
                id={`${id}-reader`}
                disabled={busy || !catalog}
                value={catalog?.preferences.readerFontId ?? ''}
                onChange={(event) =>
                  select(catalog!.preferences.appFontId, event.target.value || null, 'reader')
                }
              >
                <option value="">{t('fonts.default')}</option>
                {catalog?.fonts.map((font) => (
                  <option key={font.id} value={font.id}>
                    {font.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="font-settings-preview">
            <span className="muted">
              {t('fonts.preview', {
                target: t(previewTarget === 'app' ? 'fonts.app' : 'fonts.reader'),
              })}
            </span>
            <p
              className="font-preview"
              style={{
                fontFamily:
                  previewTarget === 'app' ? 'var(--app-font-family)' : 'var(--reading-font-family)',
              }}
            >
              {readingSample}
            </p>
            <small className="muted">{readingSampleCredit}</small>
          </div>
          <div className="form-actions">
            <button
              type="button"
              className="secondary"
              disabled={
                busy ||
                !catalog ||
                (!catalog.preferences.appFontId && !catalog.preferences.readerFontId)
              }
              onClick={() => select(null, null)}
            >
              {t('fonts.restore')}
            </button>
          </div>
        </>
      )}
      {catalog && (
        <details ref={management} className="font-management">
          <summary>{hasFonts ? t('fonts.manage') : t('fonts.add')}</summary>
          <form
            ref={form}
            className="font-upload"
            onSubmit={(event) => {
              event.preventDefault();
              void upload();
            }}
          >
            <label htmlFor={`${id}-file`}>
              {t('fonts.file')}
              <input
                id={`${id}-file`}
                ref={input}
                type="file"
                required
                accept=".ttf,.otf,.woff,.woff2"
                disabled={busy}
                onChange={(event) => {
                  const selected = event.target.files?.[0] ?? null;
                  setFile(selected);
                  if (selected) setTitle(selected.name.replace(/\.(ttf|otf|woff2?)$/i, ''));
                }}
              />
            </label>
            <label htmlFor={`${id}-name`}>
              {t('fonts.name')}
              <input
                id={`${id}-name`}
                ref={nameInput}
                required
                maxLength={200}
                value={title}
                disabled={busy}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <div className="form-actions">
              <SaveButton
                label={t('fonts.registerLabel')}
                text={t('fonts.register')}
                disabled={busy || !file || !title.trim()}
                aria-busy={busy}
              />
            </div>
          </form>
          {hasFonts && (
            <ul className="font-list">
              {catalog.fonts.map((font) => (
                <li key={font.id}>
                  <div>
                    <strong>{font.title}</strong>
                    <small>
                      {font.format.toUpperCase()}, {Math.ceil(font.byteLength / 1024)} KB
                    </small>
                  </div>
                  <IconButton
                    label={t('fonts.delete', { title: font.title })}
                    icon={DeleteIcon}
                    disabled={busy}
                    onClick={() => setDeleting(font)}
                  />
                </li>
              ))}
            </ul>
          )}
        </details>
      )}
      <Dialog
        open={!!deleting}
        title={t('fonts.deleteTitle')}
        variant="confirmation"
        role="alertdialog"
        className="delete-dialog"
        onClose={() => {
          if (!busy) setDeleting(null);
        }}
      >
        <p>{t('fonts.deleteConfirm', { title: deleting?.title ?? '' })}</p>
        <div className="form-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => setDeleting(null)}
          >
            {t('shared.cancel')}
          </button>
          <button
            type="button"
            className="delete-button"
            disabled={busy}
            onClick={() => {
              if (!deleting) return;
              void operation(async () => {
                const next = await callEndpoint(appearanceEndpoints.deleteFont, {
                  id: deleting.id,
                });
                state.accept(next);
                setDeleting(null);
              }, message('fonts.deleted'));
            }}
          >
            {t('fonts.deleteTitle')}
          </button>
        </div>
      </Dialog>
    </section>
  );
}
