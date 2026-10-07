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
  const [busy, setBusy] = useState(false);
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
    setBusy(true);
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
      if (alive.current) setNotice('배경 설정을 저장했어요.');
      return true;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) await state.refresh();
      if (alive.current) setError((cause as Error).message);
      return false;
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
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
    setBusy(true);
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
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="theme-dimension" aria-labelledby="theme-background-heading">
      <div className="theme-dimension-heading">
        <div>
          <h3 id="theme-background-heading">배경 이미지</h3>
          <p>레이아웃·팔레트와 별도로, 본문 상자 바깥에 표시해요. 저장하면 적용돼요.</p>
        </div>
        {scope !== 'global' && (
          <button
            disabled={disabled || busy || state.loading || !selected}
            onClick={() => void saveValue(null)}
          >
            배경 상위 설정 따르기
          </button>
        )}
      </div>
      {scope !== 'global' && !selected && (
        <p className="theme-inherited">이 범위의 배경은 상위 설정을 따라요.</p>
      )}
      {draft.imageHash && (
        <div
          className="theme-background-preview"
          aria-label="배경 이미지 미리보기"
          style={backgroundStyle(draft)}
        />
      )}
      <fieldset className="theme-background-controls" disabled={disabled || busy || state.loading}>
        <label className="settings-row theme-background-file">
          <span className="settings-row-copy">
            <strong>배경 이미지 선택</strong>
            {!draft.imageHash && <small>선택한 배경 이미지가 없어요.</small>}
          </span>
          <input
            type="file"
            aria-label="배경 이미지 선택"
            accept={PACKAGE_IMAGE_MIMES.join(',')}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void chooseFile(file);
            }}
          />
        </label>
        <div className="theme-background-sliders" role="group" aria-label="배경 효과">
          <label>
            배경 흐림 · {draft.blur}px
            <input
              aria-label="배경 흐림"
              type="range"
              min="0"
              max="30"
              value={draft.blur}
              onChange={(event) => setDraft({ ...draft, blur: Number(event.target.value) })}
            />
          </label>
          <label>
            밝은 모드 흰 덮개 · {draft.lightOverlay}%
            <input
              aria-label="밝은 모드 배경 덮개"
              type="range"
              min="0"
              max="100"
              value={draft.lightOverlay}
              onChange={(event) => setDraft({ ...draft, lightOverlay: Number(event.target.value) })}
            />
          </label>
          <label>
            어두운 모드 검은 덮개 · {draft.darkOverlay}%
            <input
              aria-label="어두운 모드 배경 덮개"
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
          label="배경 저장"
          disabled={disabled || busy || state.loading || !dirty}
          onClick={() => void saveValue(draft)}
        />
        <button
          className="theme-background-reset"
          aria-label="배경 초기화"
          title="배경 이미지와 효과 초기화"
          disabled={disabled || busy || state.loading || !draft.imageHash}
          onClick={() => setDraft({ ...defaultThemeBackground })}
        >
          <ResetIcon size={18} aria-hidden="true" /> 초기화
        </button>
        {dirty && (
          <IconButton
            label="배경 변경 취소"
            icon={CloseIcon}
            disabled={disabled || busy}
            onClick={() => {
              setDraft(selected ?? inherited);
              setBaseline(JSON.stringify(selected ?? inherited));
            }}
          />
        )}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
