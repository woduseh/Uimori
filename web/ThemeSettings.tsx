import { t, useI18n, translateMessage, message as uiMessage } from './i18n.js';
import { TransientNotice } from './TransientNotice.js';
import { baselineThemeColors, colorInputValue } from './theme-color-input.js';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { PaletteEditor, usePaletteLibrary } from './PaletteSettings.js';
import { paletteFile } from '../core/palette-files.js';
import { FontSettings } from './FontSettings.js';
import { ThemeBackgroundSettings } from './ThemeBackgroundSettings.js';
import { ActionMenu } from './ActionMenu.js';
import { IconButton } from './IconButton.js';
import { SaveButton } from './SaveButton.js';
import {
  AddIcon,
  UploadIcon,
  DownloadIcon,
  CopyIcon,
  EditIcon,
  DeleteIcon,
  DisplayIcon,
  ResetIcon,
  StopIcon,
  CloseIcon,
} from './ui-icons.js';
import {
  THEME_COLOR_KEYS,
  DEFAULT_THEME_ID,
  copyTitle,
  emptyTheme,
  getBuiltinTheme,
  parseThemeFile,
  resolvePaletteId,
  resolveTheme,
  themeDefinition,
  validateTheme,
  type Theme,
  type ThemeDefinition,
} from '../core/themes.js';
import { THEME_PALETTE_ID } from '../core/theme-palettes.js';
import { appearanceEndpoints, resourceEditorEndpoints } from '#contracts';
import { ApiError, callEndpoint, saveDownload } from './api.js';
import { errorDescriptor } from './api-errors.js';
import { appearanceTarget, useThemes } from './ThemeContext.js';
import { parseJsonInput } from './json-input.js';
import { themeTemplate, ThemeFrame } from './ThemeFrame.js';
import { RisuMessageSurface } from './RisuMessageSurface.js';
import { useSettingsSaveHandler, type SettingsSaveRegistration } from './useSettingsSaveHandler.js';
import { Dialog } from './Dialog.js';
import { DraftDiscardActions } from './DraftDiscardActions.js';
import { NoticeBanner } from './NoticeBanner.js';
import { SaveConflictDialog } from './SaveConflictDialog.js';
import './themes.css';
import './deletion.css';
import { readingSample, readingSampleCredit } from './reading-sample.js';
import { StoryUiThemePreview } from './StoryBoardPanel.js';
import { Switch } from './BooleanControls.js';
import { storyUiStyles, type StoryUiStyle } from '../core/story-ui-style.js';
import { ThemeAssetEditor } from './ThemeAssetEditor.js';
import { adoptThemeFile, exportThemeFile } from './theme-assets.js';
import { paletteText, themeText } from './builtin-labels.js';

type Draft = { id: string | null; revision?: number; model: ThemeDefinition };
const previewBesideMinWidth = 860;
const localizedDefinition = (theme: Theme): ThemeDefinition => ({
  ...themeDefinition(theme),
  ...themeText(theme),
});
function paletteTitle(palette?: Parameters<typeof paletteText>[0]) {
  return palette ? paletteText(palette).title : '';
}
const sample = () =>
  `<div class="risu-chat-text">${readingSample
    .split('\n\n')
    .map((paragraph) => `<p data-uimori-prose>${paragraph}</p>`)
    .join(
      ''
    )}<small>${readingSampleCredit}</small></div><details><summary>${t('visualpanels.sampleStatusPanel')}</summary><label>${t('visualpanels.sampleNote')} <input aria-label="${t('visualpanels.sampleNoteLabel')}" placeholder="${t('visualpanels.sampleNotePlaceholder')}" /></label></details>`;
