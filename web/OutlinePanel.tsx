import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  FileText,
  GitBranch,
  ListTree,
  Plus,
  Sparkles,
  PenLine,
  ScanText,
  Link2,
  X,
  Pin,
  Trash2,
  ArrowUp,
  ArrowDown,
  RefreshCw,
} from 'lucide-react';
import { api, ApiError } from './api.js';
import { ActionMenu } from './ActionMenu.js';
import { IconButton } from './IconButton.js';
import { DismissibleError } from './DismissibleError.js';
import { Prose } from './Prose.js';
import { OUTLINE_REFRESH_EVENT, type OutlineHelperRequest } from './outline-helper.js';
import {
  OUTLINE_LEVELS,
  OUTLINE_LEVEL_LABELS,
  OUTLINE_GUIDANCE,
  OUTLINE_INTENT_MAX,
  OUTLINE_TITLE_MAX,
  outlineParentAllowed,
  outlineWritable,
  type OutlineDetail,
  type OutlineLevel,
  type OutlineNode,
  type OutlineSnapshot,
} from '../core/outline.js';
import type { StoryState } from './useStory.js';
import type { Run } from '../core/types.js';
import type { SceneCommand } from '../core/story.js';
import './outline.css';

type Draft = {
  title: string;
  intent: string;
  revision?: number;
  level: OutlineLevel;
  parentId: string | null;
  relatedIds: string[];
  fixed: boolean;
};
type Brief = { expectedRevision: number; planHash: string; outline: OutlineSnapshot };
type Pending =
  | { kind: 'apply'; body: { branchId?: string; idempotencyKey: string; operations: unknown[] } }
  | {
      kind: 'write';
      nodeId: string;
      commandKey: string;
      commandId?: string;
      commandRequest: { request: string; expectedRevision: number; expectedPlanHash: string };
      body: {
        expectedRevision: string | null;
        expectedSettingsRevision: number;
        expectedProfileRevision?: number;
        idempotencyKey: string;
      };
    };
function stored<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? 'null') ?? fallback;
  } catch {
    return fallback;
  }
}
function retain(key: string, value: unknown) {
  if (value === null) sessionStorage.removeItem(key);
  else sessionStorage.setItem(key, JSON.stringify(value));
}
const fromNode = (node: OutlineNode): Draft => ({
  title: node.title,
  intent: node.intent,
  revision: node.revision,
  level: node.level,
  parentId: node.parentId,
  relatedIds: node.relatedIds ?? [],
  fixed: node.fixed,
});
const rejected = (error: unknown) =>
  error instanceof ApiError &&
  error.status >= 400 &&
  error.status < 500 &&
  ![408, 429].includes(error.status);

