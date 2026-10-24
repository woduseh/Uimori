import { t, useI18n, translateMessage, message as uiMessage } from './i18n.js';
import { TransientNotice } from './TransientNotice.js';
import { baselineThemeColors, colorInputValue } from './theme-color-input.js';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { PaletteSettings } from './PaletteSettings.js';
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
  DeleteIcon,
  DisplayIcon,
  ResetIcon,
  StopIcon,
  CloseIcon,
} from './ui-icons.js';
import {
  THEME_COLOR_KEYS,
  DEFAULT_THEME_ID,
  emptyTheme,
  getBuiltinTheme,
  parseThemeFile,
  resolvePaletteId,
  resolveTheme,
  themeFile,
  themeDefinition,
  validateTheme,
  type Theme,
  type ThemeColorKey,
  type ThemeDefinition,
  type ThemeCatalog,
} from '../core/themes.js';
import { BUILTIN_PALETTES, THEME_PALETTE_ID } from '../core/theme-palettes.js';
import { api, ApiError, saveDownload } from './api.js';
import { useThemes } from './ThemeContext.js';
import { themeTemplate, ThemeFrame } from './ThemeFrame.js';
import { RisuMessageSurface } from './RisuMessageSurface.js';
import { useSettingsSaveHandler, type SettingsSaveRegistration } from './useSettingsSaveHandler.js';
import { Dialog } from './Dialog.js';
import { NoticeBanner } from './NoticeBanner.js';
import { SaveConflictDialog } from './SaveConflictDialog.js';
import './themes.css';
import './deletion.css';

type Draft = { id: string | null; revision?: number; model: ThemeDefinition };
const labels: Partial<Record<ThemeColorKey, string>> = {
  bg: '바탕',
  nav: '사이드바',
  panel: '패널',
  surface: '표면',
  text: '본문',
  muted: '보조 글자',
  accent: '강조',
  'accent-ink': '강조 위 글자',
  line: '구분선',
  user: '요청 배경',
};
function paletteTitle(palette?: { title: string; revision?: number }) {
  return palette
    ? palette.revision === undefined
      ? translateMessage(palette.title)
      : palette.title
    : '';
}
const sample =
  '<div class="risu-chat-text"><p data-uimori-prose>책장을 넘기자 오래된 종이 냄새가 은은하게 퍼졌다.</p><p data-uimori-prose>“오늘은 어떤 이야기를 함께 읽을까요?”</p></div><details><summary>봇이 만든 상태창</summary><label>메모 <input aria-label="테마 예문 메모" placeholder="테마를 바꿔도 유지돼요" /></label></details>';
