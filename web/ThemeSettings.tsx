import { baselineThemeColors, colorInputValue } from './theme-color-input.js';
import { useEffect, useRef, useState } from 'react';
import { Palette, Plus, Upload, Download, Copy, Trash2, Eye, RotateCcw } from 'lucide-react';
import {
  THEME_COLOR_KEYS,
  emptyTheme,
  parseThemeFile,
  themeFile,
  themeDefinition,
  validateTheme,
  type Theme,
  type ThemeColorKey,
  type ThemeDefinition,
} from '../core/themes.js';
import { api, saveDownload } from './api.js';
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
  const dirty = !!draft && JSON.stringify(draft.model) !== baseline;
  const { setPreview } = state;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
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
  async function action(work: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (cause) {
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
          ? '기본 테마를 바꿨어요. 현재 채팅은 별도로 지정한 테마를 사용해요.'
          : '테마 선택을 저장했어요.'
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
      <div className="theme-intro">
        <Palette size={24} aria-hidden="true" />
        <div>
          <h3>이야기에 어울리는 색과 분위기</h3>
          <p>테마는 작업실에 저장돼요. 본문과 봇의 동작은 그대로 유지해요.</p>
        </div>
      </div>
      <div className="theme-toolbar">
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
            disabled={busy}
            onChange={(e) => setScope(e.target.value as typeof scope)}
          >
            <option value="global">작업실 기본</option>
            {state.scope.botId && <option value="bot">현재 봇의 기본</option>}
            {state.scope.chatId && <option value="chat">현재 채팅만</option>}
          </select>
        </label>
        {scope !== 'global' && (
          <button disabled={busy || !selectedId} onClick={() => choose(null)}>
            상위 설정 따르기
          </button>
        )}
        <span className="theme-current">현재 화면 · {state.active.title}</span>
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
      <div className="theme-grid" aria-label="저장된 테마">
        {state.catalog.themes.map((theme) => (
          <article
            className={`theme-card ${selectedId === theme.id ? 'selected' : ''}`}
            key={theme.id}
          >
            <button
              className="theme-card-apply"
              aria-label={`${theme.title} 테마 적용`}
              aria-pressed={selectedId === theme.id}
              disabled={busy || state.loading}
              onClick={() => choose(theme.id)}
            >
              <span
                className="theme-swatch"
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
              <button disabled={busy} onClick={() => edit(theme)}>
                {theme.id.startsWith('builtin:') ? '복제·꾸미기' : '편집'}
              </button>
              {!theme.id.startsWith('builtin:') && (
                <button
                  aria-label={`${theme.title} 복제`}
                  title="복제"
                  disabled={busy}
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
      <div className="theme-toolbar">
        <button disabled={busy} onClick={() => edit()}>
          <Plus size={16} /> 새 커스텀 테마
        </button>
        <button disabled={busy} onClick={() => input.current?.click()}>
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
        <label>
          색상 보기
          <select
            aria-label="테마 색상 보기"
            value={mode}
            onChange={(e) => setMode(e.target.value as typeof mode)}
          >
            <option value="light">밝은 색</option>
            <option value="dark">어두운 색</option>
          </select>
        </label>
      </div>
      {draft && (
        <section className="theme-editor" aria-label="커스텀 테마 편집기">
          <div className="theme-editor-heading">
            <h3>{draft.id ? '테마 편집' : '새 테마 만들기'}</h3>
            <span className="muted">{dirty ? '미저장 변경' : '저장됨'}</span>
          </div>
          <fieldset disabled={busy}>
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
              지정하지 않은 색은 기본 테마에서 상속해요. 위 ‘색상 보기’에서 밝은 색과 어두운 색을
              각각 편집해요.
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
              disabled={busy}
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
              disabled={busy}
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
          disabled={busy}
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
        <button disabled={busy} onClick={() => setDeleting(null)}>
          취소
        </button>
      </Dialog>
    </section>
  );
}
