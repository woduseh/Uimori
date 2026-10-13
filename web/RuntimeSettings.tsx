import { TransientNotice } from './TransientNotice.js';
import { NoticeBanner } from './NoticeBanner.js';
import { Dialog } from './Dialog.js';
import { DraftDiscardActions } from './DraftDiscardActions.js';
import { useSettingsSaveHandler, type SettingsSaveRegistration } from './useSettingsSaveHandler.js';
import { RefreshIcon } from './ui-icons.js';
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
  const [confirmReload, setConfirmReload] = useState(false);
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
      setMessage('실행 설정을 저장했어요.');
      onError('');
      // Persisted; the refresh below is not an unsaved draft.
      setSaving(false);
      try {
        await onSaved();
      } catch (error) {
        setLocalError(
          `실행 설정은 저장했어요. 화면을 다시 불러오지 못했어요. ${(error as Error).message}`
        );
      }
      return true;
    } catch (error) {
      const text = (error as Error).message;
      setLocalError(text);
      return false;
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="settings">
      {!hideHeading && <h3>실행 옵션</h3>}
      <small>저장한 설정은 다음 실행부터 적용해요.</small>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset className="editor-fields full chat-runtime-fields" disabled={saving}>
          <div className="settings-group full">
            <h4 className="settings-group-heading">모델 호출</h4>
            <div className="settings-group-body">
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
          <div className="settings-group full">
            <h4 className="settings-group-heading">본문 번역</h4>
            <div className="settings-group-body">
              <label className="settings-row">
                <span className="settings-row-copy">
                  <strong>본문 생성 후 자동 번역</strong>
                  <small>
                    본문을 저장하면 현재 번역 모델로 자동 번역해요. 원문은 먼저 읽을 수 있고, 번역
                    실패 시 원문은 그대로 유지돼요. Codex에서 콘텐츠 확인이 필요한 경우 직접 번역을
                    시작해야 해요.
                  </small>
                </span>
                <input
                  type="checkbox"
                  aria-label="본문 생성 후 자동 번역"
                  checked={value.autoTranslate === true}
                  onChange={(event) => update('autoTranslate', event.target.checked)}
                />
              </label>
            </div>
          </div>
          <div className="form-actions full settings-save-actions">
            {dirty && (
              <button type="button" className="secondary" onClick={() => setConfirmReload(true)}>
                <RefreshIcon size={18} aria-hidden="true" />
                저장된 설정 다시 불러오기
              </button>
            )}
            <SaveButton label="설정 저장" disabled={!dirty || saving} aria-busy={saving} />
          </div>
        </fieldset>
        <TransientNotice message={message} />
        {localError && (
          <NoticeBanner tone="error" className="full">
            {localError}
          </NoticeBanner>
        )}
      </form>
      <Dialog
        open={confirmReload}
        title="실행 설정 다시 불러오기"
        variant="confirmation"
        role="alertdialog"
        onClose={() => {
          if (!saving) setConfirmReload(false);
        }}
      >
        <p>저장된 실행 설정을 불러오면 현재 초안이 사라져요.</p>
        <DraftDiscardActions
          open={confirmReload}
          disabled={saving}
          onContinue={() => setConfirmReload(false)}
          onDiscard={() => {
            setValue(chat.settings);
            setRevision(chat.settingsRevision);
            setDirty(false);
            setLocalError('');
            setMessage('');
            onError('');
            setConfirmReload(false);
          }}
          discardLabel="초안 버리고 불러오기"
        />
      </Dialog>
    </section>
  );
}
