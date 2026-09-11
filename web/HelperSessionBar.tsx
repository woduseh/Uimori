import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import type { HelperConversation, HelperConversationDeletion } from '../core/helper.js';
import type { Branch } from '../core/product.js';
import { api, ApiError } from './api.js';
import { ActionMenu } from './ActionMenu.js';
import { Dialog } from './Dialog.js';
import { IconButton } from './IconButton.js';
import { forgetHelperSession, type HelperSession } from './useHelperSessions.js';
import type { HelperTaskView } from './useHelperConversation.js';

type Props = {
  sessions: HelperSession[];
  unread: string[];
  conversation: HelperConversation | null;
  currentId: string | null;
  branches: Branch[];
  creating: boolean;
  busy: boolean;
  onSelect: (session: HelperConversation) => void;
  onCreate: () => void;
  onUpdate: (session: HelperConversation) => void;
  onDelete: () => void;
};
export function HelperSessionBar(props: Props) {
  const [rename, setRename] = useState<HelperConversation | null>(null);
  const [title, setTitle] = useState('');
  const [deleting, setDeleting] = useState<HelperConversation | null>(null);
  const [impact, setImpact] = useState<HelperConversationDeletion | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!deleting) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const value = await api<HelperConversationDeletion>(
          `/helper/conversations/${encodeURIComponent(deleting.id)}/deletion`
        );
        if (!disposed) setImpact(value);
      } catch (cause) {
        if (!disposed)
          setError(cause instanceof Error ? cause.message : '삭제 범위를 확인하지 못했어요.');
      } finally {
        if (!disposed) timer = setTimeout(() => void load(), 1200);
      }
    };
    void load();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [deleting]);
  async function stop() {
    if (!deleting || working) return;
    setWorking(true);
    setError('');
    try {
      let before: string | undefined;
      for (;;) {
        const tasks = await api<HelperTaskView[]>(
          `/helper/conversations/${encodeURIComponent(deleting.id)}/tasks${before ? `?before=${encodeURIComponent(before)}` : ''}`
        );
        for (const task of tasks.filter((item) => ['queued', 'running'].includes(item.status)))
          await api(`/helper/tasks/${encodeURIComponent(task.id)}/cancel`, {});
        if (tasks.length < 50) break;
        before = tasks.at(-1)!.id;
      }
      setImpact(
        await api<HelperConversationDeletion>(
          `/helper/conversations/${encodeURIComponent(deleting.id)}/deletion`
        )
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '작업을 중지하지 못했어요.');
    } finally {
      setWorking(false);
    }
  }
  return (
    <>
      <div className="helper-work-selector">
        <label>
          도우미 세션{props.unread.length > 0 ? ` · 새 소식 ${props.unread.length}` : ''}
          <select
            aria-label="도우미 세션 선택"
            value={props.currentId ?? ''}
            onChange={(event) => {
              const session = props.sessions.find((item) => item.id === event.target.value);
              if (session) props.onSelect(session);
            }}
          >
            <option value="" disabled>
              세션을 불러오는 중…
            </option>
            {props.sessions.map((session) => {
              const scope = session.scope;
              const branch =
                scope.kind === 'chat'
                  ? props.branches.find((item) => item.id === scope.branchId)
                  : null;
              return (
                <option key={session.id} value={session.id}>
                  {props.unread.includes(session.id) ? '● ' : ''}
                  {session.title || '새 대화'}
                  {branch ? ` · ${branch.default ? '본편' : branch.title}` : ''}
                  {session.activity?.running
                    ? ' · 진행 중'
                    : session.activity?.queued
                      ? ` · 대기 ${session.activity.queued}`
                      : ''}
                </option>
              );
            })}
          </select>
        </label>
        <IconButton
          label="새 도우미 세션"
          icon={Plus}
          disabled={props.creating}
          onClick={props.onCreate}
        />
        <ActionMenu label="도우미 세션 관리" viewport>
          <button
            type="button"
            disabled={!props.conversation || props.busy}
            onClick={() => {
              setRename(props.conversation);
              setTitle(props.conversation?.title ?? '');
              setError('');
            }}
          >
            세션 이름 변경
          </button>
          <button
            type="button"
            className="danger"
            disabled={!props.conversation || props.busy}
            onClick={() => {
              setDeleting(props.conversation);
              setImpact(null);
              setError('');
            }}
          >
            세션 삭제
          </button>
        </ActionMenu>
      </div>
      <Dialog
        open={!!rename}
        title="도우미 세션 이름 변경"
        onClose={() => {
          if (!working) setRename(null);
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!rename || working || !title.trim()) return;
            setWorking(true);
            setError('');
            void api<HelperConversation>(
              `/helper/conversations/${encodeURIComponent(rename.id)}`,
              { expectedRevision: rename.revision, title: title.trim() },
              'PATCH'
            )
              .then((value) => {
                props.onUpdate(value);
                setRename(null);
              })
              .catch(async (cause) => {
                setError(cause.message);
                if (cause instanceof ApiError && cause.status === 409) {
                  try {
                    setRename(
                      await api<HelperConversation>(
                        `/helper/conversations/${encodeURIComponent(rename.id)}`
                      )
                    );
                  } catch {
                    /* Preserve the local name. */
                  }
                }
              })
              .finally(() => setWorking(false));
          }}
        >
          <label>
            세션 이름
            <input
              value={title}
              maxLength={200}
              disabled={working}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <div className="form-actions">
            <button
              type="button"
              className="secondary"
              disabled={working}
              onClick={() => setRename(null)}
            >
              취소
            </button>
            <button className="primary" disabled={working || !title.trim()}>
              이름 저장
            </button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={!!deleting}
        title="도우미 세션 삭제"
        onClose={() => {
          if (!working) setDeleting(null);
        }}
      >
        <p>
          <strong>{deleting?.title || '새 대화'}</strong> 세션을 삭제해요.
        </p>
        <p>{impact?.description ?? '삭제할 자료와 진행 중인 작업을 확인하고 있어요…'}</p>
        {impact && !impact.canDelete && (
          <p role="status">
            진행·대기 요청 {impact.activeTasks}개 · 종료를 기다리는 외부 요청{' '}
            {impact.unsettledAttempts}개{impact.workerActive ? ' · 작업 정리 중' : ''}
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="form-actions">
          <button
            type="button"
            className="secondary"
            disabled={working}
            onClick={() => setDeleting(null)}
          >
            계속 사용
          </button>
          {impact && !impact.canDelete && (
            <button
              type="button"
              className="secondary"
              disabled={working || impact.activeTasks === 0}
              onClick={() => void stop()}
            >
              진행·대기 작업 중지
            </button>
          )}
          <button
            type="button"
            className="danger"
            disabled={working || !impact?.canDelete}
            onClick={() => {
              if (!deleting || !impact || working) return;
              setWorking(true);
              setError('');
              void api(
                `/helper/conversations/${encodeURIComponent(deleting.id)}`,
                impact.request,
                'DELETE'
              )
                .then(() => {
                  forgetHelperSession(deleting);
                  for (const prefix of ['helper-input', 'helper-outbox', 'helper-selection']) {
                    try {
                      localStorage.removeItem(`uimori:${prefix}:${deleting.id}`);
                    } catch {
                      /* The server deletion is complete. */
                    }
                  }
                  setDeleting(null);
                  props.onDelete();
                })
                .catch((cause) => setError(cause.message))
                .finally(() => setWorking(false));
            }}
          >
            세션 영구 삭제
          </button>
        </div>
      </Dialog>
    </>
  );
}
