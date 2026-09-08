import { useEffect, useState } from 'react';
import type { Run, Chat, Settings } from '../core/types.js';
import { api } from './api.js';
import { useTestMode } from './useTestMode.js';
export function RunIssue({
  run,
  refresh,
  onError,
}: {
  run: Pick<Run, 'id' | 'issue'>;
  refresh: () => Promise<void>;
  onError: (error: string) => void;
}) {
  const [note, setNote] = useState(run.issue ?? '');
  const [busy, setBusy] = useState(false);
  return (
    <details className="inspector">
      <summary>요청 충실성 기록</summary>
      <form
        className="editor-grid"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            await api(`/runs/${run.id}/issue`, { note });
            await refresh();
          } catch (error) {
            onError((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="full">
          요청 충실성 메모
          <textarea
            aria-label="요청 충실성 메모"
            rows={2}
            maxLength={2000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="전제·인물·장르가 달라진 부분을 기록해요."
          />
        </label>
        <button className="secondary" disabled={busy}>
          메모 저장
        </button>
        <small>메모는 원문을 자동 수정하거나 삭제하지 않아요.</small>
      </form>
    </details>
  );
}

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
          <label className="full">
            번역 구간 기준 글자 수
            <input
              aria-label="번역 구간 기준 글자 수"
              type="number"
              required
              min={100}
              max={24000}
              step={1}
              disabled={value.translationChunkChars === null}
              value={
                value.translationChunkChars === null ? '' : (value.translationChunkChars ?? 3000)
              }
              onChange={(event) => update('translationChunkChars', event.target.valueAsNumber)}
            />
          </label>
          <label className="check">
            <input
              aria-label="번역 구간 무제한"
              type="checkbox"
              checked={value.translationChunkChars === null}
              onChange={(event) =>
                update('translationChunkChars', event.target.checked ? null : 3000)
              }
            />
            무제한
          </label>
          <small className="full">
            문단을 보존하므로 지정한 길이를 초과할 수 있어요. 무제한은 현재 장면의 원문 전체를 한
            구간으로 번역해요. 모델의 입력·출력 한도와 timeout은 유지되며, 초과해도 자동으로
            분할하지 않아요. 재시도도 현재 모델·프롬프트·구간 기준으로 장면 전체를 다시 번역해요.
          </small>
          <label className="check">
            <input
              aria-label="장면 상태 자동 실행"
              type="checkbox"
              checked={value.status}
              onChange={(event) => update('status', event.target.checked)}
            />
            장면 상태 자동 실행
          </label>
          <small className="full">
            모델 경로는 역할별 모델 설정을 따라요. 장면 상태를 끄면 새 원고에서 상태 작업을 호출하지
            않아요.
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
          <div className="form-actions full">
            <button className="secondary" disabled={!dirty}>
              설정 저장
            </button>
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
                저장된 설정 다시 불러오기
              </button>
            )}
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
