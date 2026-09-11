import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, Square, X, Settings2 } from 'lucide-react';
import type {
  HelperConversation,
  HelperEditor,
  HelperScope,
  HelperSelection,
} from '../core/helper.js';
import { api, ApiError } from './api.js';
import { RetryFailure } from './RetryFailure.js';
import { RequestMessage } from './RequestMessage.js';
import { ActionMenu } from './ActionMenu.js';
import { ActivityBar } from './ActivityBar.js';
import { Dialog } from './Dialog.js';
import { elapsedLabel } from './ActivityStatus.js';
import { TurnStatus, type StatusTone } from './TurnStatus.js';
import { ChatComposer, ComposerInput } from './ChatComposer.js';
import { IconButton } from './IconButton.js';
import { StreamingResponse } from './StreamingResponse.js';
import { HelperArtifactCard } from './HelperArtifactCard.js';
import { useHelperConversation, type HelperTaskView } from './useHelperConversation.js';
import { interceptAppHistory } from './app-history.js';
import {
  editorContextChanged,
  flushActiveEditor,
  getActiveEditorContext,
  refreshActiveEditor,
  type ActiveEditorContext,
} from './editor-workspace-context.js';
import { useHelperSessions } from './useHelperSessions.js';
import { HelperSessionBar } from './HelperSessionBar.js';
import type { Branch } from '../core/product.js';
import './helper.css';

type Props = {
  enterSend: boolean;
  open: boolean;
  modal?: boolean;
  ready?: boolean;
  branches?: Branch[];
  onBranchNavigate?: (branchId: string) => void;
  scope: HelperScope;
  selection?: HelperSelection & { key: string; scope?: HelperScope; conversationId?: string };
  onClose: () => void;
  onModelSettings: () => void;
  /** Current global helper model, worded like the reader's main-model chip. */
  modelDescription: string;
};
type Outbox = {
  retryOf?: string;
  requestKey: string;
  text: string;
  scope: string;
  targetConversationId: string;
  editor?: HelperEditor;
  selection?: HelperSelection;
};
const active = (task: HelperTaskView) => task.status === 'queued' || task.status === 'running';
// The reader treats an explicit cancellation as a settled turn; the helper reads the same way.
const attention = (task: HelperTaskView) => ['failed', 'interrupted'].includes(task.status);
const tone = (task: HelperTaskView): StatusTone =>
  attention(task) ? 'issue' : active(task) ? 'running' : 'done';
/** Queue wait for a task that has not started; otherwise the measured execution time. */
function taskElapsed(task: HelperTaskView, now: number) {
  if (task.status === 'queued') return elapsedLabel(task.createdAt, now);
  if (!task.startedAt) return '';
  const measured = elapsedLabel(task.startedAt, active(task) ? now : Date.parse(task.updatedAt));
  // A finished task that took under a second has no meaningful duration to show.
  return !active(task) && measured === '0초' ? '' : measured;
}
const statusLabel: Record<string, string> = {
  queued: '요청을 접수했어요 · 앞선 작업을 기다려요',
  running: '처리 중이에요',
  completed: '완료했어요',
  failed: '작업에 실패했어요',
  cancelled: '작업을 취소했어요',
  interrupted: '작업이 중단됐어요',
};
function local(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function saveLocal(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    return true;
  } catch {
    /* The open panel still retains local input. */
    return false;
  }
}
function storedOutbox(scope: string): Outbox | null {
  try {
    const value = JSON.parse(local(`uimori:helper-outbox:${scope}`) ?? 'null') as Outbox | null;
    return value &&
      value.scope === scope &&
      typeof value.requestKey === 'string' &&
      typeof value.text === 'string' &&
      typeof value.targetConversationId === 'string'
      ? value
      : null;
  } catch {
    return null;
  }
}
function storedSelection(scope: string): HelperSelection | null {
  try {
    const value = JSON.parse(
      local(`uimori:helper-selection:${scope}`) ?? 'null'
    ) as HelperSelection | null;
    return value &&
      typeof value.sourceId === 'string' &&
      typeof value.sourceHash === 'string' &&
      typeof value.text === 'string'
      ? value
      : null;
  } catch {
    return null;
  }
}
const quotedSelection = (selection: HelperSelection) =>
  `원문 ${selection.sourceId}의 선택 부분:\n${selection.text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')}\n\n`;

