import { DraftDiscardActions } from './DraftDiscardActions.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Plus,
  Upload,
  Download,
  Copy,
  Trash2,
  RefreshCw,
  Check,
  Pencil,
  RotateCcw,
  Save,
  X,
} from 'lucide-react';
import {
  emptyIllustrationPreset,
  illustrationPresetDefinition,
  illustrationPresetFile,
  parseIllustrationPresetFile,
  resolveIllustrationPreset,
  validateIllustrationPreset,
  ILLUSTRATION_PRESET_FILE_MAX_BYTES,
  ILLUSTRATION_WORKFLOW_MAX_CHARS,
  type IllustrationPreset,
  type IllustrationPresetCatalog,
  type IllustrationPresetDefinition,
  type IllustrationPresetScope,
} from '../core/illustration-presets.js';
import { SOURCE_TEXT_MAX_CHARS } from '../core/content-limits.js';
import { api, ApiError, saveDownload } from './api.js';
import { Dialog } from './Dialog.js';
import { ActionMenu } from './ActionMenu.js';
import { illustrationErrorMessage } from './illustration-labels.js';
import { useSettingsSaveHandler, type SettingsSaveRegistration } from './useSettingsSaveHandler.js';
import './illustration-presets.css';

type Draft = { id: string | null; revision?: number; model: IllustrationPresetDefinition };
const changedKey = 'uimori:illustration-presets-changed';
const messageOf = (error: unknown) => {
  const message = (error as Error).message;
  return /^COMFYUI_/u.test(message) ? illustrationErrorMessage(message) : message;
};
export function IllustrationPresetSettings({
  scope,
  onDirtyChange,
  onSaveHandlerChange,
}: {
  scope: IllustrationPresetScope;
  onDirtyChange: (dirty: boolean) => void;
  onSaveHandlerChange?: SettingsSaveRegistration;
}) {
  const [catalog, setCatalog] = useState<IllustrationPresetCatalog | null>(null);
  const [target, setTarget] = useState<'global' | 'bot' | 'chat'>('global');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4500);
    return () => clearTimeout(timer);
  }, [notice]);
  const [deleting, setDeleting] = useState<IllustrationPreset | null>(null);
  const [discard, setDiscard] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const locked = useRef(false);
  const alive = useRef(true);
  const epoch = useRef(0);
  const dirty = !!draft && JSON.stringify(draft.model) !== baseline;
  const refresh = useCallback(async (notify = false) => {
    const version = ++epoch.current;
    try {
      const next = await api<IllustrationPresetCatalog>('/illustration-presets');
      if (alive.current && version === epoch.current) {
        setCatalog(next);
        setLoadError('');
      }
    } catch (cause) {
      if (alive.current && version === epoch.current) setLoadError(messageOf(cause));
    }
    if (notify) {
      try {
        localStorage.setItem(changedKey, `${Date.now()}:${Math.random()}`);
      } catch {
        /* Saving is already durable on the server. */
      }
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const focus = () => {
      void refresh();
    };
    const storage = (event: StorageEvent) => {
      if (event.key === changedKey) focus();
    };
    window.addEventListener('focus', focus);
    window.addEventListener('uimori-illustration-presets-changed', focus);
    window.addEventListener('storage', storage);
    return () => {
      alive.current = false;
      epoch.current++;
      window.removeEventListener('focus', focus);
      window.removeEventListener('uimori-illustration-presets-changed', focus);
      window.removeEventListener('storage', storage);
    };
  }, [refresh]);
  useEffect(() => {
    onDirtyChange(dirty || busy);
  }, [dirty, busy, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    if ((target === 'bot' && !scope.botId) || (target === 'chat' && !scope.chatId))
      setTarget('global');
  }, [target, scope.botId, scope.chatId]);
  async function action(work: () => Promise<void>): Promise<boolean> {
    if (locked.current) return false;
    locked.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      return true;
    } catch (cause) {
      setError(`${messageOf(cause)}${draft ? ' 편집 내용은 유지했어요.' : ''}`);
      if (cause instanceof ApiError && cause.status === 409) await refresh();
      return false;
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function save(asCopy = false): Promise<boolean> {
    if (!draft || (!dirty && !asCopy)) return true;
    return action(async () => {
      const model = validateIllustrationPreset(
        asCopy ? { ...draft.model, title: `${draft.model.title.slice(0, 97)} 사본` } : draft.model
      );
      const { saved } = await api<{ saved: IllustrationPreset }>('/resources/save', {
        kind: 'illustration-preset',
        id: asCopy ? null : draft.id,
        expectedRevision: asCopy ? undefined : draft.revision,
        model,
      });
      const accepted = illustrationPresetDefinition(saved);
      setDraft({ id: saved.id, revision: saved.revision, model: accepted });
      setBaseline(JSON.stringify(accepted));
      setNotice(
        draft.id && !asCopy
          ? '저장했어요. 다음 생성부터 적용돼요.'
          : '저장했어요. 사용할 범위에 적용해 주세요.'
      );
      await refresh(true);
    });
  }
  useSettingsSaveHandler(onSaveHandlerChange, () => save());
  function edit(preset?: IllustrationPreset, copy = false) {
    if (dirty) {
      setError('현재 편집을 저장하거나 닫은 뒤 다른 프리셋을 열어 주세요.');
      return;
    }
    const isCopy = copy || !!preset?.id.startsWith('builtin:');
    const model = preset
      ? structuredClone(illustrationPresetDefinition(preset))
      : emptyIllustrationPreset();
    if (preset && isCopy) model.title = `${model.title.slice(0, 97)} 사본`;
    setDraft({
      id: preset && !isCopy ? preset.id : null,
      revision: preset && !isCopy ? preset.revision : undefined,
      model,
    });
    setBaseline(preset && !isCopy ? JSON.stringify(model) : '');
    setError('');
    setNotice('');
  }
  function patch(patch: Partial<IllustrationPresetDefinition>) {
    setDraft((current) =>
      current ? { ...current, model: { ...current.model, ...patch } } : current
    );
    setNotice('');
  }
  async function importFile(file: File) {
    if (dirty) {
      setError('현재 편집을 저장하거나 닫은 뒤 가져와 주세요.');
      return;
    }
    await action(async () => {
      if (file.size > ILLUSTRATION_PRESET_FILE_MAX_BYTES)
        throw new Error('삽화 프리셋 파일은 16MiB 이하로 가져와 주세요.');
      const model = parseIllustrationPresetFile(JSON.parse(await file.text()));
      setDraft({ id: null, model });
      setBaseline('');
      setNotice('가져왔어요. 내용을 확인한 뒤 저장해 주세요.');
    });
  }
  if (!catalog)
    return (
      <section aria-label="삽화 프리셋">
        <p role="status">{loadError || '삽화 프리셋을 불러오는 중이에요…'}</p>
        <button onClick={() => void refresh()}>프리셋 다시 불러오기</button>
      </section>
    );
  const p = catalog.preferences;
  const selectedId =
    target === 'global'
      ? p.defaultPresetId
      : target === 'bot'
        ? p.botPresets[scope.botId ?? '']
        : p.chatPresets[scope.chatId ?? ''];
  const effective = resolveIllustrationPreset(catalog, scope);
  const conflict =
    !!draft?.id &&
    !!catalog.presets.find((item) => item.id === draft.id && item.revision !== draft.revision);
  const deleted = !!draft?.id && !catalog.presets.some((item) => item.id === draft.id);
  const choose = (presetId: string | null) =>
    action(async () => {
      await api('/illustration-presets/selection', {
        scope: target,
        targetId: target === 'bot' ? scope.botId : target === 'chat' ? scope.chatId : undefined,
        presetId,
        expectedRevision: p.revision,
      });
      await refresh(true);
      setNotice('프리셋을 변경했어요. 다음 생성부터 적용돼요.');
    });
  return (
    <section
      className="illustration-preset-settings illustration-settings"
      aria-label="삽화 프리셋"
    >
      <div className="illustration-preset-heading">
        <div>
          <h3>삽화 프리셋</h3>
          <p>그림 지침과 워크플로를 관리해요.</p>
        </div>
        <div className="illustration-preset-list-actions">
          <button
            className="primary"
            aria-label="새 삽화 프리셋"
            disabled={busy || dirty}
            onClick={() => edit()}
          >
            <Plus size={16} aria-hidden="true" /> 새 프리셋
          </button>
          <button
            aria-label="프리셋 가져오기"
            disabled={busy || dirty}
            onClick={() => input.current?.click()}
          >
            <Upload size={16} aria-hidden="true" /> 가져오기
          </button>
        </div>
      </div>
      <div className="illustration-preset-toolbar">
        <label>
          적용 범위
          <select
            aria-label="삽화 프리셋 적용 범위"
            value={target}
            disabled={busy || dirty}
            onChange={(event) => setTarget(event.target.value as typeof target)}
          >
            <option value="global">작업실 기본</option>
            {scope.botId && <option value="bot">현재 봇의 기본</option>}
            {scope.chatId && <option value="chat">현재 채팅만</option>}
          </select>
        </label>
        {target !== 'global' && (
          <button disabled={busy || dirty || !selectedId} onClick={() => void choose(null)}>
            <RotateCcw size={16} aria-hidden="true" /> 상위 설정 따르기
          </button>
        )}
        <p
          className="illustration-preset-current"
          title="채팅 → 봇 → 작업실 순으로 적용해요. 새 생성부터 사용돼요."
        >
          {scope.chatId ? '현재 채팅' : '작업실 기본'} · <strong>{effective.title}</strong>
        </p>
      </div>
      {(error || loadError) && (
        <p role="alert" className="error">
          {error || loadError}
        </p>
      )}
      {loadError && (
        <button onClick={() => void refresh()}>
          <RefreshCw size={16} aria-hidden="true" /> 다시 불러오기
        </button>
      )}
      {notice && (
        <p className="settings-feedback" role="status">
          {notice}
        </p>
      )}
      <div className="illustration-preset-grid" aria-label="저장된 삽화 프리셋">
        {catalog.presets.map((preset) => (
          <article
            className={`illustration-preset-card${selectedId === preset.id ? ' selected' : ''}`}
            key={preset.id}
          >
            <button
              className="illustration-preset-apply"
              aria-label={`${preset.title} 삽화 프리셋 적용`}
              aria-pressed={selectedId === preset.id}
              disabled={busy || dirty}
              onClick={() => void choose(preset.id)}
            >
              <div className="illustration-preset-title">
                <strong>{preset.title}</strong>
                {selectedId === preset.id && (
                  <span className="illustration-preset-selected">
                    <Check size={14} aria-hidden="true" /> 선택됨
                  </span>
                )}
              </div>
              <span>
                {preset.id.startsWith('builtin:')
                  ? '장면과 캐릭터를 따라 그려요.'
                  : preset.description || '사용자 삽화 프리셋'}
              </span>
              <small>
                {preset.comfyui.workflow.trim()
                  ? 'Codex · ComfyUI 워크플로 포함'
                  : 'Codex · ComfyUI 워크플로 없음'}
              </small>
            </button>
            <div className="illustration-preset-actions">
              <button
                disabled={busy || dirty}
                aria-label={`${preset.title} 삽화 프리셋 편집`}
                onClick={() => edit(preset)}
              >
                {preset.id.startsWith('builtin:') ? (
                  <Copy size={16} aria-hidden="true" />
                ) : (
                  <Pencil size={16} aria-hidden="true" />
                )}
                {preset.id.startsWith('builtin:') ? '복제 후 편집' : '편집'}
              </button>
              <ActionMenu label={`${preset.title} 프리셋 메뉴`} viewport>
                {!preset.id.startsWith('builtin:') && (
                  <button
                    disabled={busy || dirty}
                    aria-label={`${preset.title} 삽화 프리셋 복제`}
                    onClick={() => edit(preset, true)}
                  >
                    <Copy size={16} aria-hidden="true" /> 복제
                  </button>
                )}
                <button
                  disabled={busy}
                  aria-label={`${preset.title} 삽화 프리셋 내보내기`}
                  onClick={() => {
                    void action(async () =>
                      saveDownload(
                        `${preset.title}.uimori-illustration.json`,
                        illustrationPresetFile(preset)
                      )
                    );
                  }}
                >
                  <Download size={16} aria-hidden="true" /> 내보내기
                </button>
                {!preset.id.startsWith('builtin:') && (
                  <button
                    disabled={busy || dirty}
                    className="danger"
                    aria-label={`${preset.title} 삽화 프리셋 삭제`}
                    onClick={() => {
                      setError('');
                      setDeleting(preset);
                    }}
                  >
                    <Trash2 size={16} aria-hidden="true" /> 삭제
                  </button>
                )}
              </ActionMenu>
            </div>
          </article>
        ))}
      </div>
      <input
        ref={input}
        type="file"
        accept=".json"
        hidden
        aria-label="삽화 프리셋 파일"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void importFile(file);
        }}
      />
      {draft && (
        <section
          className="settings-card illustration-preset-editor"
          aria-label="삽화 프리셋 편집기"
        >
          <div className="illustration-preset-heading">
            <h4>{draft.id ? '프리셋 편집' : '새 프리셋 만들기'}</h4>
            <small>{dirty ? '미저장 변경' : '저장됨'}</small>
          </div>
          {(conflict || deleted) && (
            <p role="alert">
              {deleted
                ? '이 프리셋이 다른 곳에서 삭제됐어요.'
                : '다른 곳에서 저장된 프리셋이 바뀌었어요.'}{' '}
              편집 내용은 유지했어요. 사본으로 저장하거나 편집을 닫고 최신 항목을 다시 열어 주세요.
            </p>
          )}
          <fieldset className="control-grid" disabled={busy}>
            <label className="full">
              프리셋 이름
              <input
                aria-label="삽화 프리셋 이름"
                value={draft.model.title}
                maxLength={100}
                onChange={(event) => patch({ title: event.target.value })}
              />
            </label>
            <label className="full">
              설명
              <input
                aria-label="삽화 프리셋 설명"
                value={draft.model.description}
                maxLength={2000}
                onChange={(event) => patch({ description: event.target.value })}
              />
            </label>
            <label className="full">
              그림 지침
              <textarea
                aria-label="삽화 그림 지침"
                rows={5}
                maxLength={SOURCE_TEXT_MAX_CHARS}
                value={draft.model.styleGuidance}
                placeholder="예: 수채화, 부드러운 빛, 인물 중심 구성"
                onChange={(event) => patch({ styleGuidance: event.target.value })}
              />
            </label>
            <fieldset className="control-grid full">
              <legend>ComfyUI 전용</legend>
              <small className="full">
                Codex는 아래 설정을 사용하지 않아요. ComfyUI로 생성하려면 API 워크플로를 넣어
                주세요.
              </small>
              <label className="full">
                제외 지침
                <textarea
                  aria-label="ComfyUI 네거티브 프롬프트 지침"
                  rows={3}
                  maxLength={SOURCE_TEXT_MAX_CHARS}
                  value={draft.model.comfyui.negativeGuidance}
                  onChange={(event) =>
                    patch({
                      comfyui: { ...draft.model.comfyui, negativeGuidance: event.target.value },
                    })
                  }
                />
              </label>
              <label className="full">
                워크플로 JSON (API 형식)
                <textarea
                  aria-label="ComfyUI 워크플로 JSON"
                  rows={10}
                  maxLength={ILLUSTRATION_WORKFLOW_MAX_CHARS}
                  value={draft.model.comfyui.workflow}
                  placeholder="ComfyUI에서 내보낸 API 형식 JSON"
                  onChange={(event) =>
                    patch({ comfyui: { ...draft.model.comfyui, workflow: event.target.value } })
                  }
                />
              </label>
              <details className="full">
                <summary>워크플로 작성·공유 도움말</summary>
                <p>
                  문자열 입력의 {'{{prompt}}'}는 그림 설명, {'{{negative}}'}는 제외 지침,{' '}
                  {'{{seed}}'}는 시드로 바뀌어요. 모델·해상도는 워크플로에서 정해요.
                </p>
                <p>
                  상대 ComfyUI에도 같은 모델·LoRA·커스텀 노드가 필요해요. 워크플로 내용은 그대로
                  내보내므로 직접 넣은 비밀값이나 개인 경로가 없는지 확인해 주세요.
                </p>
              </details>
            </fieldset>
            <small className="full">
              저장하면 이 프리셋을 사용하는 채팅의 다음 생성부터 반영돼요. 진행 중인 작업과 기존
              삽화는 바뀌지 않아요.
            </small>
            <div className="illustration-preset-actions full">
              <button
                className="primary"
                disabled={!dirty || conflict || deleted}
                onClick={() => void save()}
              >
                <Save size={16} aria-hidden="true" /> 프리셋 저장
              </button>
              {draft.id && (
                <button onClick={() => void save(true)}>
                  <Copy size={16} aria-hidden="true" /> 사본으로 저장
                </button>
              )}
              <button
                onClick={() => {
                  if (dirty) setDiscard(true);
                  else setDraft(null);
                }}
              >
                <X size={16} aria-hidden="true" /> 편집 닫기
              </button>
            </div>
          </fieldset>
        </section>
      )}
      <Dialog
        open={discard}
        title="프리셋 편집 닫기"
        role="alertdialog"
        variant="confirmation"
        onClose={() => setDiscard(false)}
      >
        <p>저장하지 않은 편집 내용이 사라져요. 저장된 프리셋은 그대로 유지돼요.</p>
        <DraftDiscardActions
          open={discard}
          onContinue={() => setDiscard(false)}
          onDiscard={() => {
            setDraft(null);
            setDiscard(false);
            setError('');
          }}
          discardLabel="변경 버리고 닫기"
        />
      </Dialog>
      <Dialog
        open={!!deleting}
        title="삽화 프리셋 삭제"
        role="alertdialog"
        variant="confirmation"
        onClose={() => {
          if (!busy) setDeleting(null);
        }}
      >
        <p>
          ‘{deleting?.title}’ 프리셋을 삭제해요. 이 항목을 선택한 봇·채팅은 상위 설정을 따르고,
          작업실 기본이었다면 기본 프리셋으로 돌아가요. 진행 중인 작업과 기존 삽화는 유지돼요.
        </p>
        <p>대체 프리셋에 ComfyUI 워크플로가 없다면 새 생성 전에 지정해야 해요.</p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button autoFocus disabled={busy} onClick={() => setDeleting(null)}>
            취소
          </button>
          <button
            className="danger"
            disabled={busy}
            onClick={() => {
              if (deleting)
                void action(async () => {
                  await api(
                    `/illustration-presets/${encodeURIComponent(deleting.id)}`,
                    { expectedRevision: deleting.revision },
                    'DELETE'
                  );
                  if (draft?.id === deleting.id) setDraft(null);
                  setDeleting(null);
                  await refresh(true);
                  setNotice('프리셋을 삭제했어요.');
                });
            }}
          >
            프리셋 삭제
          </button>
        </div>
      </Dialog>
    </section>
  );
}
