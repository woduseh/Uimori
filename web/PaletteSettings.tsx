import { validatePalette, parsePaletteFile } from '../core/palette-files.js';
import { useRef, useState } from 'react';
import { t, useI18n, message, translateMessage } from './i18n.js';
import { THEME_COLOR_KEYS, resolveTheme } from '../core/themes.js';
import {
  BUILTIN_PALETTES,
  type Palette,
  type PaletteDefinition,
  type ThemePalette,
} from '../core/theme-palettes.js';
import { useThemes } from './ThemeContext.js';
import { paletteText } from './builtin-labels.js';
import { api, ApiError } from './api.js';
import { errorDescriptor } from './api-errors.js';
import { NoticeBanner } from './NoticeBanner.js';
import { TransientNotice } from './TransientNotice.js';
import { SaveButton } from './SaveButton.js';
import { Dialog } from './Dialog.js';
import { CheckIcon } from './ui-icons.js';
import './palettes.css';
import './deletion.css';

type Draft = { id: string | null; revision?: number; model: PaletteDefinition };
export type PaletteLibrary = ReturnType<typeof usePaletteLibrary>;

export function usePaletteLibrary() {
  const state = useThemes();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [deleting, setDeleting] = useState<Palette | null>(null);
  const lock = useRef(false);
  const dirty = !!draft && JSON.stringify(draft.model) !== baseline;
  async function run(work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (cause) {
      setError(errorDescriptor(cause));
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
            title: paletteText(palette).title + (copy ? t('shared.copySuffix') : ''),
            description: paletteText(palette).description,
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
  function importFile(file: File) {
    void run(async () => {
      if (file.size > 1024 * 1024) throw new Error(message('palettes.fileTooLarge'));
      const model = parsePaletteFile(JSON.parse(await file.text()));
      setDraft({ id: null, model });
      setBaseline('');
      state.setPreview(null);
    });
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
      await state.refresh();
    });
    return saved;
  }
  function deleteConfirmed() {
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
      await state.refresh();
    });
  }
  function saveAsNew() {
    if (!draft) return;
    setDraft({ ...draft, id: null, revision: undefined });
    setBaseline('');
    setConflict(false);
    setError('');
  }
  return {
    draft,
    setDraft,
    dirty,
    busy,
    error,
    setError,
    notice,
    conflict,
    deleting,
    setDeleting,
    edit,
    importFile,
    save,
    deleteConfirmed,
    saveAsNew,
  };
}

export function PaletteEditor({
  library,
  disabled = false,
}: {
  library: PaletteLibrary;
  disabled?: boolean;
}) {
  useI18n();
  const state = useThemes();
  const { draft, setDraft, dirty, busy, error, deleting, setDeleting } = library;
  const [mode, setMode] = useState<'light' | 'dark'>('light');
  const [discarding, setDiscarding] = useState(false);
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
      library.setError(errorDescriptor(cause));
    }
  }
  return (
    <>
      {error && (
        <NoticeBanner
          tone="error"
          actions={
            library.conflict && draft ? (
              <button disabled={busy} onClick={library.saveAsNew}>
                {t('palettes.saveAsNew')}
              </button>
            ) : undefined
          }
        >
          {translateMessage(error)}
        </NoticeBanner>
      )}
      <TransientNotice message={library.notice} />
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
          <div className="theme-library-actions palette-mode-select">
            {(['light', 'dark'] as const).map((value) => (
              <button key={value} aria-pressed={mode === value} onClick={() => setMode(value)}>
                <CheckIcon className="palette-mode-check" size={16} aria-hidden="true" />
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
              onClick={() => void library.save()}
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
        role="alertdialog"
        className="delete-dialog"
      >
        <p>{t('palettes.deleteHelp', { title: deleting?.title ?? '' })}</p>
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
            onClick={library.deleteConfirmed}
          >
            {t('palettes.delete')}
          </button>
        </div>
      </Dialog>
    </>
  );
}