export function ThemeSettings({
  onDirtyChange,
  onSaveHandlerChange,
  active = true,
}: {
  onDirtyChange?: (value: boolean) => void;
  onSaveHandlerChange?: SettingsSaveRegistration;
  active?: boolean;
}) {
  const { locale } = useI18n();
  const id = useId();
  const [saveConflict, setSaveConflict] = useState(false);
  const state = useThemes();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState('');
  const [mode, setMode] = useState<'light' | 'dark'>('light');
  const [scope, setScope] = useState<'global' | 'bot' | 'chat'>('global');
  const [operation, setOperation] = useState<'save' | 'other' | null>(null);
  const busy = operation !== null;
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [importNotice, setImportNotice] = useState('');
  const [deleting, setDeleting] = useState<Theme | null>(null);
  const deleteCancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!deleting) return;
    const frame = requestAnimationFrame(() => deleteCancel.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [deleting]);
  const input = useRef<HTMLInputElement>(null);
  const locked = useRef(false);
  const [paletteDirty, setPaletteDirty] = useState(false);
  const paletteSave = useRef<(() => Promise<boolean>) | null>(null);
  const registerPaletteSave = useCallback((handler: (() => Promise<boolean>) | null) => {
    paletteSave.current = handler;
  }, []);
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
    paletteTitle(
      (state.catalog.palettes ?? BUILTIN_PALETTES).find((palette) => palette.id === activePaletteId)
    ) || t('visualpanels.originalLayoutColors');
  const resolvedLayout = resolveTheme(state.catalog, editingScope);
  const editedPaletteId = resolvePaletteId(state.catalog, editingScope);
  const editedPaletteTitle =
    paletteTitle(
      (state.catalog.palettes ?? BUILTIN_PALETTES).find((palette) => palette.id === editedPaletteId)
    ) || t('visualpanels.originalLayoutColors');
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
  const defaultLegacyLayout = getBuiltinTheme(p.defaultThemeId);
  const globalLayouts =
    defaultLegacyLayout && !state.catalog.themes.some((theme) => theme.id === p.defaultThemeId)
      ? [...state.catalog.themes, defaultLegacyLayout]
      : state.catalog.themes;
  const selectedLegacyLayout = selectedId && getBuiltinTheme(selectedId);
  const layouts =
    selectedLegacyLayout && !state.catalog.themes.some((theme) => theme.id === selectedId)
      ? [...state.catalog.themes, selectedLegacyLayout]
      : state.catalog.themes;
  const palettes = [
    {
      id: THEME_PALETTE_ID,
      title: t('visualpanels.originalLayoutColors'),
      description: '',
      colors: originalColors ?? { light: {}, dark: {} },
    },
    ...(state.catalog.palettes ?? BUILTIN_PALETTES),
  ];
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
      setError((cause as Error).message);
    } finally {
      locked.current = false;
      setOperation(null);
    }
  }
  function edit(theme?: Theme, copy = false) {
    if (dirty) {
      setError('현재 편집을 저장하거나 취소한 뒤 다른 테마를 열어 주세요.');
      return;
    }
    const model = theme ? structuredClone(themeDefinition(theme)) : emptyTheme();
    const isCopy = copy || !!theme?.id.startsWith('builtin:');
    if (theme && isCopy) model.title += ' 사본';
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
  }
  function patch(next: Partial<ThemeDefinition>) {
    setDraft((d) => (d ? { ...d, model: { ...d.model, ...next } } : d));
  }
  async function save(): Promise<boolean> {
    if (fontDirty && !(await fontSave.current?.())) return false;
    if (paletteDirty && !(await paletteSave.current?.())) return false;
    if (backgroundDirty && !(await backgroundSave.current?.())) return false;
    if (!draft || locked.current) return !draft;
    let saved = false;
    await action(async () => {
      const model = validateTheme(draft.model);
      themeTemplate(model.templateHtml);
      const result = await api<{ saved: Theme }>('/resources/save', {
        kind: 'theme',
        id: draft.id,
        expectedRevision: draft.revision,
        model,
      });
      setDraft({
        id: result.saved.id,
        revision: result.saved.revision,
        model: themeDefinition(result.saved),
      });
      setBaseline(JSON.stringify(themeDefinition(result.saved)));
      setPreview(null);
      await state.refresh(true);
      setNotice('테마를 저장했어요. 적용 버튼으로 사용할 수 있어요.');
      saved = true;
    }, true);
    return saved;
  }
  useSettingsSaveHandler(onSaveHandlerChange, save);
  function choose(themeId: string | null, targetScope = scope) {
    void action(async () => {
      await api('/themes/selection', {
        scope: targetScope,
        targetId:
          targetScope === 'bot'
            ? state.scope.botId
            : targetScope === 'chat'
              ? state.scope.chatId
              : undefined,
        themeId,
        expectedRevision: p.revision,
      });
      setPreview(null);
      state.setDisabled(false);
      await state.refresh(true);
      setNotice(
        targetScope === 'global' &&
          ((state.scope.chatId && p.chatThemes[state.scope.chatId]) ||
            (state.scope.botId && p.botThemes[state.scope.botId]))
          ? '기본 레이아웃을 바꿨어요. 현재 채팅은 별도로 지정한 레이아웃을 사용해요.'
          : '레이아웃 선택을 저장했어요.'
      );
    });
  }
  function choosePalette(paletteId: string | null) {
    void action(async () => {
      await api('/themes/selection', {
        dimension: 'palette',
        scope,
        targetId:
          scope === 'bot' ? state.scope.botId : scope === 'chat' ? state.scope.chatId : undefined,
        paletteId,
        expectedRevision: p.revision,
      });
      setPreview(null);
      state.setDisabled(false);
      await state.refresh(true);
      setNotice(
        scope === 'global' &&
          ((state.scope.chatId && p.chatPalettes?.[state.scope.chatId]) ||
            (state.scope.botId && p.botPalettes?.[state.scope.botId]))
          ? '기본 팔레트를 바꿨어요. 현재 채팅은 별도로 지정한 팔레트를 사용해요.'
          : '팔레트 선택을 저장했어요.'
      );
    });
  }
  async function importFile(file: File) {
    if (dirty) {
      setError('편집 중인 테마를 저장하거나 취소한 뒤 가져와 주세요.');
      return;
    }
    await action(async () => {
      if (file.size > 4 * 1024 * 1024)
        throw new Error(uiMessage('visualpanels.importAThemeFileNoLargerThan'));
      const model = parseThemeFile(JSON.parse(await file.text()));
      themeTemplate(model.templateHtml);
      setDraft({ id: null, model });
      setBaseline('');
      setImportNotice(
        '새 테마로 가져왔어요. 내용을 확인하고 저장해 주세요. 기존 테마는 덮어쓰지 않아요.'
      );
    });
  }
  return (
    <section className="theme-settings" aria-label={t('visualpanels.themesAndColors')}>
      <SaveConflictDialog
        open={saveConflict}
        title={t('visualpanels.reviewSavedTheme')}
        onClose={() => setSaveConflict(false)}
        readSaved={async () => {
          const value = (await api<ThemeCatalog>('/themes')).themes.find(
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
      <div className="theme-toolbar theme-control-bar theme-default-control">
        <label>
          {t('visualpanels.defaultAppearance')}{' '}
          <select
            aria-label={t('visualpanels.defaultAppearance')}
            value={p.defaultThemeId}
            disabled={busy || backgroundDirty || paletteDirty || state.loading}
            onChange={(event) => choose(event.target.value, 'global')}
          >
            {globalLayouts.map((theme) => (
              <option key={theme.id} value={theme.id}>
                {theme.id.startsWith('builtin:') ? translateMessage(theme.title) : theme.title}
              </option>
            ))}
          </select>
        </label>
        <span className="theme-current">
          {t('visualpanels.currentDisplay', {
            v0: state.active.id.startsWith('builtin:')
              ? translateMessage(state.active.title)
              : state.active.title,
            v1: state.preview ? t('visualpanels.previewColors') : activePaletteTitle,
          })}
        </span>
      </div>
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
      <TransientNotice message={notice} />
      <details className="theme-advanced">
        <summary>{t('visualpanels.advancedAppearanceAndThemeCreation')}</summary>
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
        </div>
        <section className="theme-dimension" aria-labelledby="theme-layout-heading">
          <div className="theme-dimension-heading">
            <div>
              <h3 id="theme-layout-heading">{t('visualpanels.layout')}</h3>
              {layoutSource && (
                <small>
                  {t('settings.inheritedThemeSelection', {
                    title: activeLayout?.id.startsWith('builtin:')
                      ? translateMessage(activeLayout.title)
                      : (activeLayout?.title ?? ''),
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
            {layouts.map((theme) => (
              <article
                className={`theme-card ${selectedId === theme.id ? 'selected' : ''}`}
                key={theme.id}
              >
                <button
                  className="theme-card-apply"
                  aria-label={t('visualpanels.applyTheme', {
                    v0: theme.id.startsWith('builtin:')
                      ? translateMessage(theme.title)
                      : theme.title,
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
                    <span>
                      {theme.id.startsWith('builtin:')
                        ? translateMessage(theme.title)
                        : theme.title}
                    </span>
                    {selectedId === theme.id && <Check size={18} aria-hidden="true" />}
                  </strong>
                  {theme.description && theme.id !== DEFAULT_THEME_ID && (
                    <small>
                      {theme.id.startsWith('builtin:')
                        ? translateMessage(theme.description)
                        : theme.description}
                    </small>
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
                      v0: theme.id.startsWith('builtin:')
                        ? translateMessage(theme.title)
                        : theme.title,
                    })}
                    icon={DownloadIcon}
                    onClick={() =>
                      saveDownload(
                        `${theme.title}.uimori-theme.json`,
                        themeFile(themeDefinition(theme))
                      )
                    }
                  />
                </div>
                {!theme.id.startsWith('builtin:') && (
                  <ActionMenu
                    label={t('visualpanels.manage', {
                      v0: theme.id.startsWith('builtin:')
                        ? translateMessage(theme.title)
                        : theme.title,
                    })}
                    className="theme-card-menu"
                    viewport
                  >
                    <button
                      aria-label={t('visualpanels.duplicate', {
                        v0: theme.id.startsWith('builtin:')
                          ? translateMessage(theme.title)
                          : theme.title,
                      })}
                      disabled={busy || backgroundDirty || paletteDirty}
                      onClick={() => edit(theme, true)}
                    >
                      <CopyIcon size={18} aria-hidden="true" /> {t(
                        'visualpanels.duplicateAndEdit'
                      )}{' '}
                    </button>
                    <button
                      className="danger"
                      aria-label={t('visualpanels.delete', {
                        v0: theme.id.startsWith('builtin:')
                          ? translateMessage(theme.title)
                          : theme.title,
                      })}
                      disabled={busy || dirty}
                      onClick={(event) => {
                        event.currentTarget.closest('details')?.querySelector('summary')?.focus();
                        setDeleting(theme);
                      }}
                    >
                      <DeleteIcon size={18} aria-hidden="true" /> {t('visualpanels.delete2')}{' '}
                    </button>
                  </ActionMenu>
                )}
              </article>
            ))}
          </div>
          <p className="theme-help">{t('settings.themeExportScope')}</p>
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
          </div>
          <div className="theme-palette-grid" aria-label={t('visualpanels.selectColorPalette')}>
            {palettes.map((palette) => {
              const colors = { ...baselineThemeColors[mode], ...palette.colors[mode] };
              return (
                <button
                  key={palette.id}
                  className={`theme-palette-card ${selectedPaletteId === palette.id ? 'selected' : ''}`}
                  aria-label={t('visualpanels.applyPalette', {
                    v0: paletteTitle(palette),
                  })}
                  aria-describedby={palette.description ? `${id}-palette-${palette.id}` : undefined}
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
                      {'revision' in palette
                        ? palette.description
                        : translateMessage(palette.description)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </section>
        <PaletteSettings
          active={active}
          disabled={busy || backgroundDirty || dirty}
          onDirtyChange={setPaletteDirty}
          onSaveHandlerChange={registerPaletteSave}
        />
        <FontSettings onDirtyChange={setFontDirty} onSaveHandlerChange={registerFontSave} />
        <ThemeBackgroundSettings
          key={`${scope}:${scope === 'bot' ? state.scope.botId : scope === 'chat' ? state.scope.chatId : ''}`}
          scope={scope}
          disabled={busy || paletteDirty}
          targetId={
            scope === 'bot' ? state.scope.botId : scope === 'chat' ? state.scope.chatId : undefined
          }
          onDirtyChange={setBackgroundDirty}
          onSaveHandlerChange={registerBackgroundSave}
        />
        <section className="theme-library-tools" aria-label={t('visualpanels.manageThemes')}>
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
                    <span>{translateMessage(labels[key] ?? key)}</span>
                    <div>
                      <input
                        type="color"
                        aria-label={t('visualpanels.color', {
                          v0:
                            locale === 'ko'
                              ? mode
                              : mode === 'light'
                                ? t('visualpanels.lightColors')
                                : t('visualpanels.darkColors'),
                          v1: locale === 'ko' ? key : translateMessage(labels[key] ?? key),
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
                          v1: translateMessage(labels[key] ?? key),
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
              <p className="muted">{t('settings.layoutColorStorage')}</p>
              <details className="theme-code">
                <summary>{t('visualpanels.editCssAndHtmlDirectly')}</summary>
                <p>{t('visualpanels.appCssAppliesToTheWorkspaceBody')}</p>
                <p>{t('visualpanels.themeAuthoringHelp', { path: 'docs/THEME-AUTHORING.md' })}</p>
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
                text=""
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
                    setError((cause as Error).message);
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
                onClick={() => {
                  setDraft(null);
                  setPreview(null);
                  setError('');
                }}
              />
            </div>
          </section>
        )}
        {state.preview && (
          <p role="status">{t('visualpanels.previewingAnUnsavedThemeMovingToAnother')}</p>
        )}
        <details className="theme-sample">
          <summary>{t('visualpanels.previewSampleWithCurrentTheme')}</summary>
          <ThemeFrame>
            <div slot="request">{t('visualpanels.startAStoryInAQuietLibrary')}</div>
            <div slot="heading" className="scene-header">
              <strong>{t('visualpanels.firstScene')}</strong>
              <span>{t('visualpanels.originalTranslation')}</span>
            </div>
            <div slot="body">
              <RisuMessageSurface html={sample} onAction={async () => {}} disabled />
            </div>
            <div slot="actions" className="source-actions">
              <button type="button">{t('visualpanels.bodyActionExample')}</button>
            </div>
          </ThemeFrame>
        </details>
        {importNotice && <p role="status">{translateMessage(importNotice)}</p>}
        <p className="theme-help">
          {t('visualpanels.themeRecoveryHelp', {
            shortcut: 'Ctrl/Cmd + .',
            query: '?theme-safe=1',
          })}
        </p>
      </details>
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
                await api(
                  `/themes/${encodeURIComponent(deleting.id)}`,
                  { expectedRevision: deleting.revision },
                  'DELETE'
                );
                if (draft?.id === deleting.id) setDraft(null);
                setPreview(null);
                setDeleting(null);
                await state.refresh(true);
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