export function HelperPanel(props: Props) {
  const sessions = useHelperSessions(props.open && props.ready !== false, props.scope);
  const scopeKey = sessions.currentId ?? '';
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  const data = useHelperConversation(props.open && props.ready !== false, sessions.currentId);
  const conversation = data.current?.conversation ?? null;
  const scope = conversation?.scope ?? props.scope;
  const branchMismatch =
    scope.kind === 'chat' &&
    (props.scope.kind !== 'chat' ||
      scope.chatId !== props.scope.chatId ||
      scope.branchId !== props.scope.branchId);
  const targetBranch =
    scope.kind === 'chat'
      ? props.branches?.find((branch) => branch.id === scope.branchId)
      : undefined;
  const messages = (data.current?.messages ?? [])
    .filter((message) => !message.latestTaskId || message.latestTaskId === message.taskId)
    .sort((a, b) =>
      a.requestOrder === undefined || b.requestOrder === undefined
        ? 0
        : a.requestOrder - b.requestOrder || (a.role === b.role ? 0 : a.role === 'user' ? -1 : 1)
    );
  const tasks = data.current?.tasks ?? [];
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const running = tasks.find((task) => task.status === 'running');
  // A stored answer owns the text; the live buffer must not repeat it under the request.
  const answered = new Set(
    (data.current?.messages ?? [])
      .filter((message) => message.role === 'assistant')
      .map((message) => message.taskId)
  );
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [outboxes, setOutboxes] = useState<Record<string, Outbox | null>>({});
  const [selections, setSelections] = useState<Record<string, HelperSelection | null>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busyScopes, setBusyScopes] = useState<Record<string, boolean>>({});
  const [editor, setEditor] = useState<ActiveEditorContext | null>(null);
  const [settings, setSettings] = useState(false);
  const [taskHistory, setTaskHistory] = useState<{ taskId?: string } | null>(null);
  const [now, setNow] = useState(Date.now);
  const [hiddenActivity, setHiddenActivity] = useState<string[]>([]);
  const [personas, setPersonas] = useState<
    Record<string, { text: string; revision: number; limits: HelperConversation['limits'] }>
  >({});
  const [savingPersona, setSavingPersona] = useState(false);
  const compact = props.modal ?? false;
  const closeButton = useRef<HTMLButtonElement>(null),
    input = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef<HTMLDivElement>(null),
    content = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, { top: number; following: boolean }>());
  const following = useRef(true),
    displayedScope = useRef('');
  const prepend = useRef<{ scope: string; height: number; top: number } | null>(null);
  const locks = useRef(new Set<string>()),
    appliedSelections = useRef(new Set<string>());
  const close = useRef(props.onClose);
  close.current = props.onClose;
  const closePanel = useRef(() => props.onClose());
  const draft = drafts[scopeKey] ?? local(`uimori:helper-input:${scopeKey}`) ?? '';
  const outbox = outboxes[scopeKey] === undefined ? storedOutbox(scopeKey) : outboxes[scopeKey];
  const selection =
    selections[scopeKey] === undefined ? storedSelection(scopeKey) : selections[scopeKey];
  const busy = busyScopes[scopeKey] ?? false;
  const error = errors[scopeKey] || data.error || sessions.error;
  const persona =
    personas[scopeKey] ??
    (conversation
      ? { text: conversation.persona, revision: conversation.revision, limits: conversation.limits }
      : { text: '', revision: 0, limits: { totalCalls: 24, helperCalls: 12, artifacts: 1 } });
  const recorded = taskHistory?.taskId
    ? tasks.filter((task) => task.id === taskHistory.taskId)
    : tasks;
  // Hiding a progress row never changes or cancels the server task behind it.
  const pending = tasks.filter(active);
  const shownPending = pending.filter((task) => !hiddenActivity.includes(task.id));
  const summarized = shownPending.find((task) => task.status === 'running') ?? shownPending[0];
  const setError = (message: string) => setErrors((old) => ({ ...old, [scopeKey]: message }));
  const editDraft = useCallback(
    (text: string) => {
      if (!scopeKey) return;
      saveLocal(`uimori:helper-input:${scopeKey}`, text);
      setDrafts((old) => ({ ...old, [scopeKey]: text }));
    },
    [scopeKey]
  );
  const setOutbox = (key: string, value: Outbox | null) => {
    const persisted = saveLocal(
      `uimori:helper-outbox:${key}`,
      value ? JSON.stringify(value) : null
    );
    if (value && !persisted)
      throw new Error('요청을 보관하지 못했어요. 브라우저 저장 공간을 확인한 뒤 다시 보내 주세요.');
    setOutboxes((old) => ({ ...old, [key]: value }));
  };
  const selectSession = sessions.select;
  useEffect(() => {
    const selected = props.selection;
    if (!selected || appliedSelections.current.has(selected.key)) return;
    const target = selected.scope;
    if (target?.kind !== 'chat') return;
    let disposed = false;
    // Resolve once from the clicked source and frozen session ID, independently of later navigation.
    const prepare = async () => {
      let owner: HelperConversation;
      try {
        owner = selected.conversationId
          ? await api<HelperConversation>(
              `/helper/conversations/${encodeURIComponent(selected.conversationId)}`
            )
          : await api<HelperConversation>('/helper/conversations', { scope: target });
      } catch (cause) {
        if (!(cause instanceof ApiError) || cause.status !== 404) throw cause;
        owner = await api<HelperConversation>('/helper/conversations', { scope: target });
      }
      if (disposed || appliedSelections.current.has(selected.key)) return;
      if (JSON.stringify(owner.scope) !== JSON.stringify(target))
        throw new Error('선택한 원문과 도우미 세션의 전개가 달라요.');
      const key = owner.id;
      appliedSelections.current.add(selected.key);
      const value: HelperSelection = {
        sourceId: selected.sourceId,
        sourceHash: selected.sourceHash,
        text: selected.text.slice(0, 20000),
      };
      setSelections((old) => ({ ...old, [key]: value }));
      saveLocal(`uimori:helper-selection:${key}`, JSON.stringify(value));
      setDrafts((old) => {
        const text = [old[key] ?? local(`uimori:helper-input:${key}`), quotedSelection(value)]
          .filter(Boolean)
          .join('\n\n');
        saveLocal(`uimori:helper-input:${key}`, text);
        return { ...old, [key]: text };
      });
      selectSession(owner);
    };
    void prepare().catch((cause) => {
      if (!disposed) setErrors((old) => ({ ...old, [currentScope.current]: cause.message }));
    });
    return () => {
      disposed = true;
    };
  }, [props.selection, selectSession]);
  useEffect(() => {
    const update = () => setEditor(getActiveEditorContext());
    update();
    addEventListener(editorContextChanged, update);
    return () => removeEventListener(editorContextChanged, update);
  }, []);
  const ticking = tasks.some(active);
  useEffect(() => {
    if (!ticking) return;
    // Same cadence as the reader's status row so both counters read the same second.
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [ticking]);
  useEffect(() => {
    if (!props.open) return;
    const prior = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    const background = [
      ...document.querySelectorAll<HTMLElement>(
        '.app-shell > .sidebar,.app-shell > .story-workspace'
      ),
    ];
    const original = background.map((node) => node.inert);
    const update = () => {
      background.forEach((node, index) => {
        node.inert = compact || original[index];
      });
    };
    update();
    const token = crypto.randomUUID(),
      base = history.state,
      url = location.href;
    let closing = false;
    history.pushState({ ...base, uimoriHelper: token }, '', url);
    const owns = () => history.state?.uimoriHelper === token;
    const remove = interceptAppHistory(() => {
      if (owns()) return true;
      close.current();
      return location.href === url;
    });
    closePanel.current = () => {
      if (closing) return;
      if (owns()) {
        closing = true;
        history.back();
      } else close.current();
    };
    return () => {
      remove();
      background.forEach((node, index) => {
        node.inert = original[index];
      });
      if (owns()) history.replaceState(base, '', url);
      if (prior?.isConnected && prior.checkVisibility()) prior.focus();
    };
  }, [props.open, compact]);
  useLayoutEffect(() => {
    const node = scroll.current;
    if (!props.open || !node || !data.current) return;
    if (displayedScope.current !== scopeKey) {
      displayedScope.current = scopeKey;
      const saved = positions.current.get(scopeKey);
      following.current = saved?.following ?? true;
      node.scrollTop = following.current ? node.scrollHeight : (saved?.top ?? 0);
    } else if (prepend.current?.scope === scopeKey) {
      node.scrollTop = prepend.current.top + node.scrollHeight - prepend.current.height;
      prepend.current = null;
    } else if (following.current) node.scrollTop = node.scrollHeight;
  }, [props.open, scopeKey, data.current]);
  useEffect(() => {
    if (!props.open || !content.current) return;
    const observer = new ResizeObserver(() => {
      if (following.current && scroll.current)
        scroll.current.scrollTop = scroll.current.scrollHeight;
    });
    observer.observe(content.current);
    return () => observer.disconnect();
  }, [props.open]);
  async function send(saved?: Outbox): Promise<boolean> {
    if (
      props.ready === false ||
      branchMismatch ||
      locks.current.has(scopeKey) ||
      (!saved && (!conversation || !draft.trim()))
    )
      return false;
    if (!saved && outbox) return false;
    const text = saved?.text ?? draft,
      owner = scopeKey;
    if (saved && (saved.scope !== owner || saved.targetConversationId !== conversation?.id))
      return false;
    locks.current.add(owner);
    setBusyScopes((old) => ({ ...old, [owner]: true }));
    setError('');
    data.setError('');
    try {
      let request = saved;
      if (!request) {
        const before = getActiveEditorContext(),
          selected = await flushActiveEditor();
        if ((before?.draftId ?? null) !== (selected?.draftId ?? null))
          throw new Error('편집 대상이 바뀌었어요. 현재 초안을 확인한 뒤 다시 보내 주세요.');
        request = {
          requestKey: crypto.randomUUID(),
          text,
          scope: owner,
          targetConversationId: conversation!.id,
          ...(selected
            ? {
                editor: {
                  draftId: selected.draftId,
                  revision: selected.revision,
                  title: selected.title,
                  kind: selected.kind,
                },
              }
            : {}),
          ...(selection ? { selection } : {}),
        };
        setOutbox(owner, request);
      }
      const task = await api<HelperTaskView>(
        `/helper/conversations/${encodeURIComponent(request.targetConversationId)}/messages`,
        {
          requestKey: request.requestKey,
          ...(request.retryOf ? { retryOf: request.retryOf } : {}),
          text: request.text,
          ...(request.editor ? { editor: request.editor } : {}),
          ...(request.selection ? { selection: request.selection } : {}),
        }
      );
      setOutbox(owner, null);
      if (!request.retryOf)
        setDrafts((old) => {
          const existing = old[owner] ?? local(`uimori:helper-input:${owner}`) ?? '';
          if (existing !== text) return old;
          saveLocal(`uimori:helper-input:${owner}`, '');
          return { ...old, [owner]: '' };
        });
      setSelections((old) => {
        const existing = old[owner] === undefined ? storedSelection(owner) : old[owner];
        if (JSON.stringify(existing ?? null) !== JSON.stringify(request.selection ?? null))
          return old;
        saveLocal(`uimori:helper-selection:${owner}`, null);
        return { ...old, [owner]: null };
      });
      data.updateTask(task);
      if (currentScope.current === owner) following.current = true;
      if (conversation) await data.refresh(conversation);
      return true;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status < 500 && ![408, 429].includes(cause.status))
        setOutbox(owner, null);
      setErrors((old) => ({
        ...old,
        [owner]: cause instanceof Error ? cause.message : '요청을 보내지 못했어요.',
      }));
      return false;
    } finally {
      locks.current.delete(owner);
      setBusyScopes((old) => ({ ...old, [owner]: false }));
    }
  }
  async function cancel(task: HelperTaskView) {
    try {
      data.updateTask(
        await api<HelperTaskView>(`/helper/tasks/${encodeURIComponent(task.id)}/cancel`, {})
      );
      if (conversation) await data.refresh(conversation);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '작업을 취소하지 못했어요.');
    }
  }
  async function retry(task: HelperTaskView, text = task.request) {
    if (
      props.ready === false ||
      branchMismatch ||
      !conversation ||
      outbox ||
      busy ||
      locks.current.has(scopeKey)
    )
      return false;
    if (task.completedEffects?.count) {
      setError('이미 저장된 변경이 있어요. 결과를 확인한 뒤 남은 작업을 새로 요청해 주세요.');
      return false;
    }
    const request: Outbox = {
      requestKey: crypto.randomUUID(),
      text,
      scope: scopeKey,
      targetConversationId: conversation.id,
      retryOf: task.id,
    };
    try {
      setOutbox(scopeKey, request);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '요청을 보관하지 못했어요.');
      return false;
    }
    return send(request);
  }
  const taskStatus = (task: HelperTaskView) => (
    <div className="helper-task" data-task-id={task.id}>
      <TurnStatus
        tone={tone(task)}
        text={statusLabel[task.status] ?? task.status}
        elapsed={taskElapsed(task, now)}
        storageKey={`helper-task-activity:${task.conversationId}:${task.id}`}
        dataProps={{ 'data-testid': 'helper-task-activity', 'data-task-id': task.id }}
      >
        <p>모델 · {task.modelTitle}</p>
        <p>
          모델 호출 {task.usage.modelCalls}회 · 입력 {task.usage.inputTokens ?? '미확인'} / 출력{' '}
          {task.usage.outputTokens ?? '미확인'} 토큰
        </p>
        {task.error && <p className="error">{task.error}</p>}
        {task.completedEffects && <p>저장한 작업 · {task.completedEffects.labels.join(' · ')}</p>}
        {active(task) && (
          <div className="form-actions">
            <button type="button" className="secondary" onClick={() => void cancel(task)}>
              {task.status === 'queued' ? '이 대기 요청 취소' : '진행 중인 도우미 작업 취소'}
            </button>
          </div>
        )}
      </TurnStatus>
      {task.status !== 'queued' && !answered.has(task.id) && (
        <div className="run-outcome">
          {task.status === 'running' && (
            <div className="turn-skeleton" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
          )}
          <StreamingResponse taskKind="helper" taskId={task.id} taskStatus={task.status} />
        </div>
      )}
      {!active(task) && task.status !== 'completed' && (
        <>
          {task.completedEffects && (
            <p role="status" data-testid="helper-completed-effects">
              변경 {task.completedEffects.count}건은 저장됐지만 응답은 완료되지 않았어요. 저장된
              결과를 확인한 뒤 남은 작업을 새로 요청해 주세요.
            </p>
          )}
          <RetryFailure
            status={task.status}
            error={task.error}
            disabled={branchMismatch || busy || Boolean(outbox)}
            onRetry={task.completedEffects ? undefined : () => void retry(task)}
            onSettings={props.onModelSettings}
            onDetails={() => setTaskHistory({ taskId: task.id })}
            onHistory={() => setTaskHistory({})}
          />
        </>
      )}
    </div>
  );
  return (
    <aside
      id="helper-panel"
      className="helper-panel"
      hidden={!props.open}
      role={compact ? 'dialog' : undefined}
      aria-modal={compact && props.open ? true : undefined}
      aria-label="도우미 패널"
      onKeyDown={(event) => {
        if (event.target instanceof Element && event.target.closest('dialog[open]')) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          closePanel.current();
        }
        if (event.key === 'Tab' && compact) {
          const nodes = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(
              'button,input,textarea,select,summary'
            ),
          ].filter((node) => !node.matches(':disabled') && node.checkVisibility());
          const first = nodes[0],
            last = nodes.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <header className="helper-header">
        <div>
          <h2>도우미</h2>
          <small>{scope.kind === 'chat' ? '이 채팅의 작품과 설정' : '서재 작업'}</small>
        </div>
        <IconButton
          label="도우미 말투 설정"
          icon={Settings2}
          onClick={() => setSettings((value) => !value)}
        />
        <button
          ref={closeButton}
          type="button"
          className="icon-button"
          aria-label="도우미 닫기"
          onClick={() => closePanel.current()}
        >
          <X size={20} />
        </button>
      </header>
      <HelperSessionBar
        sessions={sessions.sessions}
        unread={sessions.unread}
        conversation={conversation}
        currentId={sessions.currentId}
        branches={props.branches ?? []}
        creating={sessions.creating || props.ready === false}
        busy={props.ready === false || busy || Boolean(outbox)}
        onSelect={sessions.select}
        onCreate={() => void sessions.create()}
        onUpdate={(value) => {
          data.updateConversation(value);
          void sessions.reload().catch((cause) => setError(cause.message));
        }}
        onDelete={() => {
          void sessions.reload().catch((cause) => setError(cause.message));
        }}
      />
      {branchMismatch && scope.kind === 'chat' && (
        <div className="helper-branch-notice" role="status">
          <p>
            <strong>{targetBranch?.title || '다른 전개'}</strong>의 도우미 기록이에요. 새 요청과
            변경은 해당 전개로 이동한 뒤 진행해요.
          </p>
          <button
            type="button"
            className="secondary"
            onClick={() => props.onBranchNavigate?.(scope.branchId)}
          >
            해당 전개로 이동
          </button>
        </div>
      )}
      {settings && conversation && (
        <div className="helper-settings">
          <div className="helper-model">
            <button
              type="button"
              className="model-chip secondary"
              aria-label={`현재 도우미 모델 · ${props.modelDescription}`}
              title="모든 채팅의 도우미 요청에 적용되는 전역 모델 설정"
              onClick={props.onModelSettings}
            >
              <span>{props.modelDescription}</span>
            </button>
          </div>
          <label>
            도우미 말투
            <textarea
              value={persona.text}
              maxLength={2000}
              onChange={(event) =>
                setPersonas((old) => ({
                  ...old,
                  [scopeKey]: { ...persona, text: event.target.value },
                }))
              }
              placeholder="비워 두면 담백한 도우미로 응답해요."
            />
          </label>
          <details className="helper-limits">
            <summary>작업 한도</summary>
            <p>새 요청부터 적용해요.</p>
            {(
              [
                ['totalCalls', '전체 호출 한도', 2, 100],
                ['helperCalls', '도우미 판단 한도', 1, persona.limits.totalCalls],
                ['artifacts', '가정 장면 작업 한도', 1, 10],
              ] as const
            ).map(([field, label, min, max]) => (
              <label key={field}>
                {label}
                <input
                  type="number"
                  min={min}
                  max={max}
                  value={Number.isFinite(persona.limits[field]) ? persona.limits[field] : ''}
                  onChange={(event) =>
                    setPersonas((old) => ({
                      ...old,
                      [scopeKey]: {
                        ...persona,
                        limits: { ...persona.limits, [field]: event.target.valueAsNumber },
                      },
                    }))
                  }
                />
              </label>
            ))}
          </details>
          {persona.revision !== conversation.revision && (
            <p role="alert">
              도우미 설정이 바뀌었어요. 입력한 내용은 유지했어요.{' '}
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  setPersonas((old) => ({
                    ...old,
                    [scopeKey]: { ...persona, revision: conversation.revision },
                  }))
                }
              >
                최신 설정을 확인했어요
              </button>
            </p>
          )}

          <button
            type="button"
            className="secondary"
            onClick={() =>
              setPersonas((old) => ({
                ...old,
                [scopeKey]: {
                  ...persona,
                  text: '이름은 우이. 따뜻하고 가벼운 해요체로 짧게 설명해요. 작업 결과와 오류는 정확하게 말해요.',
                },
              }))
            }
          >
            우이 말투
          </button>
          <button
            type="button"
            disabled={
              props.ready === false ||
              branchMismatch ||
              savingPersona ||
              persona.revision !== conversation.revision ||
              persona.limits.totalCalls < 2 ||
              persona.limits.totalCalls > 100 ||
              persona.limits.helperCalls < 1 ||
              persona.limits.helperCalls > persona.limits.totalCalls ||
              persona.limits.artifacts < 1 ||
              persona.limits.artifacts > 10
            }
            onClick={() => {
              if (props.ready === false || branchMismatch) return;
              setSavingPersona(true);
              void api<HelperConversation>(
                `/helper/conversations/${conversation.id}`,
                {
                  expectedRevision: persona.revision,
                  persona: persona.text,
                  limits: persona.limits,
                },
                'PATCH'
              )
                .then((value) => {
                  data.updateConversation(value);
                  setPersonas((old) => ({
                    ...old,
                    [scopeKey]: {
                      text: value.persona,
                      revision: value.revision,
                      limits: value.limits,
                    },
                  }));
                })
                .catch(async (cause) => {
                  setError(cause.message);
                  if (cause instanceof ApiError && cause.status === 409) {
                    try {
                      data.updateConversation(
                        await api<HelperConversation>(`/helper/conversations/${conversation.id}`)
                      );
                    } catch {
                      /* Keep the local settings draft. */
                    }
                  }
                })
                .finally(() => setSavingPersona(false));
            }}
          >
            도우미 설정 저장
          </button>
        </div>
      )}
      <div
        ref={scroll}
        className="helper-messages"
        onScroll={() => {
          const node = scroll.current;
          if (node) {
            following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
            positions.current.set(scopeKey, { top: node.scrollTop, following: following.current });
          }
        }}
      >
        <div ref={content} className="helper-thread-content">
          {data.current?.hasOlderMessages && (
            <button
              type="button"
              className="secondary"
              disabled={data.loadingEarlier}
              onClick={() => {
                const node = scroll.current;
                if (node) {
                  prepend.current = {
                    scope: scopeKey,
                    height: node.scrollHeight,
                    top: node.scrollTop,
                  };
                  following.current = false;
                }
                void data.earlier('messages');
              }}
            >
              이전 메시지 불러오기
            </button>
          )}
          {data.loading ? (
            <p>대화를 불러오는 중…</p>
          ) : (
            messages.length === 0 && (
              <p className="helper-empty">
                작품에 대해 묻거나, 설정을 다듬거나, 가정 장면을 부탁해 보세요.
              </p>
            )
          )}
          {messages.map((message) => (
            <article
              key={message.id}
              className={`helper-message ${message.role === 'user' ? 'request' : message.role}`}
              data-message-id={message.id}
            >
              {message.role === 'user' ? (
                <RequestMessage
                  runId={message.taskId}
                  request={message.text}
                  maxLength={100000}
                  editHint="수정한 요청으로 같은 자리에서 다시 시도해요."
                  disabled={branchMismatch || busy || Boolean(outbox)}
                  onSubmit={
                    taskMap.get(message.taskId) &&
                    !active(taskMap.get(message.taskId)!) &&
                    !taskMap.get(message.taskId)!.completedEffects &&
                    taskMap.get(message.taskId)!.status !== 'completed'
                      ? (text) => retry(taskMap.get(message.taskId)!, text)
                      : undefined
                  }
                />
              ) : (
                <div className="helper-prose">{message.text}</div>
              )}
              {message.artifacts.map((artifact) => (
                <HelperArtifactCard
                  key={`${artifact.id}:${artifact.revision}`}
                  {...artifact}
                  readOnly={branchMismatch}
                  onRevise={(value) => {
                    editDraft(
                      `가정 장면 ${value.id} 개정 ${value.revision}을 다음과 같이 수정해줘: `
                    );
                    input.current?.focus();
                  }}
                />
              ))}
              {message.role === 'user' &&
                taskMap.get(message.taskId) &&
                taskMap.get(message.taskId)!.status !== 'completed' &&
                taskStatus(taskMap.get(message.taskId)!)}
            </article>
          ))}
        </div>
      </div>
      <Dialog
        open={!!taskHistory}
        title="도우미 작업 기록"
        className="helper-task-history"
        scopeKey={taskHistory?.taskId ?? 'all'}
        onClose={() => setTaskHistory(null)}
      >
        <div className="activity-notification-toolbar">
          <p>대화에는 최신 시도를 표시해요. 이전 시도와 호출 수는 여기에 남아요.</p>
          {taskHistory?.taskId && (
            <button type="button" className="secondary" onClick={() => setTaskHistory({})}>
              전체 작업 보기
            </button>
          )}
        </div>
        <ul className="activity-notification-items">
          {recorded.map((task) => (
            <li key={task.id} data-testid="helper-task-record" data-task-id={task.id}>
              <div className="activity-notification-heading">
                <div>
                  <strong>{statusLabel[task.status] ?? task.status}</strong>
                  <small>
                    <time dateTime={task.createdAt}>
                      {new Date(task.createdAt).toLocaleString()}
                    </time>{' '}
                    · 호출 {task.usage.modelCalls}회
                    {taskElapsed(task, now) && ` · ${taskElapsed(task, now)}`}
                  </small>
                </div>
              </div>
              <p>모델 · {task.modelTitle}</p>
              <p className="task-request">{task.request}</p>
              {task.error && <p className="error">{task.error}</p>}
              {task.completedEffects && (
                <p>
                  저장한 변경 {task.completedEffects.count}건 ·{' '}
                  {task.completedEffects.labels.join(' · ')}
                </p>
              )}
            </li>
          ))}
        </ul>
        {!recorded.length && <p role="status">확인할 작업이 없어요.</p>}
        {!taskHistory?.taskId && data.current?.hasOlderTasks && (
          <button
            type="button"
            className="secondary"
            disabled={data.loadingEarlier}
            onClick={() => void data.earlier('tasks')}
          >
            이전 작업 더 보기
          </button>
        )}
      </Dialog>
      <footer className="helper-composer">
        {editor && (
          <div className="helper-editor">
            <span>편집 중 · {editor.title || '이름 없는 자료'}</span>
            <button
              type="button"
              onClick={() => void refreshActiveEditor().catch((cause) => setError(cause.message))}
            >
              초안 새로고침
            </button>
          </div>
        )}
        {selection && (
          <div className="helper-selection">
            <span>선택한 원문 · {selection.text.length.toLocaleString()}자</span>
            <button
              type="button"
              onClick={() => {
                editDraft(draft.replace(quotedSelection(selection), '').trimStart());
                setSelections((old) => ({ ...old, [scopeKey]: null }));
                saveLocal(`uimori:helper-selection:${scopeKey}`, null);
              }}
            >
              선택 해제
            </button>
          </div>
        )}
        {outbox && !busy && (
          <div className="helper-outbox" role="status">
            <p>이전 요청의 접수 여부를 확인하지 못했어요. 같은 요청으로 다시 확인해요.</p>
            <button
              type="button"
              className="secondary"
              disabled={
                props.ready === false ||
                branchMismatch ||
                !conversation ||
                conversation.id !== outbox.targetConversationId
              }
              onClick={() => void send(outbox)}
            >
              접수 확인·다시 시도
            </button>
          </div>
        )}
        {pending.length > 0 && (
          <ActivityBar
            tone="running"
            issue={false}
            label={
              summarized
                ? (statusLabel[summarized.status] ?? summarized.status)
                : `진행 중인 요청 ${pending.length}개`
            }
            elapsed={summarized ? taskElapsed(summarized, now) : ''}
            extra={summarized && pending.length > 1 ? pending.length - 1 : 0}
            expanded={!!summarized}
            collapsed={!summarized}
            toggleLabel={summarized ? '작업 상태 숨기기' : '작업 상태 펼치기'}
            toggleTitle={
              summarized
                ? '상태 표시만 숨겨요. 작업은 계속 진행되고 입력도 계속할 수 있어요.'
                : '작업 상태 펼치기'
            }
            onToggle={() =>
              setHiddenActivity((old) =>
                summarized
                  ? [...new Set([...old, ...pending.map((task) => task.id)])]
                  : old.filter((id) => !pending.some((task) => task.id === id))
              )
            }
            onDetails={() => setTaskHistory({})}
            testId="helper-activity-status"
          />
        )}
        {error && (
          <div className="helper-notice" role="alert">
            <p>{error}</p>
            <div className="form-actions">
              {/모델|MODEL_REQUIRED/u.test(error) && (
                <button
                  type="button"
                  className="secondary helper-notice-lead"
                  onClick={props.onModelSettings}
                >
                  모델 설정
                </button>
              )}
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setError('');
                  data.setError('');
                  sessions.clearError();
                }}
              >
                닫기
              </button>
            </div>
          </div>
        )}
        <ChatComposer
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <ComposerInput
            inputRef={input}
            enterSend={props.enterSend}
            aria-label="도우미에게 요청"
            value={draft}
            disabled={props.ready === false || !conversation}
            placeholder="도우미에게 요청하기"
            maxLength={100000}
            onChange={(event) => editDraft(event.target.value)}
            onSend={() => void send()}
          />
          <div className="quick-controls">
            <ActionMenu label="도우미 대화 더보기" placement="top" viewport>
              <button type="button" onClick={() => setTaskHistory({})}>
                작업 기록
              </button>
            </ActionMenu>
            {running && draft.trim() && (
              <IconButton
                label="진행 중인 도우미 작업 취소"
                icon={Square}
                onClick={() => void cancel(running)}
              />
            )}
          </div>
          {running && !draft.trim() ? (
            <button
              className="send-button"
              type="button"
              aria-label="진행 중인 도우미 작업 취소"
              onClick={() => void cancel(running)}
            >
              <Square size={18} />
            </button>
          ) : (
            <button
              className="send-button"
              type="submit"
              aria-label="도우미 요청 보내기"
              disabled={
                props.ready === false ||
                branchMismatch ||
                busy ||
                data.loading ||
                !conversation ||
                !draft.trim() ||
                Boolean(outbox)
              }
            >
              <ArrowUp size={20} />
            </button>
          )}
        </ChatComposer>
      </footer>
    </aside>
  );
}
