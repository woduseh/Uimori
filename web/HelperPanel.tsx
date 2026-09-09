import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, Square, X, Settings2, Plus } from 'lucide-react';
import type {
  HelperConversation,
  HelperEditor,
  HelperScope,
  HelperSelection,
} from '../core/helper.js';
import { api, ApiError } from './api.js';
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
import './helper.css';

type Props = {
  open: boolean;
  scope: HelperScope;
  selection?: HelperSelection & { key: string; scope?: HelperScope };
  onClose: () => void;
  onModelSettings: () => void;
};
type Outbox = {
  requestKey: string;
  text: string;
  scope: string;
  targetConversationId: string;
  editor?: HelperEditor;
  selection?: HelperSelection;
};
const active = (task: HelperTaskView) => task.status === 'queued' || task.status === 'running';
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
  const [libraryWork, setLibraryWork] = useState<string | null>(() =>
    local('uimori:helper-library-work')
  );
  const scope: HelperScope =
    props.scope.kind === 'library' && libraryWork
      ? { kind: 'library', workId: libraryWork }
      : props.scope;
  const scopeKey = JSON.stringify(scope);
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  const data = useHelperConversation(props.open, scope);
  const conversation = data.current?.conversation ?? null;
  const messages = data.current?.messages ?? [];
  const tasks = data.current?.tasks ?? [];
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const running = tasks.find((task) => task.status === 'running');
  const queued = tasks.filter((task) => task.status === 'queued');
  const [works, setWorks] = useState<(HelperConversation & { title?: string })[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [outboxes, setOutboxes] = useState<Record<string, Outbox | null>>({});
  const [selections, setSelections] = useState<Record<string, HelperSelection | null>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busyScopes, setBusyScopes] = useState<Record<string, boolean>>({});
  const [editor, setEditor] = useState<ActiveEditorContext | null>(null);
  const [settings, setSettings] = useState(false);
  const [personas, setPersonas] = useState<
    Record<string, { text: string; revision: number; limits: HelperConversation['limits'] }>
  >({});
  const [savingPersona, setSavingPersona] = useState(false);
  const [compact, setCompact] = useState(() => matchMedia('(max-width:1100px)').matches);
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
  const error = errors[scopeKey] || data.error;
  const persona =
    personas[scopeKey] ??
    (conversation
      ? { text: conversation.persona, revision: conversation.revision, limits: conversation.limits }
      : { text: '', revision: 0, limits: { totalCalls: 24, helperCalls: 12, artifacts: 1 } });
  const setError = (message: string) => setErrors((old) => ({ ...old, [scopeKey]: message }));
  const editDraft = useCallback(
    (text: string) => {
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
  useEffect(() => {
    const selected = props.selection;
    if (!selected || appliedSelections.current.has(selected.key)) return;
    const target = selected.scope ?? props.scope;
    if (target.kind !== 'chat') return;
    const key = JSON.stringify(target);
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
  }, [props.selection, props.scope]);
  useEffect(() => {
    const update = () => setEditor(getActiveEditorContext());
    update();
    addEventListener(editorContextChanged, update);
    return () => removeEventListener(editorContextChanged, update);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A newly opened server conversation must appear in the saved-work selector.
  useEffect(() => {
    if (!props.open || scope.kind !== 'library') return;
    let disposed = false;
    void api<(HelperConversation & { title?: string })[]>('/helper/conversations?kind=library')
      .then((value) => {
        if (!disposed) setWorks(value);
      })
      .catch(() => {
        /* Current work remains usable. */
      });
    return () => {
      disposed = true;
    };
  }, [props.open, scope.kind, conversation?.id]);
  useEffect(() => {
    const media = matchMedia('(max-width:1100px)'),
      update = () => setCompact(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!props.open) return;
    const prior = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    const media = matchMedia('(max-width:1100px)');
    const background = [
      ...document.querySelectorAll<HTMLElement>(
        '.app-shell > .sidebar,.app-shell > .story-workspace'
      ),
    ];
    const original = background.map((node) => node.inert);
    const update = () => {
      background.forEach((node, index) => {
        node.inert = media.matches || original[index];
      });
    };
    update();
    media.addEventListener('change', update);
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
      media.removeEventListener('change', update);
      background.forEach((node, index) => {
        node.inert = original[index];
      });
      if (owns()) history.replaceState(base, '', url);
      if (prior?.isConnected && prior.checkVisibility()) prior.focus();
    };
  }, [props.open]);
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
  async function send(saved?: Outbox) {
    if (locks.current.has(scopeKey) || (!saved && (!conversation || !draft.trim()))) return;
    if (!saved && outbox) return;
    const text = saved?.text ?? draft,
      owner = scopeKey;
    if (saved && (saved.scope !== owner || saved.targetConversationId !== conversation?.id)) return;
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
          text: request.text,
          ...(request.editor ? { editor: request.editor } : {}),
          ...(request.selection ? { selection: request.selection } : {}),
        }
      );
      setOutbox(owner, null);
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
    } catch (cause) {
      if (cause instanceof ApiError && cause.status < 500 && ![408, 429].includes(cause.status))
        setOutbox(owner, null);
      setErrors((old) => ({
        ...old,
        [owner]: cause instanceof Error ? cause.message : '요청을 보내지 못했어요.',
      }));
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
  const taskStatus = (task: HelperTaskView) => (
    <div className="helper-task" data-task-id={task.id}>
      <p role="status">
        {statusLabel[task.status]}
        {task.error ? ` · ${task.error}` : ''}
      </p>
      {task.status !== 'queued' && (
        <StreamingResponse taskKind="helper" taskId={task.id} taskStatus={task.status} />
      )}
      {task.status === 'queued' ? (
        <button type="button" className="secondary" onClick={() => void cancel(task)}>
          이 대기 요청 취소
        </button>
      ) : (
        !active(task) && (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              editDraft(task.request);
              input.current?.focus();
            }}
          >
            요청 다시 편집
          </button>
        )
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
      {scope.kind === 'library' && (
        <div className="helper-work-selector">
          <label>
            서재 작업 선택
            <select
              value={conversation?.id ?? ''}
              onChange={(event) => {
                const selected = works.find((work) => work.id === event.target.value);
                if (selected?.scope.kind === 'library') {
                  setLibraryWork(selected.scope.workId);
                  saveLocal('uimori:helper-library-work', selected.scope.workId);
                }
              }}
            >
              <option value="" disabled>
                작업을 불러오는 중…
              </option>
              {works.map((work) => (
                <option key={work.id} value={work.id}>
                  {work.title || `서재 작업 · ${new Date(work.createdAt).toLocaleString()}`}
                </option>
              ))}
            </select>
          </label>
          <IconButton
            label="새 서재 작업"
            icon={Plus}
            onClick={() => {
              const next = crypto.randomUUID();
              setLibraryWork(next);
              saveLocal('uimori:helper-library-work', next);
            }}
          />
        </div>
      )}
      {settings && conversation && (
        <div className="helper-settings">
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
                  value={persona.limits[field]}
                  onChange={(event) =>
                    setPersonas((old) => ({
                      ...old,
                      [scopeKey]: {
                        ...persona,
                        limits: { ...persona.limits, [field]: Number(event.target.value) },
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
              className={`helper-message ${message.role}`}
              data-message-id={message.id}
            >
              <strong>{message.role === 'user' ? '나' : '도우미'}</strong>
              <div className="helper-prose">{message.text}</div>
              {message.artifacts.map((artifact) => (
                <HelperArtifactCard
                  key={`${artifact.id}:${artifact.revision}`}
                  {...artifact}
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
          {tasks.length > 0 && (
            <details className="helper-task-history">
              <summary>작업 기록 · {tasks.length}개</summary>
              <ol>
                {tasks.map((task) => (
                  <li key={task.id}>
                    <strong>{task.request.slice(0, 140)}</strong>
                    <small>
                      {statusLabel[task.status]} · 호출 {task.usage.modelCalls}회
                    </small>
                    {task.status !== 'completed' && !active(task) && (
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          editDraft(task.request);
                          input.current?.focus();
                        }}
                      >
                        요청 다시 편집
                      </button>
                    )}
                  </li>
                ))}
              </ol>
              {data.current?.hasOlderTasks && (
                <button
                  type="button"
                  className="secondary"
                  disabled={data.loadingEarlier}
                  onClick={() => void data.earlier('tasks')}
                >
                  이전 작업 불러오기
                </button>
              )}
            </details>
          )}
        </div>
      </div>
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
              disabled={!conversation || conversation.id !== outbox.targetConversationId}
              onClick={() => void send(outbox)}
            >
              접수 확인·다시 시도
            </button>
          </div>
        )}
        {queued.length > 0 && (
          <p className="helper-queue" role="status">
            대기 중인 요청 {queued.length}개 · 입력은 계속할 수 있어요.
          </p>
        )}
        {error && (
          <div role="alert">
            <p>{error}</p>
            {/모델|MODEL_REQUIRED/u.test(error) && (
              <button type="button" onClick={props.onModelSettings}>
                모델 설정
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setError('');
                data.setError('');
              }}
            >
              닫기
            </button>
          </div>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <textarea
            ref={input}
            aria-label="도우미에게 요청"
            value={draft}
            placeholder="도우미에게 요청하기"
            maxLength={100000}
            rows={3}
            onChange={(event) => editDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
          />
          {running && (
            <IconButton
              label="진행 중인 도우미 작업 취소"
              icon={Square}
              onClick={() => void cancel(running)}
            />
          )}
          <button
            className="icon-button"
            type="submit"
            aria-label="도우미 요청 보내기"
            disabled={busy || data.loading || !conversation || !draft.trim() || Boolean(outbox)}
          >
            <ArrowUp size={20} />
          </button>
        </form>
      </footer>
    </aside>
  );
}