export function ThemeSettings({
  onDirtyChange,
  onSaveHandlerChange,
  active = true,
  storyUiThemeTarget,
}: {
  onDirtyChange?: (value: boolean) => void;
  onSaveHandlerChange?: SettingsSaveRegistration;
  active?: boolean;
  storyUiThemeTarget?: { botId: string; title: string };
}) {
  useI18n();
  const id = useId();
  const [saveConflict, setSaveConflict] = useState(false);
  const state = useThemes();
  const storyUiBotId = storyUiThemeTarget?.botId ?? state.scope.botId;
  const [draft, setDraft] = useState<Draft | null>(null);
  const storyUiDraft = useRef<ThemeDefinition['storyUi']>(undefined);
  const [baseline, setBaseline] = useState('');
  const [mode, setMode] = useState<'light' | 'dark'>(() =>
    typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark'
      ? 'dark'
      : 'light'
  );
  const [scope, setScope] = useState<'global' | 'bot' | 'chat'>('global');
  const [operation, setOperation] = useState<'save' | 'other' | null>(null);
  const busy = operation !== null;
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [importNotice, setImportNotice] = useState('');
  const [deleting, setDeleting] = useState<Theme | null>(null);
  const deleteCancel = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLElement>(null);
  const [previewBeside, setPreviewBeside] = useState(false);
  useLayoutEffect(() => {
    const node = root.current!;
    const observer = new ResizeObserver(() => {
      if (node.clientWidth > 0) setPreviewBeside(node.clientWidth >= previewBesideMinWidth);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!deleting) return;
    const frame = requestAnimationFrame(() => deleteCancel.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [deleting]);
  const input = useRef<HTMLInputElement>(null);
  const management = useRef<HTMLDetailsElement>(null);
  const locked = useRef(false);
  const paletteInput = useRef<HTMLInputElement>(null);
  const paletteLibrary = usePaletteLibrary();
  const paletteDirty = paletteLibrary.dirty;
  const [backgroundDirty, setBackgroundDirty] = useState(false);
  const [fontDirty, setFontDirty] = useState(false);
  const fontSave = useRef<(() => Promise<boolean>) | null>(null);
  const registerFontSave = useCallback((handler: (() => Promise<boolean>) | null) => {
    fontSave.current = handler;
  }, []);
  const backgroundSave = useRef<(() => Promise<boolean>) | null>(null);
  const registerBackgroundSave = useCallback((handler: (() => Promise<boolean>) | null) => {
    backgroundSave.current = handler;
  }, []);
  const dirty = !!draft && JSON.stringify(draft.model) !== baseline;
  const [closingDraft, setClosingDraft] = useState(false);
  function closeDraft() {
    setClosingDraft(false);
    setDraft(null);
    setPreview(null);
    setError('');
  }
  const { setPreview } = state;
  useEffect(() => {
    onDirtyChange?.(dirty || backgroundDirty || paletteDirty || fontDirty);
  }, [dirty, backgroundDirty, paletteDirty, fontDirty, onDirtyChange]);
  useEffect(
    () => () => {
      setPreview(null);
      onDirtyChange?.(false);
    },
    [setPreview, onDirtyChange]
  );
  useEffect(() => {
    if (!active) setPreview(null);
  }, [active, setPreview]);
  useEffect(() => {
    if ((scope === 'bot' && !state.scope.botId) || (scope === 'chat' && !state.scope.chatId))
      setScope('global');
  }, [scope, state.scope.botId, state.scope.chatId]);
  const p = state.catalog.preferences;
  const target = appearanceTarget(scope, state.scope);
  const selectedId =
    scope === 'global'
      ? p.defaultThemeId
      : scope === 'bot'
        ? p.botThemes[state.scope.botId ?? '']
        : p.chatThemes[state.scope.chatId ?? ''];
  const selectedPaletteId =
    scope === 'global'
      ? (p.defaultPaletteId ?? THEME_PALETTE_ID)
      : scope === 'bot'
        ? p.botPalettes?.[state.scope.botId ?? '']
        : p.chatPalettes?.[state.scope.chatId ?? ''];
  const editingScope =
    scope === 'global' ? {} : scope === 'bot' ? { botId: state.scope.botId } : state.scope;
  const activePaletteId = resolvePaletteId(state.catalog, state.scope);
  const activePaletteTitle =
    paletteTitle(state.catalog.palettes.find((palette) => palette.id === activePaletteId)) ||
    t('visualpanels.originalLayoutColors');
  const resolvedLayout = resolveTheme(state.catalog, editingScope);
  const editedPaletteId = resolvePaletteId(state.catalog, editingScope);
  const editedPaletteTitle =
    paletteTitle(state.catalog.palettes.find((palette) => palette.id === editedPaletteId)) ||
    t('visualpanels.originalLayoutColors');
  const activeLayout =
    state.catalog.themes.find((theme) => theme.id === resolvedLayout.id) ??
    getBuiltinTheme(resolvedLayout.id);
  const layoutSource = selectedId
    ? null
    : scope === 'chat' && p.botThemes[state.scope.botId ?? '']
      ? t('visualpanels.currentBotDefault')
      : t('visualpanels.workspaceDefault');
  const paletteSource = selectedPaletteId
    ? null
    : scope === 'chat' && p.botPalettes?.[state.scope.botId ?? '']
      ? t('visualpanels.currentBotDefault')
      : t('visualpanels.workspaceDefault');
  const originalColors = activeLayout?.colors;
  const libraryPalettes = state.catalog.palettes;
  const palettes = [
    {
      id: THEME_PALETTE_ID,
      title: t('visualpanels.originalLayoutColors'),
      description: '',
      colors: originalColors ?? { light: {}, dark: {} },
    },
    ...libraryPalettes,
  ];
  const paletteActionsDisabled = paletteLibrary.busy || busy || backgroundDirty || dirty;
  async function action(work: () => Promise<void>, saveAttempt = false) {
    if (locked.current) return;
    locked.current = true;
    setOperation(saveAttempt ? 'save' : 'other');
    setError('');
    setNotice('');
    setImportNotice('');
    try {
      await work();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        await state.refresh();
        if (saveAttempt) setSaveConflict(true);
      }
      setError(errorDescriptor(cause));
    } finally {
      locked.current = false;
      setOperation(null);
    }
  }
  function edit(theme?: Theme, copy = false, storyOnly = false) {
    if (dirty) {
      setError(uiMessage('visualpanels.saveOrCancelYourCurrentEditsBefore'));
      return false;
    }
    if (management.current) management.current.open = true;
    const model = theme
      ? structuredClone(localizedDefinition(theme))
      : emptyTheme(t('visualpanels.newTheme'));
    if (storyOnly) model.storyUi = { baseStyle: 'default', css: '' };
    storyUiDraft.current = model.storyUi;
    const isCopy = copy || !!theme?.id.startsWith('builtin:');
    if (theme && isCopy) model.title = copyTitle(model.title, t('shared.copySuffix'));
    setDraft({
      id: theme && !isCopy ? theme.id : null,
      revision: theme && !isCopy ? theme.revision : undefined,
      model,
    });
    setBaseline(theme && !isCopy ? JSON.stringify(model) : '');
    setError('');
    setNotice('');
    setImportNotice('');
    setPreview(null);
    return true;
  }
  function patch(next: Partial<ThemeDefinition>) {
    setDraft((d) => (d ? { ...d, model: { ...d.model, ...next } } : d));
  }
  async function save(): Promise<boolean> {
    if (fontDirty && !(await fontSave.current?.())) return false;
    if (paletteDirty && !(await paletteLibrary.save())) return false;
    if (backgroundDirty && !(await backgroundSave.current?.())) return false;
    if (!draft || locked.current) return !draft;
    let saved = false;
    await action(async () => {
      const model = validateTheme(draft.model);
      themeTemplate(model.templateHtml);
      const accepted = await callEndpoint(resourceEditorEndpoints.saveResource, {
        kind: 'theme',
        id: draft.id,
        expectedRevision: draft.revision,
        model,
      });
      const result = { saved: accepted.saved as Theme };
      setDraft({
        id: result.saved.id,
        revision: result.saved.revision,
        model: themeDefinition(result.saved),
      });
      setBaseline(JSON.stringify(themeDefinition(result.saved)));
      setPreview(null);
      await state.refresh();
      setNotice(uiMessage('visualpanels.themeSavedUseApplyToActivateIt'));
      saved = true;
    }, true);
    return saved;
  }
  useSettingsSaveHandler(onSaveHandlerChange, save);
  function choose(themeId: string | null) {
    void action(async () => {
      await callEndpoint(appearanceEndpoints.selectTheme, {
        dimension: 'theme',
        ...target,
        themeId,
        expectedRevision: p.revision,
      });
      setPreview(null);
      state.setDisabled(false);
      await state.refresh();
      setNotice(
        target.scope === 'global' &&
          ((state.scope.chatId && p.chatThemes[state.scope.chatId]) ||
            (state.scope.botId && p.botThemes[state.scope.botId]))
          ? uiMessage('visualpanels.defaultLayoutChangedThisChatUsesIts')
          : uiMessage('visualpanels.layoutSelectionSaved')
      );
    });
  }
  function choosePalette(paletteId: string | null) {
    void action(async () => {
      await callEndpoint(appearanceEndpoints.selectTheme, {
        dimension: 'palette',
        ...target,
        paletteId,
        expectedRevision: p.revision,
      });
      setPreview(null);
      state.setDisabled(false);
      await state.refresh();
      setNotice(
        target.scope === 'global' &&
          ((state.scope.chatId && p.chatPalettes?.[state.scope.chatId]) ||
            (state.scope.botId && p.botPalettes?.[state.scope.botId]))
          ? uiMessage('visualpanels.defaultPaletteChangedThisChatUsesIts')
          : uiMessage('visualpanels.paletteSelectionSaved')
      );
    });
  }
  function chooseStoryUi(botId: string, themeId: string | null) {
    void action(async () => {
      await callEndpoint(appearanceEndpoints.selectTheme, {
        dimension: 'storyUi',
        scope: 'bot',
        targetId: botId,
        themeId,
        expectedRevision: p.revision,
      });
      await state.refresh();
      setNotice(uiMessage('storyUi.botDefaultSaved'));
    });
  }
  async function importFile(file: File) {
    if (dirty) {
      setError(uiMessage('visualpanels.saveOrCancelTheThemeYouAre'));
      return;
    }
    await action(async () => {
      if (file.size > 96 * 1024 * 1024) throw new Error(uiMessage('themeAssets.importTooLarge'));
      const parsed = parseThemeFile(
        parseJsonInput(await file.text(), 'errors.THEME_FILE_UNSUPPORTED')
      );
      const model = await adoptThemeFile(parsed.theme, parsed.files);
      themeTemplate(model.templateHtml);
      storyUiDraft.current = model.storyUi;
      setDraft({ id: null, model });
      setBaseline('');
      setImportNotice(uiMessage('visualpanels.importedAsANewThemeReviewAnd'));
    });
  }
  const themeSample = (
    <ThemeFrame>
      <div slot="request">{t('visualpanels.startAStoryInAQuietLibrary')}</div>
      <div slot="heading" className="scene-header">
        <strong>{t('visualpanels.firstScene')}</strong>
        <span>{t('visualpanels.originalTranslation')}</span>
      </div>
      <div slot="body">
        <RisuMessageSurface html={sample()} onAction={async () => {}} disabled />
      </div>
      <div slot="actions" className="source-actions">
        <button type="button">{t('visualpanels.bodyActionExample')}</button>
      </div>
    </ThemeFrame>
  );
  return (
    <section
      ref={root}
      className={`theme-settings${previewBeside ? ' theme-settings-beside' : ''}`}
      aria-label={t('visualpanels.themesAndColors')}
    >
      <SaveConflictDialog
        open={saveConflict}
        title={t('visualpanels.reviewSavedTheme')}
        onClose={() => setSaveConflict(false)}
        readSaved={async () => {
          const value = (await callEndpoint(appearanceEndpoints.readThemes)).themes.find(
            (theme) => theme.id === draft?.id
          );
          if (!value)
            throw new Error(uiMessage('visualpanels.savedVersionUnavailableYourCurrentInputIs'));
          return () => [
            { label: t('visualpanels.name'), value: value.title },
            { label: t('visualpanels.description'), value: value.description },
          ];
        }}
      />
      <div className="theme-settings-controls">
        {state.disabled && (
          <p role="status" className="theme-recovery">
            {t('visualpanels.customThemesAreTemporarilyDisabledInThis')}{' '}
            <button onClick={() => state.setDisabled(false)}>
              {t('visualpanels.enableThemesAgain')}
            </button>
          </p>
        )}
        {state.error && (
          <NoticeBanner
            tone="error"
            actions={
              <button type="button" className="secondary" onClick={() => void state.refresh()}>
                {t('visualpanels.reload')}
              </button>
            }
          >
            {translateMessage(state.error)}
          </NoticeBanner>
        )}
        {error && <NoticeBanner tone="error">{translateMessage(error)}</NoticeBanner>}
        <TransientNotice content={notice} />
        <div className="theme-toolbar theme-control-bar">
          <label>
            {t('visualpanels.scope')}{' '}
            <select
              aria-label={t('visualpanels.themeScope')}
              value={scope}
              disabled={busy || backgroundDirty || paletteDirty}
              onChange={(e) => setScope(e.target.value as typeof scope)}
            >
              <option value="global">{t('visualpanels.workspaceDefault')}</option>
              {state.scope.botId && (
                <option value="bot">{t('visualpanels.currentBotDefault')}</option>
              )}
              {state.scope.chatId && <option value="chat">{t('visualpanels.thisChatOnly')}</option>}
            </select>
          </label>
          <label>
            {t('visualpanels.previewColors')}{' '}
            <select
              aria-label={t('visualpanels.themeColorPreview')}
              value={mode}
              onChange={(e) => setMode(e.target.value as typeof mode)}
            >
              <option value="light">{t('visualpanels.lightColors')}</option>
              <option value="dark">{t('visualpanels.darkColors')}</option>
            </select>
          </label>
          <span className="theme-current">
            {t('visualpanels.currentDisplay', {
              v0: themeText(state.active).title,
              v1: state.preview ? t('visualpanels.previewColors') : activePaletteTitle,
            })}
          </span>
        </div>
        <section className="theme-dimension" aria-labelledby="theme-layout-heading">
          <div className="theme-dimension-heading">
            <div>
              <h3 id="theme-layout-heading">{t('visualpanels.layout')}</h3>
              {layoutSource && (
                <small>
                  {t('settings.inheritedThemeSelection', {
                    title: activeLayout ? themeText(activeLayout).title : '',
                    source: layoutSource,
                  })}
                </small>
              )}
            </div>
            {scope !== 'global' && (
              <button
                disabled={busy || backgroundDirty || paletteDirty || state.loading || !selectedId}
                onClick={() => choose(null)}
              >
                {t('visualpanels.inheritLayout')}
              </button>
            )}
          </div>
          <div className="theme-grid" aria-label={t('visualpanels.savedLayouts')}>
            {state.catalog.themes.map((theme) => (
              <article
                className={`theme-card ${selectedId === theme.id ? 'selected' : ''}`}
                key={theme.id}
              >
                <button
                  className="theme-card-apply"
                  aria-label={t('visualpanels.applyTheme', {
                    v0: themeText(theme).title,
                  })}
                  aria-pressed={selectedId === theme.id}
                  disabled={busy || backgroundDirty || paletteDirty || state.loading}
                  onClick={() => choose(theme.id)}
                >
                  <span
                    className="theme-swatch"
                    data-layout={theme.id}
                    aria-hidden="true"
                    style={{
                      background: theme.colors[mode].bg ?? baselineThemeColors[mode].bg,
                      color: theme.colors[mode].text ?? baselineThemeColors[mode].text,
                    }}
                  >
                    <span
                      className="theme-swatch-nav"
                      style={{
                        background: theme.colors[mode].nav ?? baselineThemeColors[mode].nav,
                      }}
                    />
                    <span className="theme-swatch-page">
                      <span>Aa</span>
                      <i />
                      <i />
                      <b
                        style={{
                          background: theme.colors[mode].accent ?? baselineThemeColors[mode].accent,
                        }}
                      />
                    </span>
                  </span>
                  <strong className="theme-choice-title">
                    <span>{themeText(theme).title}</span>
                    {selectedId === theme.id && <Check size={18} aria-hidden="true" />}
                  </strong>
                  {theme.description && theme.id !== DEFAULT_THEME_ID && (
                    <small>{themeText(theme).description}</small>
                  )}
                </button>
                <div className="theme-card-actions">
                  <button
                    aria-label={
                      theme.id.startsWith('builtin:')
                        ? t('visualpanels.duplicateAndCustomize')
                        : t('visualpanels.edit')
                    }
                    title={
                      theme.id.startsWith('builtin:')
                        ? t('visualpanels.duplicateAndCustomize')
                        : t('visualpanels.edit')
                    }
                    disabled={busy || backgroundDirty || paletteDirty}
                    onClick={() => edit(theme)}
                  >
                    {theme.id.startsWith('builtin:')
                      ? t('visualpanels.customize')
                      : t('visualpanels.edit')}
                  </button>
                  <IconButton
                    label={t('visualpanels.export', {
                      v0: themeText(theme).title,
                    })}
                    icon={DownloadIcon}
                    onClick={() =>
                      void action(async () =>
                        saveDownload(
                          `${themeText(theme).title}.uimori-theme.json`,
                          await exportThemeFile(localizedDefinition(theme))
                        )
                      )
                    }
                  />
                </div>
                {!theme.id.startsWith('builtin:') && (
                  <ActionMenu
                    label={t('visualpanels.manage', {
                      v0: themeText(theme).title,
                    })}
                    className="theme-card-menu"
                    viewport
                  >
                    <div className="action-menu-group">
                      <button
                        aria-label={t('visualpanels.duplicate', {
                          v0: themeText(theme).title,
                        })}
                        disabled={busy || backgroundDirty || paletteDirty}
                        onClick={() => edit(theme, true)}
                      >
                        <CopyIcon size={18} aria-hidden="true" />{' '}
                        {t('visualpanels.duplicateAndEdit')}{' '}
                      </button>
                    </div>
                    <div className="action-menu-group">
                      <button
                        className="danger"
                        aria-label={t('visualpanels.delete', {
                          v0: themeText(theme).title,
                        })}
                        disabled={busy || dirty}
                        onClick={(event) => {
                          event.currentTarget.closest('details')?.querySelector('summary')?.focus();
                          setDeleting(theme);
                        }}
                      >
                        <DeleteIcon size={18} aria-hidden="true" /> {t('visualpanels.delete2')}{' '}
                      </button>
                    </div>
                  </ActionMenu>
                )}
              </article>
            ))}
          </div>
        </section>
        <section className="theme-dimension" aria-labelledby="theme-palette-heading">
          <div className="theme-dimension-heading">
            <div>
              <h3 id="theme-palette-heading">{t('visualpanels.colorPalette')}</h3>
              {paletteSource && (
                <small>
                  {t('settings.inheritedThemeSelection', {
                    title: editedPaletteTitle,
                    source: paletteSource,
                  })}
                </small>
              )}
            </div>
            <div className="theme-dimension-actions">
              <button
                disabled={
                  busy ||
                  backgroundDirty ||
                  paletteDirty ||
                  state.loading ||
                  (scope === 'global' ? selectedPaletteId === THEME_PALETTE_ID : !selectedPaletteId)
                }
                onClick={() => choosePalette(null)}
              >
                {scope === 'global'
                  ? t('visualpanels.resetPaletteToDefault')
                  : t('visualpanels.inheritPalette')}
              </button>
              <IconButton
                label={t('palettes.create')}
                icon={AddIcon}
                disabled={paletteActionsDisabled}
                onClick={() => paletteLibrary.edit()}
              />
              <IconButton
                label={t('palettes.import')}
                icon={UploadIcon}
                disabled={paletteActionsDisabled || paletteDirty}
                onClick={() => paletteInput.current?.click()}
              />
              <input
                ref={paletteInput}
                aria-label={t('palettes.import')}
                hidden
                type="file"
                accept=".json,application/json"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = '';
                  if (file) paletteLibrary.importFile(file);
                }}
              />
            </div>
          </div>
          <div className="theme-palette-grid" aria-label={t('visualpanels.selectColorPalette')}>
            {palettes.map((palette) => {
              const colors = { ...baselineThemeColors[mode], ...palette.colors[mode] };
              const libraryPalette = libraryPalettes.find((entry) => entry.id === palette.id);
              return (
                <article className="theme-palette-item" key={palette.id}>
                  <button
                    className={`theme-palette-card ${selectedPaletteId === palette.id ? 'selected' : ''}`}
                    aria-label={t('visualpanels.applyPalette', {
                      v0: paletteTitle(palette),
                    })}
                    aria-describedby={
                      palette.description ? `${id}-palette-${palette.id}` : undefined
                    }
                    aria-pressed={selectedPaletteId === palette.id}
                    disabled={busy || backgroundDirty || paletteDirty || state.loading}
                    onClick={() => choosePalette(palette.id)}
                  >
                    <span className="theme-palette-swatches" aria-hidden="true">
                      {(['bg', 'panel', 'accent', 'text'] as const).map((key) => (
                        <span key={key} style={{ background: colors[key] }} />
                      ))}
                    </span>
                    <strong className="theme-choice-title">
                      <span>{paletteTitle(palette)}</span>
                      {selectedPaletteId === palette.id && <Check size={18} aria-hidden="true" />}
                    </strong>
                    {palette.description && (
                      <span id={`${id}-palette-${palette.id}`} className="sr-only">
                        {paletteText(palette).description}
                      </span>
                    )}
                  </button>
                  {libraryPalette && (
                    <ActionMenu
                      label={t('visualpanels.manage', { v0: paletteTitle(libraryPalette) })}
                      className="theme-palette-menu"
                      viewport
                    >
                      <div className="action-menu-group">
                        {'revision' in libraryPalette && (
                          <button
                            aria-label={t('palettes.actionEdit', { title: libraryPalette.title })}
                            disabled={paletteActionsDisabled}
                            onClick={() => paletteLibrary.edit(libraryPalette)}
                          >
                            <EditIcon size={18} aria-hidden="true" /> {t('palettes.edit')}
                          </button>
                        )}
                        <button
                          aria-label={t('palettes.actionClone', {
                            title: paletteTitle(libraryPalette),
                          })}
                          disabled={paletteActionsDisabled}
                          onClick={() => paletteLibrary.edit(libraryPalette, true)}
                        >
                          <CopyIcon size={18} aria-hidden="true" /> {t('palettes.clone')}
                        </button>
                      </div>
                      <div className="action-menu-group">
                        <button
                          aria-label={t('palettes.actionExport', {
                            title: paletteTitle(libraryPalette),
                          })}
                          disabled={paletteLibrary.busy}
                          onClick={() =>
                            saveDownload(
                              `${paletteTitle(libraryPalette)}.palette.json`,
                              paletteFile({ ...libraryPalette, ...paletteText(libraryPalette) })
                            )
                          }
                        >
                          <DownloadIcon size={18} aria-hidden="true" /> {t('palettes.export')}
                        </button>
                      </div>
                      {'revision' in libraryPalette && (
                        <div className="action-menu-group">
                          <button
                            className="danger"
                            aria-label={t('palettes.actionDelete', { title: libraryPalette.title })}
                            disabled={paletteActionsDisabled || paletteDirty}
                            onClick={(event) => {
                              event.currentTarget
                                .closest('details')
                                ?.querySelector('summary')
                                ?.focus();
                              paletteLibrary.setDeleting(libraryPalette);
                            }}
                          >
                            <DeleteIcon size={18} aria-hidden="true" /> {t('palettes.delete')}
                          </button>
                        </div>
                      )}
                    </ActionMenu>
                  )}
                </article>
              );
            })}
          </div>
          <PaletteEditor library={paletteLibrary} disabled={busy || backgroundDirty || dirty} />
        </section>
        {(scope === 'bot' || storyUiThemeTarget) && storyUiBotId && (
          <section className="theme-dimension" aria-labelledby="story-ui-default-heading">
            <div className="theme-dimension-heading">
              <div>
                <h3 id="story-ui-default-heading">{t('storyUi.botDefault')}</h3>
                {storyUiThemeTarget && <p>{storyUiThemeTarget.title}</p>}
              </div>
              <button
                type="button"
                disabled={busy || backgroundDirty || paletteDirty}
                onClick={() => {
                  if (edit(undefined, false, true))
                    requestAnimationFrame(() =>
                      management.current?.scrollIntoView({ block: 'start' })
                    );
                }}
              >
                <AddIcon size={16} aria-hidden="true" /> {t('storyUi.newTheme')}
              </button>
              <select
                aria-label={t('storyUi.botDefault')}
                value={p.botStoryUiThemes?.[storyUiBotId] ?? ''}
                disabled={busy || state.loading}
                onChange={(event) => chooseStoryUi(storyUiBotId, event.target.value || null)}
              >
                <option value="">{t('storyUi.modelStyle')}</option>
                {p.botStoryUiThemes?.[storyUiBotId] &&
                  !state.catalog.themes.some(
                    (theme) => theme.id === p.botStoryUiThemes?.[storyUiBotId] && theme.storyUi
                  ) && (
                    <option value={p.botStoryUiThemes[storyUiBotId]}>
                      {t('storyUi.unavailableTheme')}
                    </option>
                  )}
                {state.catalog.themes
                  .filter((theme) => theme.storyUi)
                  .map((theme) => (
                    <option key={theme.id} value={theme.id}>
                      {themeText(theme).title}
                    </option>
                  ))}
              </select>
            </div>
          </section>
        )}
        <FontSettings onDirtyChange={setFontDirty} onSaveHandlerChange={registerFontSave} />
        <ThemeBackgroundSettings
          key={target.scope === 'global' ? 'global' : `${target.scope}:${target.targetId}`}
          target={target}
          disabled={busy || paletteDirty}
          onDirtyChange={setBackgroundDirty}
          onSaveHandlerChange={registerBackgroundSave}
        />
        <details className="theme-advanced" ref={management}>
          <summary>{t('visualpanels.manageThemes')}</summary>
          <section className="theme-library-tools">
            <div className="theme-library-actions">
              <button
                className="primary"
                disabled={busy || backgroundDirty || paletteDirty}
                onClick={() => edit()}
              >
                <AddIcon size={16} aria-hidden="true" /> {t('visualpanels.newCustomTheme')}{' '}
              </button>
              <button
                className="secondary"
                disabled={busy || backgroundDirty || paletteDirty}
                onClick={() => input.current?.click()}
              >
                <UploadIcon size={16} aria-hidden="true" /> {t('visualpanels.importTheme')}{' '}
              </button>
              <input
                ref={input}
                type="file"
                accept=".json"
                hidden
                aria-label={t('visualpanels.themeFile')}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void importFile(f);
                }}
              />
            </div>
          </section>
          {draft && (
            <section className="theme-editor" aria-label={t('visualpanels.customThemeEditor')}>
              <div className="theme-editor-heading">
                <h3>{draft.id ? t('visualpanels.editTheme') : t('visualpanels.createTheme')}</h3>
                <span className="muted">
                  {dirty ? t('visualpanels.unsavedChanges') : t('visualpanels.saved')}
                </span>
              </div>
              <fieldset disabled={busy || backgroundDirty || paletteDirty}>
                <label>
                  {t('visualpanels.themeName')}{' '}
                  <input
                    aria-label={t('visualpanels.themeName')}
                    value={draft.model.title}
                    maxLength={100}
                    onChange={(e) => patch({ title: e.target.value })}
                  />
                </label>
                <label>
                  {t('visualpanels.description')}{' '}
                  <input
                    aria-label={t('visualpanels.themeDescription')}
                    value={draft.model.description}
                    onChange={(e) => patch({ description: e.target.value })}
                  />
                </label>
                <div className="theme-code">
                  <label className="theme-story-ui-toggle">
                    <span>{t('storyUi.includeTheme')}</span>
                    <Switch
                      checked={!!draft.model.storyUi}
                      onChange={(event) => {
                        if (event.target.checked)
                          patch({
                            storyUi: storyUiDraft.current ?? { baseStyle: 'default', css: '' },
                          });
                        else {
                          storyUiDraft.current = draft.model.storyUi;
                          patch({ storyUi: undefined });
                        }
                      }}
                    />
                  </label>
                  {draft.model.storyUi && (
                    <>
                      <label>
                        {t('storyUi.baseStyle')}
                        <select
                          aria-label={t('storyUi.baseStyle')}
                          value={draft.model.storyUi.baseStyle}
                          onChange={(event) =>
                            patch({
                              storyUi: {
                                ...draft.model.storyUi!,
                                baseStyle: event.target.value as StoryUiStyle,
                              },
                            })
                          }
                        >
                          {storyUiStyles.map((style) => (
                            <option key={style} value={style}>
                              {t(`storyUi.style.${style}`)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        {t('storyUi.customCss')}
                        <textarea
                          aria-label={t('storyUi.customCss')}
                          rows={7}
                          placeholder={
                            '& { --story-paper: #f8f2e4; }\n.story-ui-tabs button { border-radius: 6px; }'
                          }
                          spellCheck={false}
                          value={draft.model.storyUi.css}
                          onChange={(event) =>
                            patch({ storyUi: { ...draft.model.storyUi!, css: event.target.value } })
                          }
                        />
                      </label>
                      <label>
                        {t('storyUi.boardCss')}
                        <textarea
                          aria-label={t('storyUi.boardCss')}
                          rows={5}
                          placeholder={
                            '& { --board-paper: linear-gradient(#2a2d35, #202228); --board-ink: #ececec; }'
                          }
                          spellCheck={false}
                          value={draft.model.storyUi.boardCss ?? ''}
                          onChange={(event) =>
                            patch({
                              storyUi: { ...draft.model.storyUi!, boardCss: event.target.value },
                            })
                          }
                        />
                      </label>
                      <div className="theme-story-ui-preview">
                        <strong>{t('storyUi.preview')}</strong>
                        <StoryUiThemePreview storyUi={draft.model.storyUi} />
                      </div>
                    </>
                  )}
                </div>
                <label className="theme-color-mode">
                  {t('settings.editColors')}
                  <select
                    aria-label={t('settings.editColors')}
                    value={mode}
                    onChange={(event) => setMode(event.target.value as typeof mode)}
                  >
                    <option value="light">{t('visualpanels.lightColors')}</option>
                    <option value="dark">{t('visualpanels.darkColors')}</option>
                  </select>
                </label>
                <div className="theme-colors">
                  {THEME_COLOR_KEYS.map((key) => (
                    <label key={key}>
                      <span>{t(`palettes.color.${key}`)}</span>
                      <div>
                        <input
                          type="color"
                          aria-label={t('visualpanels.color', {
                            v0:
                              mode === 'light'
                                ? t('visualpanels.lightColors')
                                : t('visualpanels.darkColors'),
                            v1: t(`palettes.color.${key}`),
                          })}
                          value={colorInputValue(
                            draft.model.colors[mode][key] ?? baselineThemeColors[mode][key]
                          )}
                          onChange={(e) =>
                            patch({
                              colors: {
                                ...draft.model.colors,
                                [mode]: { ...draft.model.colors[mode], [key]: e.target.value },
                              },
                            })
                          }
                        />
                        <IconButton
                          icon={ResetIcon}
                          title={t('visualpanels.resetToDefaultColor')}
                          label={t('visualpanels.resetToDefaultColor2', {
                            v0:
                              mode === 'light'
                                ? t('visualpanels.lightColors')
                                : t('visualpanels.darkColors'),
                            v1: t(`palettes.color.${key}`),
                          })}
                          disabled={!draft.model.colors[mode][key]}
                          onClick={() => {
                            const colors = { ...draft.model.colors[mode] };
                            delete colors[key];
                            patch({ colors: { ...draft.model.colors, [mode]: colors } });
                          }}
                        />
                      </div>
                    </label>
                  ))}
                </div>
                <ThemeAssetEditor
                  assets={draft.model.assets ?? []}
                  onChange={(assets) => patch({ assets: assets.length ? assets : undefined })}
                  onError={setError}
                />
                <details className="theme-code">
                  <summary>{t('visualpanels.editCssAndHtmlDirectly')}</summary>
                  {(
                    [
                      ['appCss', t('visualpanels.appCss')],
                      ['messageCss', t('visualpanels.bodyCss')],
                      ['templateHtml', t('visualpanels.layoutHtml')],
                      ['templateCss', t('visualpanels.layoutCss')],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key}>
                      {label}
                      <textarea
                        aria-label={label}
                        rows={7}
                        spellCheck={false}
                        value={draft.model[key]}
                        onChange={(e) => patch({ [key]: e.target.value })}
                      />
                    </label>
                  ))}
                </details>
              </fieldset>
              <div className="theme-toolbar theme-editor-actions">
                <SaveButton
                  type="button"
                  label={t('visualpanels.saveTheme')}
                  aria-busy={operation === 'save'}
                  disabled={busy || !dirty}
                  onClick={() => void save()}
                />
                <button
                  disabled={busy || backgroundDirty || paletteDirty}
                  onClick={() => {
                    try {
                      const t = validateTheme(draft.model);
                      themeTemplate(t.templateHtml);
                      state.setDisabled(false);
                      setPreview(t);
                      setError('');
                    } catch (cause) {
                      setError(errorDescriptor(cause));
                    }
                  }}
                >
                  <DisplayIcon size={18} aria-hidden="true" /> {t('visualpanels.applyPreview')}{' '}
                </button>
                {state.preview && (
                  <IconButton
                    label={t('visualpanels.endPreview')}
                    icon={StopIcon}
                    onClick={() => setPreview(null)}
                  />
                )}
                <IconButton
                  label={t('visualpanels.cancelEditing')}
                  icon={CloseIcon}
                  disabled={busy || backgroundDirty || paletteDirty}
                  onClick={() => (dirty ? setClosingDraft(true) : closeDraft())}
                />
              </div>
            </section>
          )}
          <Dialog
            open={closingDraft}
            title={t('settings.m97')}
            variant="confirmation"
            onClose={() => setClosingDraft(false)}
          >
            <DraftDiscardActions
              open={closingDraft}
              onContinue={() => setClosingDraft(false)}
              onDiscard={closeDraft}
              discardLabel={t('visualpanels.discardChangesAndClose')}
            />
          </Dialog>
          {importNotice && <p role="status">{translateMessage(importNotice)}</p>}
          <p className="theme-help">
            {t('visualpanels.themeRecoveryHelp', {
              shortcut: 'Ctrl/Cmd + .',
              query: '?theme-safe=1',
            })}
          </p>
        </details>
        {state.preview && (
          <p role="status">{t('visualpanels.previewingAnUnsavedThemeMovingToAnother')}</p>
        )}
      </div>
      {previewBeside ? (
        <section className="theme-sample theme-preview" aria-labelledby={`${id}-preview`}>
          <h3 id={`${id}-preview`}>{t('visualpanels.previewSampleWithCurrentTheme')}</h3>
          {themeSample}
        </section>
      ) : (
        <details className="theme-sample">
          <summary>{t('visualpanels.previewSampleWithCurrentTheme')}</summary>
          {themeSample}
        </details>
      )}
      <Dialog
        open={!!deleting}
        title={t('visualpanels.deleteTheme')}
        variant="confirmation"
        role="alertdialog"
        className="delete-dialog"
        onClose={() => {
          if (!busy) setDeleting(null);
        }}
      >
        <p>{t('visualpanels.deleteTheThemeBotsAndChatsUsing', { v0: deleting?.title ?? '' })}</p>
        {error && <NoticeBanner tone="error">{translateMessage(error)}</NoticeBanner>}
        <div className="form-actions">
          <button
            type="button"
            ref={deleteCancel}
            className="secondary"
            disabled={busy}
            onClick={() => setDeleting(null)}
          >
            {t('visualpanels.cancel')}
          </button>
          <button
            type="button"
            className="delete-button"
            disabled={busy || backgroundDirty || paletteDirty}
            onClick={() => {
              if (!deleting) return;
              void action(async () => {
                await callEndpoint(appearanceEndpoints.deleteTheme, {
                  id: deleting.id,
                  expectedRevision: deleting.revision,
                });
                if (draft?.id === deleting.id) setDraft(null);
                setPreview(null);
                setDeleting(null);
                await state.refresh();
              });
            }}
          >
            {t('visualpanels.delete2')}
          </button>
        </div>
      </Dialog>
    </section>
  );
}
