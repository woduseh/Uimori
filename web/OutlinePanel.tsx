import { useI18n, translateMessage, formatNumber, message as uiMessage } from './i18n.js';
import { LoadingState } from './LoadingState.js';
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
  | { kind: 'apply'; body: { idempotencyKey: string; operations: unknown[] } }
  | {
      kind: 'write';
      nodeId: string;
      commandKey: string;
      commandId?: string;
      commandRequest: {
        request?: string;
        additionalInstruction?: string;
        expectedRevision: number;
        expectedPlanHash: string;
      };
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
  const { t } = useI18n();
  const chatId = state.detail?.chat.id ?? '';
  const prefix = `outline-workspace:${chatId}`;
  const pendingKey = `outline-pending:${chatId}`;
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
  const [previousRequest, setPreviousRequest] = useState('');
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
      const value = await api<OutlineDetail>(`/chats/${chatId}/outline`);
      if (mounted.current && generation === loadGeneration.current) setOutline(value);
    } catch (cause) {
      if (mounted.current && generation === loadGeneration.current)
        setError((cause as Error).message);
    }
  }, [chatId]);
  useEffect(() => {
    mounted.current = true;
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
  // Refresh writer changes and helper results when the outline is visible again.
  const cursor = state.detail?.reader.cursor;
  useEffect(() => {
    if (cursor !== undefined && !helperVisible) void load();
  }, [cursor, helperVisible, load]);
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
      setError(uiMessage('prompts.uiYourDraftStaysOnThisScreenCheckBrowserStorage'));
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
        retain(`${prefix}:additional-instruction:${operation.nodeId}`, null);
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
      body: { idempotencyKey: crypto.randomUUID(), operations },
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
      setRequestText(stored(`${prefix}:additional-instruction:${selected.id}`, ''));
      setPreviousRequest(stored(`${prefix}:request:${selected.id}`, ''));
    } catch (cause) {
      if (mounted.current) setError((cause as Error).message);
    }
  }
  function writeUnit() {
    if (!selected || !brief || !state.detail || disabled) return;
    void send({
      kind: 'write',
      nodeId: selected.id,
      commandKey: crypto.randomUUID(),
      commandRequest: {
        additionalInstruction: requestText,
        expectedRevision: brief.expectedRevision,
        expectedPlanHash: brief.planHash,
      },
      body: {
        expectedRevision: state.detail.chat.headRevision,
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
    onHelp({
      key: crypto.randomUUID(),
      scope: { kind: 'chat', chatId },
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
                      aria-label={t('prompts.outlineToggle', { name: node.title, collapsed })}
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
                    <span className="outline-node-kind">{t(`prompts.level.${node.level}`)}</span>
                    <span className="outline-title">{node.title}</span>
                    <span className="outline-node-mark">
                      {node.fixed && <Pin size={12} aria-label={t('prompts.uiKeepCondition')} />}
                      {!!node.writings?.length && (
                        <FileText size={12} aria-label={t('prompts.uiHasSourceText')} />
                      )}
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
  return (
    <section className="outline-panel" aria-label={t('prompts.uiHierarchicalOutline')}>
      <header className="outline-workspace-header">
        <div className="outline-workspace-title">
          <ListTree size={21} />
          <div>
            <h2 ref={heading} tabIndex={-1}>
              {t('prompts.uiOutlineAndWrite')}
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
            {t('prompts.uiHelper')}
          </button>
          <IconButton label={t('prompts.uiCloseHierarchicalOutline')} icon={X} onClick={onClose} />
        </div>
      </header>
      {outline && (
        <DismissibleError message={translateMessage(error)} onDismiss={() => setError('')} />
      )}
      {pending && !busy && (
        <div className="outline-pending" role="status">
          <p>{t('prompts.uiTheSubmissionResultIsStillUnknownYourInputIs')}</p>
          <button type="button" onClick={() => void send(pending)}>
            {t('prompts.uiCheckRequestResult')}
          </button>
        </div>
      )}
      {!outline && (
        <LoadingState
          presentation="region"
          loading={!error}
          error={translateMessage(error)}
          label={t('prompts.uiLoadingOutline')}
          onRetry={() => void load()}
        />
      )}
      {outline && !nodes.length && !adding ? (
        <div className="outline-welcome">
          <div className="outline-welcome-symbol">
            <GitBranch size={32} />
          </div>
          <p className="outline-eyebrow">{t('prompts.uiNoOutlineYet')}</p>
          <p>{t('prompts.uiTheOutlineRemainsAPlanOnlyTheSelectedUnit')}</p>
          <div className="outline-welcome-actions">
            <button type="button" onClick={() => help('compose', null)}>
              <Sparkles size={18} />
              {t('prompts.uiStartOutliningWithHelper')}
            </button>
            <button type="button" className="secondary" onClick={() => add()}>
              <Plus size={18} />
              {t('prompts.uiAddManually')}
            </button>
          </div>
        </div>
      ) : (
        outline && (
          <div className="outline-workspace-body">
            <nav className="outline-navigation" aria-label={t('prompts.uiOutlineList')}>
              <div className="outline-navigation-head">
                <span>
                  {t('prompts.uiStoryOutline')}
                  <small>{formatNumber(nodes.length)}</small>
                </span>
                <IconButton
                  label={t('prompts.uiAddOutline')}
                  icon={Plus}
                  disabled={disabled}
                  onClick={() => add()}
                />
              </div>
              <div className="outline-tree-scroll">{tree(null)}</div>
            </nav>
            <div className="outline-detail" ref={detailScroll}>
              <div className="outline-mobile-select">
                <label>
                  {t('prompts.uiCurrentOutline')}
                  <select value={selectedId ?? ''} onChange={(event) => choose(event.target.value)}>
                    <option value="" disabled>
                      {t('prompts.uiSelectOutline')}
                    </option>
                    {nodes.map((node) => (
                      <option key={node.id} value={node.id}>
                        {t(`prompts.level.${node.level}`)}: {node.title}
                      </option>
                    ))}
                  </select>
                </label>
                <IconButton
                  label={t('prompts.uiAddOutline')}
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
                    {!adding && (
                      <span className="outline-eyebrow">{t('prompts.uiEditOutline')}</span>
                    )}
                    <h3>{adding ? t('prompts.uiNewOutline') : selected?.title}</h3>
                  </div>
                  {adding && (
                    <div className="outline-form-pair">
                      <label>
                        {t('prompts.uiLevel')}
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
                              {t(`prompts.level.${level}`)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        {t('prompts.uiParentOutline')}
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
                          <option value="">{t('prompts.uiNoneIndependentOutline')}</option>
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
                    {t('prompts.uiName')}
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
                    {t(`reader.outlineContent.${draft.level}`)}
                    <textarea
                      rows={9}
                      maxLength={OUTLINE_INTENT_MAX}
                      value={draft.intent}
                      disabled={disabled}
                      onChange={(event) => changeDraft({ ...draft, intent: event.target.value })}
                    />
                  </label>
                  <details className="outline-field-help">
                    <summary>{t('reader.outlineWritingHelp')}</summary>
                    <p>{t(`prompts.guidance.${draft.level}`)}</p>
                  </details>
                  <details className="outline-reference-picker">
                    <summary>
                      <Link2 size={15} />
                      {t('prompts.uiAdvancedRelatedOutlines')}
                      <small>{formatNumber(draft.relatedIds.length)}</small>
                    </summary>
                    <p>{t('prompts.uiLinkOnlyRelatedPlansSuchAsSetupAndPayoff')}</p>
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
                            <small>{t(`prompts.level.${node.level}`)}</small>
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
                      <span>{t('reader.requestKeepOutlineCondition')}</span>
                    </label>
                  )}
                  {editing && selected && draft.revision !== selected.revision && (
                    <div className="outline-conflict" role="status">
                      <p>{t('prompts.uiTheOutlineChangedElsewhereYourDraftIsPreserved')}</p>
                      <details>
                        <summary>{t('prompts.uiViewSavedOutline')}</summary>
                        <p>{selected.intent}</p>
                      </details>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => changeDraft(fromNode(selected))}
                      >
                        {t('prompts.uiLoadLatestVersion')}
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
                      {t('prompts.uiCloseKeepDraft')}
                    </button>
                    <button type="submit" disabled={disabled || !draft.title.trim()}>
                      {' '}
                      {adding ? t('prompts.uiAdd') : t('prompts.uiSave')}
                    </button>
                  </div>
                </form>
              ) : selected ? (
                <>
                  <div className="outline-detail-heading">
                    <div>
                      <span className="outline-eyebrow">
                        {t(`prompts.level.${selected.level}`)}
                      </span>
                      <h3>{selected.title}</h3>
                    </div>
                    <ActionMenu label={t('prompts.uiManageOutline')}>
                      <button type="button" disabled={disabled} onClick={edit}>
                        <PenLine size={16} />
                        {t('prompts.uiEditOutline2')}
                      </button>
                      {selected.level !== 'beat' && (
                        <button type="button" disabled={disabled} onClick={() => add(selected)}>
                          <Plus size={16} />
                          {t('prompts.uiAddChildOutline')}
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
                        {selected.fixed
                          ? t('prompts.uiRemoveKeepCondition')
                          : t('prompts.uiMarkAsKeepCondition')}
                      </button>
                      <button type="button" disabled={disabled} onClick={() => moveSelected(-1)}>
                        <ArrowUp size={16} />
                        {t('prompts.uiMoveUp')}
                      </button>
                      <button type="button" disabled={disabled} onClick={() => moveSelected(1)}>
                        <ArrowDown size={16} />
                        {t('prompts.uiMoveDown')}
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
                        {t('prompts.uiDeleteOutline')}
                      </button>
                    </ActionMenu>
                  </div>
                  <div className="outline-status-line">
                    {selected.fixed && (
                      <span>
                        <Pin size={13} />
                        {t('prompts.uiKeepCondition')}
                      </span>
                    )}
                    <span>
                      <FileText size={13} />
                      {ownSources.length
                        ? t('prompts.sourceCount', { count: ownSources.length })
                        : selected.progress.state === 'writing'
                          ? t('prompts.uiWriting2')
                          : selected.progress.state === 'scheduled'
                            ? t('prompts.uiWritingScheduled')
                            : t('prompts.uiNoSourceTextYet')}
                    </span>
                    {lower.length > 0 && (
                      <span>
                        {t('prompts.childSources', {
                          total: formatNumber(lower.length),
                          count: formatNumber(lower.filter((node) => node.writings?.length).length),
                        })}
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
                      {t('prompts.uiElaborate')}
                    </button>
                    {outlineWritable(selected.level) && (
                      <button
                        type="button"
                        disabled={disabled || !!state.active}
                        onClick={() => void prepareWriting()}
                      >
                        <PenLine size={17} />
                        {sources.length
                          ? t('prompts.uiContinueWriting')
                          : t('prompts.uiWriteThisUnit')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="secondary"
                      disabled={disabled || !sources.length}
                      onClick={() => help('review')}
                    >
                      <ScanText size={17} />
                      {t('prompts.uiCheckAgainstSource')}
                    </button>
                  </div>
                  <article className="outline-intent-card">
                    <div className="outline-card-heading">
                      <span>{t('prompts.uiOutlineContent')}</span>
                      <button
                        type="button"
                        className="text-button"
                        disabled={disabled}
                        onClick={edit}
                      >
                        {t('prompts.uiEdit2')}
                      </button>
                    </div>
                    {selected.intent ? (
                      <Prose text={selected.intent} />
                    ) : (
                      <p className="muted">{t('prompts.uiNoContentYet')}</p>
                    )}
                  </article>
                  {!!selected.relatedIds?.length && (
                    <details className="outline-related-list">
                      <summary>
                        <Link2 size={15} />
                        {t('prompts.uiAdvancedRelatedOutlines')}
                      </summary>
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
                    </details>
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
                          {t('prompts.uiThisWritingRequest')}
                        </strong>
                        <IconButton
                          label={t('prompts.uiCloseWritingPreparation')}
                          icon={X}
                          onClick={() => setWriting(false)}
                        />
                      </div>
                      <p>
                        {t('prompts.writingTarget', {
                          name: selected.title,
                          continuing: sources.length > 0,
                        })}
                      </p>
                      <section
                        aria-label={t('prompts.uiCurrentOutline')}
                        className="outline-writing-plan"
                      >
                        <h4>{t('prompts.uiCurrentOutlineReadOnly')}</h4>
                        <Prose
                          text={
                            brief.outline.path.at(-1)?.intent || t('prompts.uiNoOutlineContentYet')
                          }
                        />
                        <p className="muted">
                          {t('prompts.uiSavedOutlinesAndTheInstructionsBelowAreFixedTogether')}
                        </p>
                      </section>
                      <label>
                        {t('prompts.uiAdditionalInstructionsAndStoppingPointOptional')}
                        <textarea
                          rows={5}
                          maxLength={OUTLINE_INTENT_MAX}
                          value={requestText}
                          disabled={disabled}
                          onChange={(event) => {
                            setRequestText(event.target.value);
                            retain(
                              `${prefix}:additional-instruction:${selected.id}`,
                              event.target.value
                            );
                          }}
                        />
                      </label>
                      {previousRequest && (
                        <details className="outline-reference-picker">
                          <summary>{t('prompts.uiPreviousWritingRequestDraftReadAndCopy')}</summary>
                          <p>
                            {t('prompts.uiThePreviousDraftIsPreservedMoveOnlyNeededInstructions')}
                          </p>
                          <label>
                            {t('prompts.uiPreviousWritingRequestDraft')}
                            <textarea rows={5} value={previousRequest} readOnly />
                          </label>
                          <button
                            type="button"
                            className="secondary"
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(previousRequest);
                              } catch {
                                setError(
                                  uiMessage('prompts.uiUnableToCopyTheDraftSelectTheDraftText')
                                );
                              }
                            }}
                          >
                            {t('prompts.uiCopyPreviousDraft')}
                          </button>
                        </details>
                      )}
                      <div className="outline-form-actions">
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => setPreviewing(!previewing)}
                        >
                          {t('prompts.contextToggle', { expanded: previewing })}
                        </button>
                        <button type="submit" disabled={disabled || !!state.active}>
                          {t('prompts.uiStartWriting')}
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
                      {t('prompts.uiViewOutlineInputContext')}
                    </button>
                  )}
                  {previewing && brief && (
                    <section className="outline-brief">
                      <h4>{t('prompts.uiOutlinesIncludedInThisRequest')}</h4>
                      <p className="muted">{t('reader.noModelCall')}</p>
                      {[
                        [t('prompts.uiParentDirectionAndSelectedUnit'), brief.outline.path],
                        [t('prompts.uiChildEvents'), brief.outline.children],
                        [t('prompts.uiRelatedPlans'), brief.outline.related ?? []],
                      ].map(([title, items]) => (
                        <div key={title as string}>
                          <h5>{title as string}</h5>
                          {(items as OutlineSnapshot['path']).map((node) => (
                            <details key={node.id}>
                              <summary>
                                {node.title}
                                {node.fixed ? t('prompts.uiKeepCondition2') : ''}
                              </summary>
                              <p>{node.intent || t('prompts.uiNoContentYet')}</p>
                            </details>
                          ))}
                        </div>
                      ))}
                      <p>
                        {t('prompts.actualSources', {
                          count: formatNumber(brief.outline.sources?.length ?? 0),
                        })}
                      </p>
                    </section>
                  )}
                  {!!sources.length && (
                    <section className="outline-source-list">
                      <div className="outline-card-heading">
                        <h4>
                          {t('prompts.uiLinkedSourceText')}
                          <small>{formatNumber(sources.length)}</small>
                        </h4>
                        <span>{t('prompts.uiLinkedSourceTextMayNotCoverEveryPartOf')}</span>
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
                </>
              ) : null}
            </div>
          </div>
        )
      )}
      <footer className="outline-workspace-footer">
        <button type="button" className="text-button" onClick={() => void load()}>
          <RefreshCw size={13} />
          {t('prompts.uiRefresh')}
        </button>
      </footer>
    </section>
  );
}
