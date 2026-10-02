import { baselineThemeColors, colorInputValue } from './theme-color-input.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ThemeBackgroundSettings } from './ThemeBackgroundSettings.js';
import { Plus, Upload, Download, Copy, Trash2, Eye, RotateCcw } from 'lucide-react';
import {
  THEME_COLOR_KEYS,
  emptyTheme,
  getBuiltinTheme,
  parseThemeFile,
  resolvePaletteId,
  themeFile,
  themeDefinition,
  validateTheme,
  type Theme,
  type ThemeColorKey,
  type ThemeDefinition,
} from '../core/themes.js';
import { BUILTIN_PALETTES, THEME_PALETTE_ID } from '../core/theme-palettes.js';
import { api, ApiError, saveDownload } from './api.js';
import { useThemes } from './ThemeContext.js';
import { themeTemplate, ThemeFrame } from './ThemeFrame.js';
import { RisuMessageSurface } from './RisuMessageSurface.js';
import { useSettingsSaveHandler, type SettingsSaveRegistration } from './useSettingsSaveHandler.js';
import { Dialog } from './Dialog.js';
import './themes.css';

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
const sample =
  '<div class="risu-chat-text"><p data-uimori-prose>책장을 넘기자 오래된 종이 냄새가 은은하게 퍼졌다.</p><p data-uimori-prose>“오늘은 어떤 이야기를 함께 읽을까요?”</p></div><details><summary>봇이 만든 상태창</summary><label>메모 <input aria-label="테마 예문 메모" placeholder="테마를 바꿔도 유지돼요" /></label></details>';
