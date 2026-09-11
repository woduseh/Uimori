import { RefreshIcon } from './ui-icons.js';
import { Switch } from './BooleanControls.js';
import { SaveButton } from './SaveButton.js';
import './settings-actions.css';
import { useEffect, useState } from 'react';
import type { Chat, Settings } from '../core/types.js';
import { api } from './api.js';
import { useTestMode } from './useTestMode.js';
export function SettingsEditor({
  chat,
  onSaved,
  onError,
  onDirtyChange,
  hideHeading = false,
}: {
  chat: Chat;
  onSaved: () => Promise<void>;
  onError: (e: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  hideHeading?: boolean;
}) {
  const [value, setValue] = useState<Settings>(chat.settings);
  const testMode = useTestMode();
  const [revision, setRevision] = useState(chat.settingsRevision);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [localError, setLocalError] = useState('');
  useEffect(() => {
    onDirtyChange?.(dirty || saving);
  }, [dirty, saving, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    if (!dirty && chat.settingsRevision >= revision) {
      setValue(chat.settings);
      setRevision(chat.settingsRevision);
    }
  }, [chat.settings, chat.settingsRevision, dirty, revision]);
  function update<K extends keyof Settings>(key: K, next: Settings[K]) {
    setDirty(true);
    setMessage('');
    setValue((old) => ({ ...old, [key]: next }));
  }
  return (
    <section className="settings">
      {!hideHeading && <h3>자동 후속 작업</h3>}
      <small>저장한 설정은 다음 실행부터 적용해요.</small>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setSaving(true);
          setLocalError('');
          try {
            const saved = await api<Chat>(
              `/chats/${chat.id}/settings`,
              { ...value, expectedSettingsRevision: revision },
              'PATCH'
            );
            setValue(saved.settings);
            setRevision(saved.settingsRevision);
            setDirty(false);
            setMessage('후속 작업 설정을 저장했어요.');
            onError('');
            // Persisted; the refresh below is not an unsaved draft.
            setSaving(false);
            await onSaved();
          } catch (error) {
            const text = (error as Error).message;
            setLocalError(text);
            onError(text);
          } finally {
            setSaving(false);
          }
        }}
      >
        <fieldset className="editor-fields full" disabled={saving}>
          <small className="full">한국어 번역은 각 장면의 번역 보기를 누를 때 시작해요.</small>
          <small className="full">번역은 원문 전체를 현재 번역 프롬프트와 설정으로 요청해요.</small>
          <label className="check">
            <Switch
              aria-label="장면 해설 자동 생성"
              checked={value.status}
              onChange={(event) => update('status', event.target.checked)}
            />
            장면 해설 자동 생성
          </label>
          <small className="full">
            새 원고가 완성되면 장면의 요약과 분위기를 짧게 붙여요. 읽을 때만 쓰는 설명이라 이야기
            상태나 다음 요청의 근거는 바뀌지 않아요. 꺼도 상태 정의를 사용하는 채팅의 상태 추적은
            계속돼요. 모델 경로는 역할별 모델 설정을 따라요.
          </small>
          <label className="full">
            작업당 모델 호출 한도
            <input
              type="number"
              aria-label="작업당 모델 호출 한도"
              min={1}
              max={32}
              step={1}
              required
              value={Number.isFinite(value.maxCalls) ? value.maxCalls : ''}
              onChange={(event) => update('maxCalls', event.target.valueAsNumber)}
            />
          </label>
          <small className="full">
            1~32회. 본문의 조회 후속 호출과 문맥 요약을 함께 세어요. 번역·도우미는 각 기능의 별도
            호출 한도를 사용해요.
          </small>
          {testMode && (
            <details className="full fixture-settings">
              <summary>개발자용 모의 실행 제어</summary>
              <div className="editor-grid">
                <label>
                  모의 서술 프리셋
                  <select
                    aria-label="서술 프리셋"
                    value={value.preset}
                    onChange={(event) => update('preset', event.target.value as Settings['preset'])}
                  >
                    <option value="calm">차분한 서술</option>
                    <option value="vivid">선명한 서술</option>
                  </select>
                </label>
                <label>
                  모의 생성 경로
                  <select
                    aria-label="모의 생성 경로"
                    value={value.mode}
                    onChange={(event) => update('mode', event.target.value as Settings['mode'])}
                  >
                    <option value="direct">바로 쓰기 · 도구 없음</option>
                    <option value="research">로컬 자료 조사 후 쓰기</option>
                  </select>
                </label>
                <small className="full">
                  이 값은 scripted mock 동작에 사용해요. 문체·시점·분량은 선택한 프롬프트와 창작
                  옵션에서 설정해요.
                </small>
              </div>
            </details>
          )}
          <div className="form-actions full settings-save-actions">
            {dirty && (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setValue(chat.settings);
                  setRevision(chat.settingsRevision);
                  setDirty(false);
                  setLocalError('');
                  onError('');
                }}
              >
                <RefreshIcon size={18} aria-hidden="true" />
                저장된 설정 다시 불러오기
              </button>
            )}
            <SaveButton label="설정 저장" disabled={!dirty || saving} aria-busy={saving} />
          </div>
        </fieldset>
        {message && (
          <p role="status" className="full">
            {message}
          </p>
        )}
        {localError && <p className="error full">{localError}</p>}
      </form>
    </section>
  );
}