export function OutlinePanel({
  state,
  onClose,
  onHelp,
  helperVisible,
  onToggleHelper,
}: {
  state: StoryState;
  onClose: () => void;
  onHelp: (request: OutlineHelperRequest) => void;
  helperVisible: boolean;
  onToggleHelper: () => void;
}) {
  const chatId = state.detail?.chat.id ?? '',
    branchId = state.branch?.id;
  const prefix = `outline-workspace:${chatId}:${branchId ?? 'main'}`;
  const pendingKey = `outline-pending:${chatId}:${branchId ?? 'main'}`;
  const [outline, setOutline] = useState<OutlineDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    stored(`${prefix}:selected`, null)
  );
  const [folded, setFolded] = useState<string[]>(() => stored(`${prefix}:folded`, []));
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(() => stored(pendingKey, null));
  const [error, setError] = useState('');
  const [brief, setBrief] = useState<Brief | null>(null);
  const [writing, setWriting] = useState(false);
  const [requestText, setRequestText] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const mounted = useRef(true),
    sending = useRef(false),
    loadGeneration = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const detailScroll = useRef<HTMLDivElement>(null);
  const nodes = outline?.nodes ?? [];
  const selected = nodes.find((node) => node.id === selectedId) ?? null;
  const briefGeneration = useRef(0);
  const currentSelection = useRef(selectedId);
  currentSelection.current = selectedId;
  const disabled = busy || !!pending;
  const draftKey = adding ? `${prefix}:new` : `${prefix}:draft:${selectedId}`;
  const load = useCallback(async () => {
    if (!chatId) return;
    const generation = ++loadGeneration.current;
    try {
      const value = await api<OutlineDetail>(
        `/chats/${chatId}/outline${branchId ? `?branchId=${encodeURIComponent(branchId)}` : ''}`
      );
      if (mounted.current && generation === loadGeneration.current) setOutline(value);
    } catch (cause) {
      if (mounted.current && generation === loadGeneration.current)
        setError((cause as Error).message);
    }
  }, [chatId, branchId]);
  useEffect(() => {
    mounted.current = true;
    void load();
    heading.current?.focus();
    const refresh = () => void load();
    addEventListener(OUTLINE_REFRESH_EVENT, refresh);
    addEventListener('focus', refresh);
    return () => {
      mounted.current = false;
      loadGeneration.current++;
      removeEventListener(OUTLINE_REFRESH_EVENT, refresh);
      removeEventListener('focus', refresh);
    };
  }, [load]);
  // Source edits and completed writer runs update the existing reader cursor.
  const cursor = state.detail?.reader.cursor;
  useEffect(() => {
    if (cursor !== undefined) void load();
  }, [cursor, load]);
  useEffect(() => {
    if (!outline || (selectedId && outline.nodes.some((node) => node.id === selectedId))) return;
    setSelectedId(
      outline.nodes.find((node) => outlineWritable(node.level))?.id ?? outline.nodes[0]?.id ?? null
    );
  }, [outline, selectedId]);
  useEffect(() => {
    if (!adding && !editing && !helperVisible) heading.current?.focus({ preventScroll: true });
  }, [adding, editing, helperVisible]);
  function choose(id: string) {
    briefGeneration.current++;
    setSelectedId(id);
    try {
      retain(`${prefix}:selected`, id);
    } catch {
      /* Selection stays in memory. */
    }
    setEditing(false);
    setAdding(false);
    setDraft(null);
    setWriting(false);
    setPreviewing(false);
    setBrief(null);
    setError('');
    detailScroll.current?.scrollTo({ top: 0 });
  }
  function changeDraft(next: Draft) {
    setDraft(next);
    try {
      retain(draftKey, next);
    } catch {
      setError('초안은 이 화면에 유지돼요. 브라우저 저장 공간을 확인해 주세요.');
    }
  }
  function edit() {
    if (!selected) return;
    briefGeneration.current++;
    setDraft(stored(`${prefix}:draft:${selected.id}`, fromNode(selected)));
    setAdding(false);
    setEditing(true);
    setWriting(false);
  }
  function add(parent: OutlineNode | null = null) {
    briefGeneration.current++;
    const level = parent ? OUTLINE_LEVELS[OUTLINE_LEVELS.indexOf(parent.level) + 1] : 'episode';
    if (!level) return;
    setDraft(
      stored(`${prefix}:new`, {
        title: '',
        intent: '',
        level,
        parentId: parent?.id ?? null,
        relatedIds: [],
        fixed: false,
      } satisfies Draft)
    );
    setAdding(true);
    setEditing(false);
    setWriting(false);
    setError('');
  }
  function remember(value: Pending | null, key: string, initial = false) {
    const existing = stored<Pending | null>(pendingKey, null);
    if (existing ? existing.body.idempotencyKey !== key : !initial) return false;
    retain(pendingKey, value);
    if (mounted.current) setPending(value);
    return true;
  }
  async function send(operation: Pending) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError('');
    try {
      const saved = stored<Pending | null>(pendingKey, null);
      if (saved?.body.idempotencyKey === operation.body.idempotencyKey) operation = saved;
      if (!remember(operation, operation.body.idempotencyKey, true)) return;
      if (operation.kind === 'apply') {
        const result = await api<{ detail: OutlineDetail; created: { id: string }[] }>(
          `/chats/${chatId}/outline`,
          operation.body
        );
        if (
          stored<Pending | null>(pendingKey, null)?.body.idempotencyKey !==
          operation.body.idempotencyKey
        )
          return;
        if (mounted.current) {
          ++loadGeneration.current;
          setOutline(result.detail);
          const edits = operation.body.operations as {
            op: string;
            id?: string;
            title?: string;
            intent?: string;
          }[];
          for (const item of edits)
            if (
              item.id &&
              (item.title !== undefined || item.intent !== undefined || item.op === 'remove')
            )
              retain(`${prefix}:draft:${item.id}`, null);
          if (result.created.length) {
            retain(`${prefix}:new`, null);
            choose(result.created[0].id);
          } else {
            setEditing(false);
            setAdding(false);
            setDraft(null);
            setBrief(null);
          }
        }
      } else {
        if (!operation.commandId) {
          const command = await api<SceneCommand>(
            `/outline-nodes/${operation.nodeId}/scene-command`,
            { idempotencyKey: operation.commandKey, ...operation.commandRequest }
          );
          operation = { ...operation, commandId: command.id };
          if (!remember(operation, operation.body.idempotencyKey)) return;
        }
        await api<Run>(`/scene-commands/${operation.commandId}/run`, operation.body);
      }
      if (!remember(null, operation.body.idempotencyKey)) return;
      if (operation.kind === 'write' && mounted.current) {
        retain(`${prefix}:request:${operation.nodeId}`, null);
        await state.refresh(chatId);
        if (mounted.current) onClose();
      }
    } catch (cause) {
      if (rejected(cause)) {
        remember(null, operation.body.idempotencyKey);
        if (mounted.current) await load();
      }
      if (mounted.current) setError((cause as Error).message);
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const apply = (operations: unknown[]) => {
    if (disabled) return;
    void send({
      kind: 'apply',
      body: { branchId, idempotencyKey: crypto.randomUUID(), operations },
    });
  };
  async function prepareWriting(previewOnly = false) {
    if (!selected) return;
    setError('');
    const generation = ++briefGeneration.current;
    try {
      const next = await api<Brief>(`/outline-nodes/${selected.id}/brief`);
      if (
        !mounted.current ||
        currentSelection.current !== selected.id ||
        generation !== briefGeneration.current
      )
        return;
      setBrief(next);
      setPreviewing(previewOnly);
      setWriting(!previewOnly);
      setEditing(false);
      setAdding(false);
      const defaultRequest = `${OUTLINE_LEVEL_LABELS[selected.level]} ${next.outline.sources?.length ? '이어 쓰기' : '집필'}: ${selected.title}\n${selected.intent}`;
      setRequestText(stored(`${prefix}:request:${selected.id}`, defaultRequest));
    } catch (cause) {
      if (mounted.current) setError((cause as Error).message);
    }
  }
  function writeUnit() {
    if (!selected || !brief || !state.detail || disabled || !requestText.trim()) return;
    void send({
      kind: 'write',
      nodeId: selected.id,
      commandKey: crypto.randomUUID(),
      commandRequest: {
        request: requestText,
        expectedRevision: brief.expectedRevision,
        expectedPlanHash: brief.planHash,
      },
      body: {
        expectedRevision: state.branch?.headRevision ?? state.detail.chat.headRevision,
        expectedSettingsRevision: state.detail.chat.settingsRevision,
        ...(state.detail.profile ? { expectedProfileRevision: state.detail.profile.revision } : {}),
        idempotencyKey: crypto.randomUUID(),
      },
    });
  }
  function moveSelected(direction: -1 | 1) {
    if (!selected) return;
    const siblings = nodes.filter((node) => node.parentId === selected.parentId);
    const index = siblings.findIndex((node) => node.id === selected.id),
      next = index + direction;
    if (next < 0 || next >= siblings.length) return;
    [siblings[index], siblings[next]] = [siblings[next], siblings[index]];
    apply(
      siblings.flatMap((node, position) =>
        position === node.position
          ? []
          : [{ op: 'move', id: node.id, expectedRevision: node.revision, position }]
      )
    );
  }
  function help(purpose: 'compose' | 'review', node: OutlineNode | null = selected) {
    if (!branchId) return;
    onHelp({
      key: crypto.randomUUID(),
      scope: { kind: 'chat', chatId, branchId },
      target: { nodeId: node?.id ?? null, expectedRevision: node?.revision ?? null, purpose },
      title: node?.title ?? '새 이야기 구성',
      text:
        purpose === 'review'
          ? '선택한 현재 구성과 연결된 원문을 비교해 주세요. 반영된 내용, 근거가 약한 부분, 차이와 수정 방향을 원문 근거로 알려 주세요. 아직 수정하지 마세요.'
          : node
            ? '선택한 구성의 방향과 유지할 조건을 보존하면서 필요한 하위 사건을 상세화해 주세요. 기존 원문은 바꾸지 말고 구성만 저장해 주세요.'
            : '이 채팅의 작품과 현재 요청에 맞게 구성을 시작해 주세요. 먼 부분은 큰 방향을 정하고 가까운 회차부터 상세화해 주세요. 본문은 아직 쓰지 마세요.',
    });
  }
  function tree(parentId: string | null, depth = 0): React.ReactNode {
    return (
      <ul className={depth ? 'outline-children' : 'outline-tree'}>
        {nodes
          .filter((node) => node.parentId === parentId)
          .map((node) => {
            const children = nodes.some((item) => item.parentId === node.id),
              collapsed = folded.includes(node.id);
            return (
              <li
                key={node.id}
                className={`outline-entry ${selectedId === node.id ? 'is-selected' : ''}`}
                data-node-id={node.id}
              >
                <div className="outline-row">
                  {children ? (
                    <button
                      type="button"
                      className="outline-fold"
                      aria-label={`${node.title} ${collapsed ? '펼치기' : '접기'}`}
                      aria-expanded={!collapsed}
                      onClick={() => {
                        const next = collapsed
                          ? folded.filter((id) => id !== node.id)
                          : [...folded, node.id];
                        setFolded(next);
                        try {
                          retain(`${prefix}:folded`, next);
                        } catch {
                          /* Folding stays in memory. */
                        }
                      }}
                    >
                      {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    </button>
                  ) : (
                    <span className="outline-leaf" />
                  )}
                  <button
                    type="button"
                    className="outline-node-button"
                    aria-current={selectedId === node.id ? 'true' : undefined}
                    onClick={() => choose(node.id)}
                  >
                    <span className="outline-node-kind">{OUTLINE_LEVEL_LABELS[node.level]}</span>
                    <span className="outline-title">{node.title}</span>
                    <span className="outline-node-mark">
                      {node.fixed && <Pin size={12} aria-label="유지할 조건" />}
                      {!!node.writings?.length && <FileText size={12} aria-label="원문 있음" />}
                    </span>
                  </button>
                </div>
                {children && !collapsed && tree(node.id, depth + 1)}
              </li>
            );
          })}
      </ul>
    );
  }
  const ownSources = selected?.writings ?? [];
  const descendants = (id: string): OutlineNode[] =>
    nodes.filter((node) => node.parentId === id).flatMap((node) => [node, ...descendants(node.id)]);
  const lower = selected ? descendants(selected.id) : [];
  const sources = [
    ...new Map(
      [...(selected ? [selected] : []), ...lower]
        .flatMap((node) => node.writings ?? [])
        .map((source) => [source.sourceRevision, source])
    ).values(),
  ];
  const review = selected?.latestReview;
  return (
    <section className="outline-panel" aria-label="계층형 구성">
      <header className="outline-workspace-header">
        <div className="outline-workspace-title">
          <ListTree size={21} />
          <div>
            <h2 ref={heading} tabIndex={-1}>
              구성·집필
            </h2>
            <p>{state.detail?.chat.title}</p>
          </div>
        </div>
        <div className="outline-header-actions">
          <button
            type="button"
            className={`secondary outline-helper-toggle ${helperVisible ? 'is-active' : ''}`}
            onClick={onToggleHelper}
          >
            <Sparkles size={16} />
            도우미
          </button>
          <IconButton label="계층형 구성 닫기" icon={X} onClick={onClose} />
        </div>
      </header>
      <DismissibleError message={error} onDismiss={() => setError('')} />
      {pending && !busy && (
        <div className="outline-pending" role="status">
          <p>접수 결과를 아직 확인하지 못했어요. 입력은 보관했어요.</p>
          <button type="button" onClick={() => void send(pending)}>
            요청 결과 확인
          </button>
        </div>
      )}
      {!outline && (
        <p className="outline-loading" role="status">
          구성을 불러오는 중이에요…{' '}
          {error && (
            <button type="button" onClick={() => void load()}>
              다시 불러오기
            </button>
          )}
        </p>
      )}
      {outline && !nodes.length && !adding ? (
        <div className="outline-welcome">
          <div className="outline-welcome-symbol">
            <GitBranch size={32} />
          </div>
          <p className="outline-eyebrow">이야기의 다음 방향</p>
          <h3>작은 장면에서 시작해도 좋아요.</h3>
          <p>
            작품 전체를 설계하거나, 이번 회차만 가볍게 정해요.
            <br />
            구성은 계획으로 남고, 선택한 단위만 집필해요.
          </p>
          <div className="outline-welcome-actions">
            <button type="button" onClick={() => help('compose', null)}>
              <Sparkles size={18} />
              도우미와 구성 시작
            </button>
            <button type="button" className="secondary" onClick={() => add()}>
              <Plus size={18} />
              직접 추가
            </button>
          </div>
          <div className="outline-example">
            <span>예를 들면</span>
            <p>“전체 12화의 역할을 정하고, 1화만 작은 사건까지 상세하게 구성해줘.”</p>
          </div>
        </div>
      ) : (
        outline && (
          <div className="outline-workspace-body">
            <nav className="outline-navigation" aria-label="구성 목록">
              <div className="outline-navigation-head">
                <span>
                  이야기 구성 <small>{nodes.length}</small>
                </span>
                <IconButton
                  label="구성 추가"
                  icon={Plus}
                  disabled={disabled}
                  onClick={() => add()}
                />
              </div>
              <div className="outline-tree-scroll">{tree(null)}</div>
              <p className="outline-navigation-foot">단계는 필요한 만큼만 사용해요.</p>
            </nav>
            <div className="outline-detail" ref={detailScroll}>
              <div className="outline-mobile-select">
                <label>
                  현재 구성
                  <select value={selectedId ?? ''} onChange={(event) => choose(event.target.value)}>
                    <option value="" disabled>
                      구성 선택
                    </option>
                    {nodes.map((node) => (
                      <option key={node.id} value={node.id}>
                        {OUTLINE_LEVEL_LABELS[node.level]} · {node.title}
                      </option>
                    ))}
                  </select>
                </label>
                <IconButton
                  label="구성 추가"
                  icon={Plus}
                  disabled={disabled}
                  onClick={() => add()}
                />
              </div>
              {(adding || editing) && draft ? (
                <form
                  className="outline-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!draft.title.trim()) return;
                    apply([
                      adding
                        ? {
                            op: 'create',
                            level: draft.level,
                            parentId: draft.parentId,
                            title: draft.title,
                            intent: draft.intent,
                            relatedIds: draft.relatedIds,
                          }
                        : {
                            op: 'update',
                            id: selectedId,
                            expectedRevision: draft.revision,
                            title: draft.title,
                            intent: draft.intent,
                            relatedIds: draft.relatedIds,
                            fixed: draft.fixed,
                          },
                    ]);
                  }}
                >
                  <div className="outline-section-heading">
                    <span className="outline-eyebrow">{adding ? '새로운 구성' : '구성 편집'}</span>
                    <h3>{adding ? '어디에서 시작할까요?' : selected?.title}</h3>
                  </div>
                  {adding && (
                    <div className="outline-form-pair">
                      <label>
                        수준
                        <select
                          disabled={disabled}
                          value={draft.level}
                          onChange={(event) =>
                            changeDraft({ ...draft, level: event.target.value as OutlineLevel })
                          }
                        >
                          {OUTLINE_LEVELS.filter((level) =>
                            outlineParentAllowed(
                              nodes.find((node) => node.id === draft.parentId)?.level ?? null,
                              level
                            )
                          ).map((level) => (
                            <option key={level} value={level}>
                              {OUTLINE_LEVEL_LABELS[level]}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        상위 구성
                        <select
                          disabled={disabled}
                          value={draft.parentId ?? ''}
                          onChange={(event) => {
                            const parent = nodes.find((node) => node.id === event.target.value);
                            changeDraft({
                              ...draft,
                              parentId: parent?.id ?? null,
                              level: outlineParentAllowed(parent?.level ?? null, draft.level)
                                ? draft.level
                                : OUTLINE_LEVELS[OUTLINE_LEVELS.indexOf(parent!.level) + 1],
                            });
                          }}
                        >
                          <option value="">없음 · 독립 구성</option>
                          {nodes
                            .filter((node) => node.level !== 'beat')
                            .map((node) => (
                              <option key={node.id} value={node.id}>
                                {node.title}
                              </option>
                            ))}
                        </select>
                      </label>
                    </div>
                  )}
                  <label>
                    이름
                    <input
                      autoComplete="off"
                      required
                      maxLength={OUTLINE_TITLE_MAX}
                      value={draft.title}
                      disabled={disabled}
                      onChange={(event) => changeDraft({ ...draft, title: event.target.value })}
                    />
                  </label>
                  <label>
                    구성 내용
                    <textarea
                      rows={9}
                      maxLength={OUTLINE_INTENT_MAX}
                      value={draft.intent}
                      disabled={disabled}
                      placeholder={OUTLINE_GUIDANCE[draft.level]}
                      onChange={(event) => changeDraft({ ...draft, intent: event.target.value })}
                    />
                  </label>
                  <p className="muted outline-field-help">
                    {OUTLINE_GUIDANCE[draft.level]} 모두 채울 필요는 없어요.
                  </p>
                  <details className="outline-reference-picker">
                    <summary>
                      <Link2 size={15} />
                      함께 참고할 구성 <small>{draft.relatedIds.length}</small>
                    </summary>
                    <p>다른 회차의 준비·회수 등 관련된 계획만 연결해요.</p>
                    {nodes
                      .filter((node) => node.id !== selectedId || adding)
                      .map((node) => (
                        <label key={node.id}>
                          <input
                            type="checkbox"
                            disabled={disabled}
                            checked={draft.relatedIds.includes(node.id)}
                            onChange={(event) =>
                              changeDraft({
                                ...draft,
                                relatedIds: event.target.checked
                                  ? [...draft.relatedIds, node.id]
                                  : draft.relatedIds.filter((id) => id !== node.id),
                              })
                            }
                          />
                          <span>
                            {node.title}
                            <small>{OUTLINE_LEVEL_LABELS[node.level]}</small>
                          </span>
                        </label>
                      ))}
                  </details>
                  {!adding && (
                    <label className="outline-keep">
                      <input
                        type="checkbox"
                        checked={draft.fixed}
                        disabled={disabled}
                        onChange={(event) => changeDraft({ ...draft, fixed: event.target.checked })}
                      />
                      <span>
                        유지할 조건
                        <small>
                          일반 상세화에서는 보존해요. 명확한 변경 요청으로 바꿀 수 있어요.
                        </small>
                      </span>
                    </label>
                  )}
                  {editing && selected && draft.revision !== selected.revision && (
                    <div className="outline-conflict" role="status">
                      <p>다른 곳에서 구성이 변경됐어요. 내 초안은 그대로 보관했어요.</p>
                      <details>
                        <summary>현재 저장된 구성 보기</summary>
                        <p>{selected.intent}</p>
                      </details>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => changeDraft(fromNode(selected))}
                      >
                        최신 내용 불러오기
                      </button>
                    </div>
                  )}
                  <div className="outline-form-actions">
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => {
                        setAdding(false);
                        setEditing(false);
                        setDraft(null);
                      }}
                    >
                      닫기 · 초안 보관
                    </button>
                    <button type="submit" disabled={disabled || !draft.title.trim()}>
                      {' '}
                      {adding ? '추가' : '저장'}
                    </button>
                  </div>
                </form>
              ) : selected ? (
                <>
                  <div className="outline-detail-heading">
                    <div>
                      <span className="outline-eyebrow">
                        {OUTLINE_LEVEL_LABELS[selected.level]}
                      </span>
                      <h3>{selected.title}</h3>
                    </div>
                    <ActionMenu label="구성 관리">
                      <button type="button" disabled={disabled} onClick={edit}>
                        <PenLine size={16} />
                        구성 수정
                      </button>
                      {selected.level !== 'beat' && (
                        <button type="button" disabled={disabled} onClick={() => add(selected)}>
                          <Plus size={16} />
                          하위 구성 추가
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() =>
                          apply([
                            {
                              op: 'update',
                              id: selected.id,
                              expectedRevision: selected.revision,
                              fixed: !selected.fixed,
                            },
                          ])
                        }
                      >
                        <Pin size={16} />
                        {selected.fixed ? '유지 조건 해제' : '유지할 조건으로 지정'}
                      </button>
                      <button type="button" disabled={disabled} onClick={() => moveSelected(-1)}>
                        <ArrowUp size={16} />
                        위로 이동
                      </button>
                      <button type="button" disabled={disabled} onClick={() => moveSelected(1)}>
                        <ArrowDown size={16} />
                        아래로 이동
                      </button>
                      <button
                        type="button"
                        disabled={disabled || sources.length > 0}
                        onClick={() =>
                          apply([
                            { op: 'remove', id: selected.id, expectedRevision: selected.revision },
                          ])
                        }
                      >
                        <Trash2 size={16} />
                        구성 삭제
                      </button>
                    </ActionMenu>
                  </div>
                  <div className="outline-status-line">
                    {selected.fixed && (
                      <span>
                        <Pin size={13} />
                        유지할 조건
                      </span>
                    )}
                    <span>
                      <FileText size={13} />
                      {ownSources.length
                        ? `원문 ${ownSources.length}개 연결`
                        : selected.progress.state === 'writing'
                          ? '집필 중'
                          : selected.progress.state === 'scheduled'
                            ? '집필 예약'
                            : '아직 원문이 없어요'}
                    </span>
                    {lower.length > 0 && (
                      <span>
                        하위 {lower.length}개 중{' '}
                        {lower.filter((node) => node.writings?.length).length}개에 원문 연결
                      </span>
                    )}
                  </div>
                  <div className="outline-primary-actions">
                    <button
                      type="button"
                      className="secondary"
                      disabled={disabled}
                      onClick={() => help('compose')}
                    >
                      <Sparkles size={17} />
                      상세화
                    </button>
                    {outlineWritable(selected.level) && (
                      <button
                        type="button"
                        disabled={disabled || !!state.active}
                        onClick={() => void prepareWriting()}
                      >
                        <PenLine size={17} />
                        {sources.length ? '이어 쓰기' : '이 단위 집필'}
                      </button>
                    )}
                    <button
                      type="button"
                      className="secondary"
                      disabled={disabled || !sources.length}
                      onClick={() => help('review')}
                    >
                      <ScanText size={17} />
                      원문과 점검
                    </button>
                  </div>
                  <article className="outline-intent-card">
                    <div className="outline-card-heading">
                      <span>구성 내용</span>
                      <button
                        type="button"
                        className="text-button"
                        disabled={disabled}
                        onClick={edit}
                      >
                        편집
                      </button>
                    </div>
                    {selected.intent ? (
                      <Prose text={selected.intent} />
                    ) : (
                      <p className="muted">
                        아직 비어 있어요. 도우미에게 상세화를 요청하거나 직접 적어 보세요.
                      </p>
                    )}
                  </article>
                  {!!selected.relatedIds?.length && (
                    <div className="outline-related-list">
                      <span>
                        <Link2 size={15} />
                        함께 참고할 구성
                      </span>
                      {selected.relatedIds.map((id) => {
                        const node = nodes.find((item) => item.id === id);
                        return node ? (
                          <button
                            type="button"
                            key={id}
                            className="secondary"
                            onClick={() => choose(id)}
                          >
                            {node.title}
                            <ChevronRight size={14} />
                          </button>
                        ) : null;
                      })}
                    </div>
                  )}
                  {writing && brief && (
                    <form
                      className="outline-writing-card"
                      onSubmit={(event) => {
                        event.preventDefault();
                        writeUnit();
                      }}
                    >
                      <div className="outline-card-heading">
                        <strong>
                          <PenLine size={16} />
                          이번 집필
                        </strong>
                        <IconButton
                          label="집필 준비 닫기"
                          icon={X}
                          onClick={() => setWriting(false)}
                        />
                      </div>
                      <p>
                        대상 · {selected.title}
                        {sources.length ? ' · 기존 원문 뒤에 이어 써요.' : ''}
                      </p>
                      <label>
                        추가 지시와 멈출 지점
                        <textarea
                          rows={5}
                          value={requestText}
                          disabled={disabled}
                          onChange={(event) => {
                            setRequestText(event.target.value);
                            retain(`${prefix}:request:${selected.id}`, event.target.value);
                          }}
                        />
                      </label>
                      <div className="outline-form-actions">
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => setPreviewing(!previewing)}
                        >
                          집필 맥락 {previewing ? '접기' : '미리보기'}
                        </button>
                        <button
                          type="submit"
                          disabled={disabled || !!state.active || !requestText.trim()}
                        >
                          집필 시작
                        </button>
                      </div>
                    </form>
                  )}
                  {!writing && (
                    <button
                      type="button"
                      className="outline-preview-link"
                      onClick={() => void prepareWriting(true)}
                    >
                      <BookOpen size={15} />
                      이번 구성의 집필 맥락 보기
                    </button>
                  )}
                  {previewing && brief && (
                    <section className="outline-brief">
                      <h4>이번 집필에 함께 들어가는 구성</h4>
                      <p>저장된 구성으로 조립한 미리보기예요. 별도 모델을 호출하지 않아요.</p>
                      {[
                        ['상위 방향과 선택 단위', brief.outline.path],
                        ['하위 사건', brief.outline.children],
                        ['관련 계획', brief.outline.related ?? []],
                      ].map(([title, items]) => (
                        <div key={title as string}>
                          <h5>{title as string}</h5>
                          {(items as OutlineSnapshot['path']).map((node) => (
                            <details key={node.id}>
                              <summary>
                                {node.title}
                                {node.fixed ? ' · 유지 조건' : ''}
                              </summary>
                              <p>{node.intent || '아직 내용이 없어요.'}</p>
                            </details>
                          ))}
                        </div>
                      ))}
                      <p>
                        연결된 실제 원문 {brief.outline.sources?.length ?? 0}개 · 계획은 이미 일어난
                        사실이 아니에요.
                      </p>
                    </section>
                  )}
                  {!!sources.length && (
                    <section className="outline-source-list">
                      <div className="outline-card-heading">
                        <h4>
                          연결된 원문 <small>{sources.length}</small>
                        </h4>
                        <span>구성 충족 여부와는 달라요.</span>
                      </div>
                      {sources.map((source, index) => (
                        <button
                          type="button"
                          key={source.sourceRevision}
                          className="outline-source"
                          onClick={() => {
                            state.chooseSource(source.sourceRevision);
                            onClose();
                          }}
                        >
                          <FileText size={16} />
                          <span>
                            {index + 1}.{' '}
                            {nodes.find((node) => node.id === source.nodeId)?.title ??
                              selected.title}
                          </span>
                          <ChevronRight size={16} />
                        </button>
                      ))}
                    </section>
                  )}
                  {review && (
                    <section className={`outline-review ${review.stale ? 'is-stale' : ''}`}>
                      <div className="outline-card-heading">
                        <h4>
                          <ScanText size={16} />
                          최근 원문 점검
                        </h4>
                        <span>
                          {review.stale
                            ? '이후 변경됨'
                            : review.status === 'completed'
                              ? '점검 의견 있음'
                              : review.status === 'running' || review.status === 'queued'
                                ? '점검 중'
                                : '점검 미완료'}
                        </span>
                      </div>
                      <p>
                        {review.partial
                          ? '처음에는 일부 구간을 제공했어요. 추가 조회 근거는 점검 대화에서 확인해요.'
                          : '연결된 원문 전체를 참고 자료로 제공했어요.'}{' '}
                        원문이나 계획을 자동 수정하지 않아요.
                      </p>
                      <small>
                        {review.sources
                          .map((source) => `${source.start}–${source.end} / ${source.total}자`)
                          .join(' · ')}
                      </small>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() =>
                          branchId &&
                          onHelp({
                            key: crypto.randomUUID(),
                            scope: { kind: 'chat', chatId, branchId },
                            conversationId: review.conversationId,
                            title: '점검 대화',
                            text: '',
                          })
                        }
                      >
                        도우미에서 점검 의견 보기
                      </button>
                    </section>
                  )}
                </>
              ) : (
                <p className="muted">구성을 선택하거나 새 항목을 추가해 주세요.</p>
              )}
            </div>
          </div>
        )
      )}
      <footer className="outline-workspace-footer">
        <span>계획과 실제 원문을 구분해서 이어가요.</span>
        <button type="button" className="text-button" onClick={() => void load()}>
          <RefreshCw size={13} />
          새로고침
        </button>
      </footer>
    </section>
  );
}