export function ThemeSettings({
  onDirtyChange,
  onSaveHandlerChange,
  appearanceMode,
  onAppearanceModeChange,
  active = true,
}: {
  appearanceMode: 'system' | 'light' | 'dark';
  onAppearanceModeChange: (value: 'system' | 'light' | 'dark') => void;
  onDirtyChange?: (value: boolean) => void;
  onSaveHandlerChange?: SettingsSaveRegistration;
  active?: boolean;
}) {
  const state = useThemes();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState('');
  const [mode, setMode] = useState<'light' | 'dark'>('light');
  const [scope, setScope] = useState<'global' | 'bot' | 'chat'>('global');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [deleting, setDeleting] = useState<Theme | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const locked = useRef(false);
  const [backgroundDirty, setBackgroundDirty] = useState(false);
  const backgroundSave = useRef<(() => Promise<boolean>) | null>(null);
  const registerBackgroundSave = useCallback((handler: (() => Promise<boolean>) | null) => {
    backgroundSave.current = handler;
  }, []);
  const dirty = !!draft && JSON.stringify(draft.model) !== baseline;
  const { setPreview } = state;
  useEffect(() => {
    onDirtyChange?.(dirty || backgroundDirty);
  }, [dirty, backgroundDirty, onDirtyChange]);
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
  const activePaletteId = resolvePaletteId(state.catalog, state.scope);
  const activePaletteTitle =
    BUILTIN_PALETTES.find((palette) => palette.id === activePaletteId)?.title ??
    '레이아웃 원래 색상';
  const activeLayout =
    state.catalog.themes.find((theme) => theme.id === state.active.id) ??
    getBuiltinTheme(state.active.id);
  const originalColors = activeLayout?.colors;
  const selectedLegacyLayout = selectedId && getBuiltinTheme(selectedId);
  const layouts =
    selectedLegacyLayout && !state.catalog.themes.some((theme) => theme.id === selectedId)
      ? [...state.catalog.themes, selectedLegacyLayout]
      : state.catalog.themes;
  const palettes = [
    {
      id: THEME_PALETTE_ID,
      title: '레이아웃 원래 색상',
      description: '선택한 레이아웃에 저장된 색상을 사용해요.',
      colors: originalColors ?? { light: {}, dark: {} },
    },
    ...BUILTIN_PALETTES,
  ];
  async function action(work: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) await state.refresh();
      setError((cause as Error).message);
    } finally {
      locked.current = false;
      setBusy(false);
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
    setPreview(null);
  }
  function patch(next: Partial<ThemeDefinition>) {
    setDraft((d) => (d ? { ...d, model: { ...d.model, ...next } } : d));
  }
  async function save(): Promise<boolean> {
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
    });
    return saved;
  }
  useSettingsSaveHandler(onSaveHandlerChange, save);
  function choose(themeId: string | null) {
    void action(async () => {
      await api('/themes/selection', {
        scope,
        targetId:
          scope === 'bot' ? state.scope.botId : scope === 'chat' ? state.scope.chatId : undefined,
        themeId,
        expectedRevision: p.revision,
      });
      setPreview(null);
      state.setDisabled(false);
      await state.refresh(true);
      setNotice(
        scope === 'global' &&
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
      if (file.size > 4 * 1024 * 1024) throw new Error('테마 파일은 4MiB 이하로 가져와 주세요.');
      const model = parseThemeFile(JSON.parse(await file.text()));
      themeTemplate(model.templateHtml);
      setDraft({ id: null, model });
      setBaseline('');
      setNotice(
        '새 테마로 가져왔어요. 내용을 확인하고 저장해 주세요. 기존 테마는 덮어쓰지 않아요.'
      );
    });
  }
  return (
    <section className="theme-settings" aria-label="테마와 색상">
      <p className="theme-intro">
        레이아웃은 화면 배치를, 팔레트는 색상을 바꿔요. 화면 모드와 각각 따로 선택할 수 있어요.
      </p>
      <div className="settings-card theme-toolbar theme-control-bar">
        <label>
          화면 모드
          <select
            aria-label="테마 화면 모드"
            value={appearanceMode}
            onChange={(e) => onAppearanceModeChange(e.target.value as typeof appearanceMode)}
          >
            <option value="system">기기 설정 따르기</option>
            <option value="light">밝게</option>
            <option value="dark">어둡게</option>
          </select>
        </label>
        <label>
          적용 범위
          <select
            aria-label="테마 적용 범위"
            value={scope}
            disabled={busy || backgroundDirty}
            onChange={(e) => setScope(e.target.value as typeof scope)}
          >
            <option value="global">작업실 기본</option>
            {state.scope.botId && <option value="bot">현재 봇의 기본</option>}
            {state.scope.chatId && <option value="chat">현재 채팅만</option>}
          </select>
        </label>
        <label>
          미리보기 색상
          <select
            aria-label="테마 색상 보기"
            value={mode}
            onChange={(e) => setMode(e.target.value as typeof mode)}
          >
            <option value="light">밝은 색</option>
            <option value="dark">어두운 색</option>
          </select>
        </label>
        <span className="theme-current">
          현재 화면 · {state.active.title} / {state.preview ? '미리보기 색상' : activePaletteTitle}
        </span>
      </div>
      {state.disabled && (
        <p role="status" className="theme-recovery">
          이 탭에서는 사용자 테마를 잠시 껐어요.{' '}
          <button onClick={() => state.setDisabled(false)}>테마 다시 켜기</button>
        </p>
      )}
      {state.error && (
        <p className="error" role="alert">
          {state.error} <button onClick={() => void state.refresh()}>다시 불러오기</button>
        </p>
      )}
      <ThemeBackgroundSettings
        key={`${scope}:${scope === 'bot' ? state.scope.botId : scope === 'chat' ? state.scope.chatId : ''}`}
        scope={scope}
        disabled={busy}
        targetId={
          scope === 'bot' ? state.scope.botId : scope === 'chat' ? state.scope.chatId : undefined
        }
        onDirtyChange={setBackgroundDirty}
        onSaveHandlerChange={registerBackgroundSave}
      />
      <section className="theme-dimension" aria-labelledby="theme-layout-heading">
        <div className="theme-dimension-heading">
          <div>
            <h3 id="theme-layout-heading">레이아웃</h3>
            <p>본문과 요청, 도구의 배치를 골라요. 선택한 색상 팔레트는 유지돼요.</p>
          </div>
          {scope !== 'global' && (
            <button
              disabled={busy || backgroundDirty || state.loading || !selectedId}
              onClick={() => choose(null)}
            >
              레이아웃 상위 설정 따르기
            </button>
          )}
        </div>
        {scope !== 'global' && !selectedId && (
          <p className="theme-inherited">이 범위의 레이아웃은 상위 설정을 따라요.</p>
        )}
        <div className="theme-grid" aria-label="저장된 레이아웃">
          {layouts.map((theme) => (
            <article
              className={`theme-card ${selectedId === theme.id ? 'selected' : ''}`}
              key={theme.id}
            >
              <button
                className="theme-card-apply"
                aria-label={`${theme.title} 테마 적용`}
                aria-pressed={selectedId === theme.id}
                disabled={busy || backgroundDirty || state.loading}
                onClick={() => choose(theme.id)}
              >
                <span
                  className="theme-swatch"
                  data-layout={theme.id}
                  aria-hidden="true"
                  style={{
                    background: theme.colors[mode].bg ?? (mode === 'light' ? '#fafbf8' : '#1a1d1b'),
                    color: theme.colors[mode].text ?? (mode === 'light' ? '#232c22' : '#eef1eb'),
                  }}
                >
                  <span
                    className="theme-swatch-nav"
                    style={{
                      background:
                        theme.colors[mode].nav ?? (mode === 'light' ? '#f0f2ec' : '#141715'),
                    }}
                  />
                  <span className="theme-swatch-page">
                    <span>Aa</span>
                    <i />
                    <i />
                    <b style={{ background: theme.colors[mode].accent ?? '#355b39' }} />
                  </span>
                </span>
                <strong>
                  {theme.title}
                  {selectedId === theme.id ? ' · 선택됨' : ''}
                </strong>
                <small>{theme.description || '사용자 테마'}</small>
              </button>
              <div className="theme-card-actions">
                <button disabled={busy || backgroundDirty} onClick={() => edit(theme)}>
                  {theme.id.startsWith('builtin:') ? '복제해서 꾸미기' : '편집'}
                </button>
                {!theme.id.startsWith('builtin:') && (
                  <button
                    aria-label={`${theme.title} 복제`}
                    title="복제"
                    disabled={busy || backgroundDirty}
                    onClick={() => edit(theme, true)}
                  >
                    <Copy size={16} />
                  </button>
                )}
                <button
                  aria-label={`${theme.title} 내보내기`}
                  title="내보내기"
                  onClick={() =>
                    saveDownload(
                      `${theme.title}.uimori-theme.json`,
                      themeFile(themeDefinition(theme))
                    )
                  }
                >
                  <Download size={16} />
                </button>
                {!theme.id.startsWith('builtin:') && (
                  <button
                    aria-label={`${theme.title} 삭제`}
                    title="삭제"
                    disabled={busy || dirty}
                    onClick={() => setDeleting(theme)}
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      </section>
      <section className="theme-dimension" aria-labelledby="theme-palette-heading">
        <div className="theme-dimension-heading">
          <div>
            <h3 id="theme-palette-heading">색상 팔레트</h3>
            <p>배치와 읽기 설정을 유지하면서 화면 색상만 바꿔요.</p>
          </div>
          <button
            disabled={
              busy ||
              backgroundDirty ||
              state.loading ||
              (scope === 'global' ? selectedPaletteId === THEME_PALETTE_ID : !selectedPaletteId)
            }
            onClick={() => choosePalette(null)}
          >
            {scope === 'global' ? '팔레트 기본값으로' : '팔레트 상위 설정 따르기'}
          </button>
        </div>
        {scope !== 'global' && !selectedPaletteId && (
          <p className="theme-inherited">이 범위의 팔레트는 상위 설정을 따라요.</p>
        )}
        <div className="theme-palette-grid" aria-label="색상 팔레트 선택">
          {palettes.map((palette) => {
            const colors = { ...baselineThemeColors[mode], ...palette.colors[mode] };
            return (
              <button
                key={palette.id}
                className={`theme-palette-card ${selectedPaletteId === palette.id ? 'selected' : ''}`}
                aria-label={`${palette.title} 팔레트 적용`}
                aria-pressed={selectedPaletteId === palette.id}
                disabled={busy || backgroundDirty || state.loading}
                onClick={() => choosePalette(palette.id)}
              >
                <span className="theme-palette-swatches" aria-hidden="true">
                  {(['bg', 'panel', 'accent', 'text'] as const).map((key) => (
                    <span key={key} style={{ background: colors[key] }} />
                  ))}
                </span>
                <strong>
                  {palette.title}
                  {selectedPaletteId === palette.id ? ' · 선택됨' : ''}
                </strong>
                <small>{palette.description}</small>
              </button>
            );
          })}
        </div>
      </section>
      <section className="theme-library-tools" aria-label="테마 관리">
        <div className="theme-library-copy">
          <h4>테마 관리</h4>
          <p>
            커스텀 테마를 만들거나 파일에서 가져와요. 내보낸 파일에는 레이아웃 자체의 색상과 코드가
            담겨요.
          </p>
        </div>
        <div className="theme-library-actions">
          <button className="primary" disabled={busy || backgroundDirty} onClick={() => edit()}>
            <Plus size={16} /> 새 커스텀 테마
          </button>
          <button
            className="secondary"
            disabled={busy || backgroundDirty}
            onClick={() => input.current?.click()}
          >
            <Upload size={16} /> 테마 가져오기
          </button>
          <input
            ref={input}
            type="file"
            accept=".json"
            hidden
            aria-label="테마 파일"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void importFile(f);
            }}
          />
        </div>
      </section>
      {draft && (
        <section className="theme-editor" aria-label="커스텀 테마 편집기">
          <div className="theme-editor-heading">
            <h3>{draft.id ? '테마 편집' : '새 테마 만들기'}</h3>
            <span className="muted">{dirty ? '미저장 변경' : '저장됨'}</span>
          </div>
          <fieldset disabled={busy || backgroundDirty}>
            <label>
              테마 이름
              <input
                aria-label="테마 이름"
                value={draft.model.title}
                maxLength={100}
                onChange={(e) => patch({ title: e.target.value })}
              />
            </label>
            <label>
              설명
              <input
                aria-label="테마 설명"
                value={draft.model.description}
                onChange={(e) => patch({ description: e.target.value })}
              />
            </label>
            <div className="theme-colors">
              {THEME_COLOR_KEYS.map((key) => (
                <label key={key}>
                  <span>{labels[key] ?? key}</span>
                  <div>
                    <input
                      type="color"
                      aria-label={`${mode} ${key} 색상`}
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
                    <button
                      type="button"
                      title="기본값 상속"
                      aria-label={`${mode} ${key} 초기화`}
                      disabled={!draft.model.colors[mode][key]}
                      onClick={() => {
                        const colors = { ...draft.model.colors[mode] };
                        delete colors[key];
                        patch({ colors: { ...draft.model.colors, [mode]: colors } });
                      }}
                    >
                      <RotateCcw size={14} />
                    </button>
                  </div>
                </label>
              ))}
            </div>
            <p className="muted">
              위 ‘미리보기 색상’에서 밝은 색과 어두운 색을 각각 편집해요. 지정하지 않은 색은 Uimori
              기본 색상을 따라요. 편집한 색상은 레이아웃에 저장되며, 적용할 때는 팔레트에서
              ‘레이아웃 원래 색상’을 골라 주세요.
            </p>
            <details className="theme-code">
              <summary>CSS·HTML 직접 편집</summary>
              <p>
                앱 CSS는 작업실, 본문 CSS는 봇 메시지 안에 적용해요. 레이아웃은
                request·heading·body·actions 슬롯을 각각 하나씩 포함해야 해요. JavaScript와 Risu
                CBS는 실행하지 않아요.
              </p>
              {(
                [
                  ['appCss', '앱 CSS'],
                  ['messageCss', '본문 CSS'],
                  ['templateHtml', '레이아웃 HTML'],
                  ['templateCss', '레이아웃 CSS'],
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
          <div className="theme-toolbar">
            <button className="primary" disabled={busy || !dirty} onClick={() => void save()}>
              테마 저장
            </button>
            <button
              disabled={busy || backgroundDirty}
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
              <Eye size={16} /> 미리 적용
            </button>
            {state.preview && <button onClick={() => setPreview(null)}>미리보기 끝내기</button>}
            <button
              disabled={busy || backgroundDirty}
              onClick={() => {
                setDraft(null);
                setPreview(null);
                setError('');
              }}
            >
              편집 취소
            </button>
          </div>
        </section>
      )}
      {state.preview && (
        <p role="status">
          저장하지 않은 테마를 미리 보고 있어요. 다른 설정으로 이동하거나 설정을 닫으면 원래 테마로
          돌아가요.
        </p>
      )}
      <details className="theme-sample">
        <summary>현재 테마로 예문 보기</summary>
        <ThemeFrame>
          <div slot="request">조용한 도서관에서 이야기를 시작해줘.</div>
          <div slot="heading" className="scene-header">
            <strong>첫 번째 장면</strong>
            <span>원문 · 번역</span>
          </div>
          <div slot="body">
            <RisuMessageSurface html={sample} onAction={async () => {}} disabled />
          </div>
          <div slot="actions" className="source-actions">
            <button type="button">본문 작업 예시</button>
          </div>
        </ThemeFrame>
      </details>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <p className="theme-help">
        꾸미다가 화면이 깨지면 <kbd>Ctrl/Cmd + .</kbd>로 이 탭의 테마를 끄세요. 주소에{' '}
        <code>?theme-safe=1</code>을 붙여 열어도 돼요. 테마 제작 규약은 저장소의{' '}
        <code>docs/THEME-AUTHORING.md</code>에 있어요.
      </p>
      <Dialog
        open={!!deleting}
        title="테마 삭제"
        onClose={() => {
          if (!busy) setDeleting(null);
        }}
      >
        <p>
          {deleting?.title} 테마를 삭제할까요? 이 테마를 선택한 봇과 채팅은 상위 또는 기본 테마로
          돌아가요.
        </p>
        <button
          disabled={busy || backgroundDirty}
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
          삭제
        </button>
        <button disabled={busy || backgroundDirty} onClick={() => setDeleting(null)}>
          취소
        </button>
      </Dialog>
    </section>
  );
}
