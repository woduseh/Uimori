import { validatePalette, parsePaletteFile, paletteFile } from '../core/palette-files.js';
import { useEffect, useRef, useState } from 'react';
import { t, useI18n, message, translateMessage } from './i18n.js';
import { THEME_COLOR_KEYS, resolveTheme } from '../core/themes.js';
import {
  BUILTIN_PALETTES,
  type Palette,
  type PaletteDefinition,
  type ThemePalette,
} from '../core/theme-palettes.js';
import { useThemes } from './ThemeContext.js';
import { api, ApiError, saveDownload } from './api.js';
import { NoticeBanner } from './NoticeBanner.js';
import { TransientNotice } from './TransientNotice.js';
import { SaveButton } from './SaveButton.js';
import { Dialog } from './Dialog.js';
import { useSettingsSaveHandler, type SettingsSaveRegistration } from './useSettingsSaveHandler.js';
import './palettes.css';

type Draft = { id: string | null; revision?: number; model: PaletteDefinition };
export function PaletteSettings({
  onDirtyChange,
  onSaveHandlerChange,
  active = true,
  disabled = false,
}: {
  onDirtyChange?: (dirty: boolean) => void;
  onSaveHandlerChange?: SettingsSaveRegistration;
  active?: boolean;
  disabled?: boolean;
}) {
  useI18n();
  const state = useThemes();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState('');
  const [mode, setMode] = useState<'light' | 'dark'>('light');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [deleting, setDeleting] = useState<Palette | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const lock = useRef(false);
  const dirty = !!draft && JSON.stringify(draft.model) !== baseline;
  const palettes = state.catalog.palettes ?? BUILTIN_PALETTES;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(
    () => () => {
      state.setPreview(null);
      onDirtyChange?.(false);
    },
    [state.setPreview, onDirtyChange]
  );
  useEffect(() => {
    if (!active) state.setPreview(null);
  }, [active, state.setPreview]);
  async function run(work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (cause) {
      setError((cause as Error).message);
      if (cause instanceof ApiError && cause.status === 409) {
        setConflict(true);
        await state.refresh();
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function edit(palette?: ThemePalette | Palette, copy = false) {
    if (dirty) {
      setError(message('palettes.finishDraft'));
      return;
    }
    const custom = palette && 'revision' in palette && !copy;
    const model = structuredClone(
      palette
        ? {
            title:
              ('revision' in palette ? palette.title : translateMessage(palette.title)) +
              (copy ? t('palettes.copySuffix') : ''),
            description: palette.description,
            colors: palette.colors,
          }
        : { title: t('palettes.defaultName'), description: '', colors: BUILTIN_PALETTES[0].colors }
    );
    setDraft({
      id: custom ? palette.id : null,
      revision: custom ? palette.revision : undefined,
      model,
    });
    setBaseline(custom ? JSON.stringify(model) : '');
    setError('');
    setConflict(false);
    state.setPreview(null);
  }
  async function save() {
    if (!dirty) return true;
    let saved = false;
    await run(async () => {
      if (!draft) return;
      const model = validatePalette(draft.model);
      const result = await api<Palette>(
        draft.id ? `/palettes/${encodeURIComponent(draft.id)}` : '/palettes',
        { model, expectedRevision: draft.revision },
        draft.id ? 'PUT' : 'POST'
      );
      const clean = { title: result.title, description: result.description, colors: result.colors };
      setDraft({ id: result.id, revision: result.revision, model: clean });
      setBaseline(JSON.stringify(clean));
      state.setPreview(null);
      saved = true;
      setNotice(message('palettes.saved'));
      await state.refresh(true);
    });
    return saved;
  }
  useSettingsSaveHandler(onSaveHandlerChange, save);
  function setColor(key: (typeof THEME_COLOR_KEYS)[number], value: string) {
    setDraft((current) => {
      if (!current) return current;
      const colors = { ...current.model.colors[mode] };
      if (value) colors[key] = value;
      else delete colors[key];
      return {
        ...current,
        model: { ...current.model, colors: { ...current.model.colors, [mode]: colors } },
      };
    });
  }
  function preview() {
    try {
      if (draft)
        state.setPreview({
          ...resolveTheme(state.catalog, state.scope),
          colors: validatePalette(draft.model).colors,
        });
    } catch (cause) {
      setError((cause as Error).message);
    }
  }
  return (
    <section className="palette-editor-section" aria-label={t('palettes.manage')}>
      <div className="theme-library-actions">
        <button disabled={busy || disabled} onClick={() => edit()}>
          {t('palettes.create')}
        </button>
        <button disabled={busy || disabled || dirty} onClick={() => input.current?.click()}>
          {t('palettes.import')}
        </button>
      </div>
      <input
        ref={input}
        aria-label={t('palettes.import')}
        hidden
        type="file"
        accept=".json,application/json"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (!file) return;
          void run(async () => {
            if (file.size > 1024 * 1024) throw new Error(message('palettes.fileTooLarge'));
            const model = parsePaletteFile(JSON.parse(await file.text()));
            setDraft({ id: null, model });
            setBaseline('');
            state.setPreview(null);
          });
        }}
      />
      <details>
        <summary>{t('palettes.manage')}</summary>
        <div className="palette-management-list">
          {palettes.map((palette) => (
            <div className="palette-management-row" key={palette.id}>
              <span>{'revision' in palette ? palette.title : translateMessage(palette.title)}</span>
              <div className="theme-library-actions">
                {'revision' in palette && (
                  <button
                    disabled={busy || disabled}
                    aria-label={t('palettes.actionEdit', { title: palette.title })}
                    onClick={() => edit(palette)}
                  >
                    {t('palettes.edit')}
                  </button>
                )}
                <button
                  disabled={busy || disabled}
                  aria-label={t('palettes.actionClone', {
                    title: 'revision' in palette ? palette.title : translateMessage(palette.title),
                  })}
                  onClick={() => edit(palette, true)}
                >
                  {t('palettes.clone')}
                </button>
                <button
                  disabled={busy}
                  aria-label={t('palettes.actionExport', {
                    title: 'revision' in palette ? palette.title : translateMessage(palette.title),
                  })}
                  onClick={() =>
                    saveDownload(`${palette.title}.palette.json`, paletteFile(palette))
                  }
                >
                  {t('palettes.export')}
                </button>
                {'revision' in palette && (
                  <button
                    disabled={busy || disabled || dirty}
                    aria-label={t('palettes.actionDelete', { title: palette.title })}
                    onClick={() => setDeleting(palette)}
                  >
                    {t('palettes.delete')}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </details>
      {error && (
        <NoticeBanner
          tone="error"
          actions={
            conflict && draft ? (
              <button
                disabled={busy}
                onClick={() => {
                  setDraft({ ...draft, id: null, revision: undefined });
                  setBaseline('');
                  setConflict(false);
                  setError('');
                }}
              >
                {t('palettes.saveAsNew')}
              </button>
            ) : undefined
          }
        >
          {translateMessage(error)}
        </NoticeBanner>
      )}
      <TransientNotice message={notice} />
      {draft && (
        <div className="palette-editor">
          <label>
            {t('palettes.name')}
            <input
              value={draft.model.title}
              disabled={busy}
              onChange={(event) =>
                setDraft({ ...draft, model: { ...draft.model, title: event.target.value } })
              }
            />
          </label>
          <label>
            {t('palettes.description')}
            <textarea
              value={draft.model.description}
              disabled={busy}
              onChange={(event) =>
                setDraft({ ...draft, model: { ...draft.model, description: event.target.value } })
              }
            />
          </label>
          <div className="theme-library-actions">
            {(['light', 'dark'] as const).map((value) => (
              <button key={value} aria-pressed={mode === value} onClick={() => setMode(value)}>
                {t(value === 'light' ? 'palettes.light' : 'palettes.dark')}
              </button>
            ))}
          </div>
          <div className="palette-color-fields">
            {THEME_COLOR_KEYS.map((key) => (
              <label key={key}>
                <span>{t(`palettes.color.${key}`)}</span>
                <input
                  aria-label={`${t(`palettes.color.${key}`)} ${t(mode === 'light' ? 'palettes.light' : 'palettes.dark')}`}
                  value={draft.model.colors[mode][key] ?? ''}
                  placeholder="#RRGGBB"
                  disabled={busy}
                  onChange={(event) => setColor(key, event.target.value)}
                />
                <span
                  className="palette-color-dot"
                  style={{ background: draft.model.colors[mode][key] }}
                  aria-hidden="true"
                />
              </label>
            ))}
          </div>
          <div className="theme-library-actions">
            <button disabled={busy || disabled} onClick={preview}>
              {t('palettes.preview')}
            </button>
            {state.preview && (
              <button onClick={() => state.setPreview(null)}>{t('palettes.stopPreview')}</button>
            )}
            <SaveButton
              label={t('palettes.save')}
              disabled={!dirty || disabled}
              aria-busy={busy}
              onClick={() => void save()}
            />
            <button
              disabled={busy}
              onClick={() =>
                dirty ? setDiscarding(true) : (setDraft(null), state.setPreview(null))
              }
            >
              {t('palettes.close')}
            </button>
          </div>
        </div>
      )}
      <Dialog
        open={discarding}
        title={t('palettes.discardTitle')}
        onClose={() => setDiscarding(false)}
        variant="confirmation"
      >
        <p>{t('palettes.discardHelp')}</p>
        <div className="theme-library-actions">
          <button onClick={() => setDiscarding(false)}>{t('palettes.keepEditing')}</button>
          <button
            onClick={() => {
              setDraft(null);
              state.setPreview(null);
              setDiscarding(false);
            }}
          >
            {t('palettes.discard')}
          </button>
        </div>
      </Dialog>
      <Dialog
        open={!!deleting}
        title={t('palettes.delete')}
        onClose={() => {
          if (!busy) setDeleting(null);
        }}
        variant="confirmation"
      >
        <p>{t('palettes.deleteHelp', { title: deleting?.title ?? '' })}</p>
        <div className="theme-library-actions">
          <button disabled={busy} onClick={() => setDeleting(null)}>
            {t('palettes.close')}
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                if (!deleting) return;
                await api(
                  `/palettes/${encodeURIComponent(deleting.id)}`,
                  { expectedRevision: deleting.revision },
                  'DELETE'
                );
                if (draft?.id === deleting.id) {
                  setDraft(null);
                  state.setPreview(null);
                }
                setDeleting(null);
                await state.refresh(true);
              })
            }
          >
            {t('palettes.delete')}
          </button>
        </div>
      </Dialog>
    </section>
  );
}
