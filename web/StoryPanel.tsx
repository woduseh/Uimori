import { useSettingsSaveHandler, type SettingsSaveRegistration } from './useSettingsSaveHandler.js';
import { REQUEST_TEXT_MAX_CHARS } from '../core/content-limits.js';
import { DeleteButton } from './DeleteButton.js';
import { useEffect, useRef, useState } from 'react';
import { ContextPanel } from './ContextPanel.js';
import type { StoryDetail } from '../core/story.js';
import { api, ApiError } from './api.js';
import './story.css';
type PanelProps = {
  chatId: string;
  branchId: string;
  headRevision: string | null;
  settingsRevision: number;
  profileRevision?: number;
  onChanged: () => void;
  onError: (message: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSaveHandlerChange?: SettingsSaveRegistration;
  active?: boolean;
  hideHeading?: boolean;
  refreshKey?: unknown;
};
const id = encodeURIComponent;
/** Result guards cover navigation during reads, writes, file reads, and teardown. */
function useScope(key: string) {
  const scope = useRef({ key, alive: true, generation: 0 });
  if (scope.current.key !== key) {
    scope.current.key = key;
    scope.current.generation++;
  }
  useEffect(() => {
    scope.current.alive = true;
    return () => {
      scope.current.alive = false;
    };
  }, []);
  return () => {
    const captured = scope.current.generation;
    return () => scope.current.alive && scope.current.generation === captured;
  };
}

export function StoryPanel(props: PanelProps) {
  return <StoryPanelEditor key={`${props.chatId}/${props.branchId}`} {...props} />;
}

function StoryPanelEditor({
  chatId,
  branchId,
  headRevision,
  settingsRevision,
  profileRevision,
  onChanged,
  onError,
  onDirtyChange,
  onSaveHandlerChange,
  active = true,
  hideHeading = false,
  refreshKey,
}: PanelProps) {
  const capture = useScope(
    JSON.stringify([chatId, branchId, headRevision, settingsRevision, profileRevision])
  );
  const [detail, setDetail] = useState<StoryDetail | null>(null);
  const request = useRef(0);
  const actionLock = useRef(false);
  const [busy, setBusy] = useState(false);
  // Only an in-flight write is an unsaved change; the reload after it is not.
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [contextDirty, setContextDirty] = useState(false);
  const contextSave = useRef<(() => Promise<boolean>) | null>(null);
  const registerContextSave = useRef((handler: (() => Promise<boolean>) | null) => {
    contextSave.current = handler;
  }).current;
  const [commandLabel, setCommandLabel] = useState('');
  const [commandText, setCommandText] = useState('');
  const commandKey = useRef(crypto.randomUUID());
  const runKeys = useRef(new Map<string, string>());
  const base = `/chats/${id(chatId)}`;
  const hasUnsavedChanges =
    writing || contextDirty || commandLabel.length > 0 || commandText.length > 0;
  useEffect(() => {
    onDirtyChange?.(hasUnsavedChanges);
  }, [hasUnsavedChanges, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  function report(caught: unknown) {
    const text = caught instanceof Error ? caught.message : '작업을 완료하지 못했어요.';
    setError(text);
    onError(text);
  }
  async function load() {
    const valid = capture(),
      sequence = ++request.current;
    try {
      const result = await api<StoryDetail>(`${base}/story?branchId=${id(branchId)}`);
      if (!valid() || sequence !== request.current) return;
      setDetail(result);
    } catch (caught) {
      if (valid() && sequence === request.current) report(caught);
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only scope revisions reset actions; toggling visibility must preserve drafts and pending actions.
  useEffect(() => {
    actionLock.current = false;
    setBusy(false);
    setDetail(null);
  }, [chatId, branchId, headRevision, settingsRevision, profileRevision]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reload on scope changes or reactivation; render-local load must not replace drafts on every render.
  useEffect(() => {
    if (active) void load();
  }, [active, chatId, branchId, headRevision, settingsRevision, profileRevision, refreshKey]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Pending snapshots and branch/head changes restart polling; local edits keep the existing timer.
  useEffect(() => {
    if (
      !active ||
      !detail ||
      !detail.commands.some((command) => command.status === 'pending' && command.runId)
    )
      return;
    const timer = setInterval(() => {
      void load();
    }, 1500);
    return () => clearInterval(timer);
  }, [active, detail, chatId, branchId, headRevision]);
  async function act(path: string, body: unknown = {}, success?: () => void, method = 'POST') {
    if (actionLock.current) return false;
    const valid = capture();
    actionLock.current = true;
    setBusy(true);
    setWriting(true);
    setError('');
    setMessage('');
    try {
      await api(path, body, method);
      if (!valid()) return false;
      setWriting(false);
      success?.();
      await load();
      if (valid()) {
        setMessage('반영했어요.');
        onChanged();
      }
      return valid();
    } catch (caught) {
      if (valid()) {
        report(caught);
        if (caught instanceof ApiError && caught.status === 409) await load();
      }
      return false;
    } finally {
      if (valid()) {
        actionLock.current = false;
        setBusy(false);
        setWriting(false);
      }
    }
  }
  function runCommand(commandId: string) {
    const key = runKeys.current.get(commandId) ?? crypto.randomUUID();
    runKeys.current.set(commandId, key);
    void act(
      `/scene-commands/${id(commandId)}/run`,
      {
        expectedRevision: headRevision,
        expectedSettingsRevision: settingsRevision,
        ...(profileRevision === undefined ? {} : { expectedProfileRevision: profileRevision }),
        idempotencyKey: key,
      },
      () => {
        runKeys.current.delete(commandId);
      }
    );
  }
  async function saveCommand() {
    if (!commandLabel && !commandText) return true;
    if (
      !commandLabel.trim() ||
      !commandText.trim() ||
      commandLabel.length > 120 ||
      commandText.length > REQUEST_TEXT_MAX_CHARS ||
      busy
    )
      return false;
    return act(
      `${base}/scene-commands`,
      { label: commandLabel, request: commandText, branchId, idempotencyKey: commandKey.current },
      () => {
        setCommandLabel('');
        setCommandText('');
        commandKey.current = crypto.randomUUID();
      }
    );
  }
  useSettingsSaveHandler(onSaveHandlerChange, async () => {
    if (busy || actionLock.current) return false;
    if (contextDirty && !(await contextSave.current?.())) return false;
    return saveCommand();
  });
  return (
    <section className="story-panel" aria-label="이야기 기억과 문맥">
      {!hideHeading && <h3>기억과 문맥</h3>}
      <p className="muted">
        이야기에서 일어난 일을 요약·메모로 관리해요. 카드 변수는 봇의 원본 스크립트가 관리해요.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <ContextPanel
        chatId={chatId}
        branchId={branchId}
        headRevision={headRevision}
        notes={detail?.notes}
        notesRevision={detail?.notesRevision}
        active={active}
        refreshKey={refreshKey}
        onRefreshStory={load}
        onChanged={onChanged}
        onError={onError}
        onDirtyChange={setContextDirty}
        onSaveHandlerChange={registerContextSave}
      />
      {detail && (
        <details>
          <summary>장면 예약 {detail.commands.length}개</summary>
          <p>
            이 분기에서 실행할 장면을 예약해요. 원고가 성공적으로 완성되면 사용 완료로 표시해요.
          </p>
          <ul className="story-records">
            {detail.commands.map((command) => (
              <li key={command.id}>
                <strong>{command.label}</strong> ·{' '}
                {
                  {
                    pending: '예약됨',
                    consumed: '사용 완료',
                    failed: '실패 · 재시도 가능',
                    cancelled: '취소됨',
                  }[command.status]
                }
                <p>{command.request}</p>
                {['pending', 'failed'].includes(command.status) && (
                  <div className="form-actions">
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy || Boolean(command.runId && command.status === 'pending')}
                      onClick={() => runCommand(command.id)}
                    >
                      {command.runId && command.status === 'pending'
                        ? '실행 요청됨'
                        : '이 장면 쓰기'}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => void act(`/scene-commands/${id(command.id)}/cancel`)}
                    >
                      예약 취소
                    </button>
                  </div>
                )}
                <DeleteButton
                  path={`/scene-commands/${id(command.id)}`}
                  title={command.label}
                  label="예약 삭제"
                  disabled={busy}
                  description="아직 실행하지 않은 장면 예약을 영구 삭제해요. 실행 기록에 연결된 예약은 해당 분기·채팅과 함께 삭제해야 해요."
                  onError={onError}
                  onDeleted={async () => {
                    await load();
                    onChanged();
                  }}
                />
              </li>
            ))}
          </ul>
          <form
            className="editor-grid"
            onSubmit={(event) => {
              event.preventDefault();
              void saveCommand();
            }}
          >
            <label>
              예약 이름
              <input
                required
                maxLength={120}
                value={commandLabel}
                onChange={(event) => {
                  setCommandLabel(event.target.value);
                  commandKey.current = crypto.randomUUID();
                }}
                disabled={busy}
              />
            </label>
            <label className="full">
              장면 요청
              <textarea
                required
                maxLength={REQUEST_TEXT_MAX_CHARS}
                value={commandText}
                onChange={(event) => {
                  setCommandText(event.target.value);
                  commandKey.current = crypto.randomUUID();
                }}
                disabled={busy}
              />
            </label>
            <button
              className="secondary"
              disabled={busy || !commandLabel.trim() || !commandText.trim()}
            >
              장면 예약 추가
            </button>
          </form>
        </details>
      )}
    </section>
  );
}
