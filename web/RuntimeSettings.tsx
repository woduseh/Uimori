import { useSettingsSaveHandler, type SettingsSaveRegistration } from './useSettingsSaveHandler.js';
import { RefreshIcon } from './ui-icons.js';
import { Switch } from './BooleanControls.js';
import { SaveButton } from './SaveButton.js';
import './settings-actions.css';
import { useEffect, useState } from 'react';
import type { Chat, Settings } from '../core/types.js';
import { api } from './api.js';
export function SettingsEditor({
  chat,
  onSaved,
  onError,
  onDirtyChange,
  onSaveHandlerChange,
  hideHeading = false,
}: {
  chat: Chat;
  onSaved: () => Promise<void>;
  onError: (e: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSaveHandlerChange?: SettingsSaveRegistration;
  hideHeading?: boolean;
}) {
  const [value, setValue] = useState<Settings>(chat.settings);
  const [revision, setRevision] = useState(chat.settingsRevision);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [localError, setLocalError] = useState('');
  useEffect(() => {
    onDirtyChange?.(dirty || saving);
  }, [dirty, saving, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useSettingsSaveHandler(onSaveHandlerChange, save);
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
  async function save() {
    if (saving) return false;
    if (!dirty) return true;
    if (!Number.isInteger(value.maxCalls) || value.maxCalls < 1 || value.maxCalls > 32) {
      setLocalError('작업당 모델 호출 한도는 1~32 사이의 정수로 입력해 주세요.');
      return false;
    }
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
      return true;
    } catch (error) {
      const text = (error as Error).message;
      setLocalError(text);
      onError(text);
      return false;
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="settings">
      {!hideHeading && <h3>자동 후속 작업</h3>}
      <small>저장한 설정은 다음 실행부터 적용해요.</small>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset className="editor-fields full chat-runtime-fields" disabled={saving}>
          <div className="settings-group full">
            <h4 className="settings-group-heading">실행 옵션</h4>
            <div className="settings-group-body">
              <label className="settings-row settings-row-toggle">
                <span className="settings-row-copy">
                  <strong>장면 해설 자동 생성</strong>
                  <small>
                    원고가 완성되면 짧은 요약과 분위기를 덧붙여요. 다음 생성의 컨텍스트에는 쓰지
                    않아요. 모델은 역할별 모델 설정을 따라요.
                  </small>
                </span>
                <span className="settings-row-control">
                  <Switch
                    aria-label="장면 해설 자동 생성"
                    checked={value.status}
                    onChange={(event) => update('status', event.target.checked)}
                  />
                </span>
              </label>
              <label className="settings-row">
                <span className="settings-row-copy">
                  <strong>작업당 모델 호출 한도</strong>
                  <small>
                    1~32회. 본문의 조회 후속 호출과 컨텍스트 요약을 함께 세어요. 번역·도우미는 각
                    기능의 별도 호출 한도를 사용해요.
                  </small>
                </span>
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
            </div>
          </div>
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
