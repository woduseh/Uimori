import { SelectionCheckbox } from './BooleanControls.js';
import { useI18n, formatNumber } from './i18n.js';
import { toUiMessage } from './api-errors.js';
import { uiMessage, type UiMessage } from './ui-message.js';
import { LoadingState } from './LoadingState.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FileText,
  Flag,
  GitBranch,
  LoaderCircle,
  Search,
  ListTree,
  Plus,
  Sparkles,
  PenLine,
  ScanText,
  Link2,
  Maximize2,
  X,
  Pin,
  Trash2,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';
import { outlineEndpoints, type OutlineOperation } from '#contracts';
import { api, ApiError, callEndpoint } from './api.js';
import { ActionMenu } from './ActionMenu.js';
import { IconButton } from './IconButton.js';
import { CloseIcon, EditIcon } from './ui-icons.js';
import { Dialog } from './Dialog.js';
import { DismissibleError } from './DismissibleError.js';
import { Prose } from './Prose.js';
import { OUTLINE_REFRESH_EVENT, type OutlineHelperRequest } from './outline-helper.js';
import {
  OUTLINE_LEVELS,
  OUTLINE_INTENT_MAX,
  OUTLINE_TITLE_MAX,
  outlineLevelIndex,
  outlineParentAllowed,
  outlineWritable,
  type OutlineDetail,
  type OutlineLevel,
  type OutlineNode,
  type OutlineSnapshot,
  type OutlineWriting,
} from '../core/outline.js';
import type { StoryState } from './useStory.js';
import type { RunReceipt } from '../core/types.js';
import type { SceneCommand } from '../core/story.js';
import './outline.css';
import { readOptionalJson } from './optional-storage.js';
import { storageKeys } from './storage-keys.js';

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
  | { kind: 'apply'; body: { idempotencyKey: string; operations: OutlineOperation[] } }
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
  return (readOptionalJson('session', key, null) ?? fallback) as T;
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
const currentWritings = (node: OutlineNode) =>
  (node.writings ?? []).filter((source) => source.current);
const uniqueSources = (list: OutlineNode[]): OutlineWriting[] => [
  ...new Map(
    list.flatMap((node) => node.writings ?? []).map((source) => [source.sourceRevision, source])
  ).values(),
];
const rejected = (error: unknown) =>
  error instanceof ApiError &&
  error.status >= 400 &&
  error.status < 500 &&
  ![408, 429].includes(error.status);

export function OutlinePanel({
  state,
  target,
  layout,
  visible,
  onClose,
  onExpand,
  onHelp,
  helperVisible,
  onToggleHelper,
}: {
  state: StoryState;
  target: { nodeId: string; epoch: number } | null;
  layout: 'workspace' | 'sidecar';
  visible: boolean;
  onClose: () => void;
  onExpand: () => void;
  onHelp: (request: OutlineHelperRequest) => void;
  helperVisible: boolean;
  onToggleHelper: () => void;
}) {
  const { t } = useI18n();
  const chatId = state.detail?.chat.id ?? '';
  const prefix = storageKeys.outlineWorkspace(chatId);
  const pendingKey = storageKeys.outlinePending(chatId);
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
  const [error, setError] = useState<UiMessage | null>(null);
  const [loadError, setLoadError] = useState<UiMessage | null>(null);
  const [loading, setLoading] = useState(false);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [writing, setWriting] = useState(false);
  const [requestText, setRequestText] = useState('');
  const [previousRequest, setPreviousRequest] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [deleting, setDeleting] = useState<OutlineNode | null>(null);
  const [relatedQuery, setRelatedQuery] = useState('');
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
    setLoading(true);
    try {
      const value = await api<OutlineDetail>(`/chats/${chatId}/outline`);
      if (mounted.current && generation === loadGeneration.current) {
        setOutline(value);
        setLoadError(null);
      }
    } catch (cause) {
      if (mounted.current && generation === loadGeneration.current)
        setLoadError(toUiMessage(cause));
    } finally {
      if (mounted.current && generation === loadGeneration.current) setLoading(false);
    }
  }, [chatId]);
  useEffect(() => {
    heading.current?.focus({ preventScroll: layout === 'sidecar' });
  }, [layout]);
  useEffect(() => {
    mounted.current = true;
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
  const cursor = state.detail?.reader.cursor;
  useEffect(() => {
    if (cursor !== undefined && visible && !helperVisible) void load();
  }, [cursor, visible, helperVisible, load]);
  useEffect(() => {
    if (!outline || (selectedId && outline.nodes.some((node) => node.id === selectedId))) return;
    setSelectedId(
      outline.nodes.find((node) => outlineWritable(node.level))?.id ?? outline.nodes[0]?.id ?? null
    );
  }, [outline, selectedId]);
  useEffect(() => {
    if (!adding && !editing && !helperVisible) heading.current?.focus({ preventScroll: true });
  }, [adding, editing, helperVisible]);
  const handledTarget = useRef(0);
  useEffect(() => {
    if (!outline || !target || handledTarget.current === target.epoch) return;
    const node = outline.nodes.find((item) => item.id === target.nodeId);
    if (!node) return;
    handledTarget.current = target.epoch;
    const ancestors: string[] = [];
    for (let parent = node.parentId; parent; ) {
      ancestors.push(parent);
      parent = outline.nodes.find((item) => item.id === parent)?.parentId ?? null;
    }
    if (ancestors.some((id) => folded.includes(id))) {
      const next = folded.filter((id) => !ancestors.includes(id));
      setFolded(next);
      try {
        retain(`${prefix}:folded`, next);
      } catch {}
    }
    if (selectedId !== node.id) choose(node.id);
  });
  function choose(id: string) {
    briefGeneration.current++;
    setSelectedId(id);
    try {
      retain(`${prefix}:selected`, id);
    } catch {}
    setEditing(false);
    setAdding(false);
    setDraft(null);
    setWriting(false);
    setPreviewing(false);
    setBrief(null);
    setError(null);
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
    const fresh: Draft = {
      title: '',
      intent: '',
      level,
      parentId: parent?.id ?? null,
      relatedIds: [],
      fixed: false,
    };
    const saved = stored<Draft>(`${prefix}:new`, fresh);
    setDraft(saved.parentId === fresh.parentId && saved.level === fresh.level ? saved : fresh);
    setAdding(true);
    setEditing(false);
    setWriting(false);
    setError(null);
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
    setError(null);
    let recovered = false;
    try {
      const saved = stored<Pending | null>(pendingKey, null);
      if (saved?.body.idempotencyKey === operation.body.idempotencyKey) {
        operation = saved;
        recovered = true;
      }
      if (!remember(operation, operation.body.idempotencyKey, true)) return;
      if (operation.kind === 'apply') {
        const result = await callEndpoint(outlineEndpoints.apply, {
          chatId,
          ...operation.body,
        });
        if (
          stored<Pending | null>(pendingKey, null)?.body.idempotencyKey !==
          operation.body.idempotencyKey
        )
          return;
        if (mounted.current) {
          ++loadGeneration.current;
          setOutline(result.detail);
          for (const item of operation.body.operations)
            if (
              item.op === 'remove' ||
              (item.op === 'update' && (item.title !== undefined || item.intent !== undefined))
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
        await api<RunReceipt>(`/scene-commands/${operation.commandId}/run`, operation.body);
      }
      if (!remember(null, operation.body.idempotencyKey)) return;
      if (operation.kind === 'write' && mounted.current) {
        retain(`${prefix}:additional-instruction:${operation.nodeId}`, null);
        dispatchEvent(new Event(OUTLINE_REFRESH_EVENT));
        await state.refresh(chatId);
        if (mounted.current && layout === 'workspace') onClose();
        else if (mounted.current) {
          setWriting(false);
          setBrief(null);
          setRequestText('');
        }
      }
    } catch (cause) {
      if (!recovered && rejected(cause)) {
        remember(null, operation.body.idempotencyKey);
        if (mounted.current) await load();
      }
      if (mounted.current) setError(toUiMessage(cause));
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const apply = (operations: OutlineOperation[]) => {
    if (disabled) return;
    void send({
      kind: 'apply',
      body: { idempotencyKey: crypto.randomUUID(), operations },
    });
  };
  async function prepareWriting(previewOnly = false) {
    if (!selected) return;
    setError(null);
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
      if (mounted.current) setError(toUiMessage(cause));
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
  async function changeFocus(nodeId: string | null) {
    if (disabled) return;
    setBusy(true);
    setError(null);
    try {
      await callEndpoint(outlineEndpoints.setFocus, { chatId, nodeId });
      dispatchEvent(new Event(OUTLINE_REFRESH_EVENT));
    } catch (cause) {
      if (mounted.current) setError(toUiMessage(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  function saveDraft(current: Draft) {
    if (adding || !selected) {
      apply([
        {
          op: 'create',
          level: current.level,
          parentId: current.parentId,
          title: current.title,
          intent: current.intent,
          relatedIds: current.relatedIds,
        },
      ]);
      return;
    }
    const expectedRevision = current.revision ?? selected.revision;
    const update: Extract<OutlineOperation, { op: 'update' }> = {
      op: 'update',
      id: selected.id,
      expectedRevision,
      title: current.title,
      intent: current.intent,
      relatedIds: current.relatedIds,
      fixed: current.fixed,
      ...(current.level !== selected.level ? { level: current.level } : {}),
    };
    if (current.parentId === selected.parentId) {
      apply([update]);
      return;
    }
    const position =
      Math.max(
        -1,
        ...nodes.filter((node) => node.parentId === current.parentId).map((node) => node.position)
      ) + 1;
    const move = { op: 'move' as const, id: selected.id, parentId: current.parentId, position };
    const moveFirst = outlineLevelIndex(current.level) < outlineLevelIndex(selected.level);
    apply(
      moveFirst
        ? [
            { ...move, expectedRevision },
            { ...update, expectedRevision: expectedRevision + 1 },
          ]
        : [update, { ...move, expectedRevision: expectedRevision + 1 }]
    );
  }
  function help(purpose: 'compose' | 'review', node: OutlineNode | null = selected) {
    onHelp({
      key: crypto.randomUUID(),
      scope: { kind: 'chat', chatId },
      target: { nodeId: node?.id ?? null, expectedRevision: node?.revision ?? null, purpose },
      title: node?.title ?? t('prompts.outlineNewStoryTitle'),
      text:
        purpose === 'review'
          ? t('prompts.outlineReviewRequest')
          : node
            ? t('prompts.outlineElaborateRequest')
            : t('prompts.outlineStartRequest'),
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
                        } catch {}
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
                    <span className="outline-node-head">
                      <span className="outline-node-kind">{t(`prompts.level.${node.level}`)}</span>
                      <span className="outline-node-mark">
                        {progress.has(node.id) && (
                          <small
                            className="outline-node-progress"
                            aria-label={t('prompts.outlineTreeProgress', progress.get(node.id)!)}
                          >
                            {formatNumber(progress.get(node.id)!.count)}/
                            {formatNumber(progress.get(node.id)!.total)}
                          </small>
                        )}
                        {outline?.focusId === node.id && (
                          <Flag size={12} aria-label={t('prompts.outlineCurrentUnit')} />
                        )}
                        {node.fixed && <Pin size={12} aria-label={t('prompts.uiKeepCondition')} />}
                        {node.progress.state === 'writing' ? (
                          <LoaderCircle
                            size={12}
                            className="activity-spinner"
                            aria-label={t('prompts.uiWriting2')}
                          />
                        ) : node.progress.state === 'failed' ? (
                          <CircleAlert
                            size={12}
                            className="outline-node-alert"
                            aria-label={t('prompts.outlineWritingFailed')}
                          />
                        ) : (
                          !!currentWritings(node).length && (
                            <FileText size={12} aria-label={t('prompts.uiHasSourceText')} />
                          )
                        )}
                      </span>
                    </span>
                    <span className="outline-title">{node.title}</span>
                  </button>
                </div>
                {children && !collapsed && tree(node.id, depth + 1)}
              </li>
            );
          })}
      </ul>
    );
  }
  const ownSources = selected ? currentWritings(selected) : [];
  const descendants = (id: string): OutlineNode[] =>
    nodes.filter((node) => node.parentId === id).flatMap((node) => [node, ...descendants(node.id)]);
  const lower = selected ? descendants(selected.id) : [];
  const allSources = uniqueSources([...(selected ? [selected] : []), ...lower]);
  const sources = allSources.filter((source) => source.current);
  const writtenHere = (node: OutlineNode) =>
    !!currentWritings(node).length ||
    descendants(node.id).some((item) => !!currentWritings(item).length);
  const progress = new Map<string, { count: number; total: number }>();
  for (const node of nodes) {
    const units = nodes.filter((item) => item.parentId === node.id && outlineWritable(item.level));
    if (units.length && !outlineWritable(node.level))
      progress.set(node.id, { count: units.filter(writtenHere).length, total: units.length });
  }
  const nextUnit =
    selected && outlineWritable(selected.level) && sources.length
      ? nodes
          .slice(nodes.findIndex((node) => node.id === selected.id) + 1)
          .find((node) => node.level === selected.level && !writtenHere(node))
      : undefined;
  const editingDescendants = editing && selected ? new Set(lower.map((node) => node.id)) : null;
  const editingChildLevels =
    editing && selected
      ? nodes.filter((node) => node.parentId === selected.id).map((node) => node.level)
      : [];
  const relatedChoices = nodes
    .filter((node) => node.id !== selectedId || adding)
    .filter((node) => node.title.toLowerCase().includes(relatedQuery.trim().toLowerCase()));
  return (
    <section
      className={`outline-panel outline-panel-${layout}`}
      aria-label={t('prompts.uiHierarchicalOutline')}
    >
      <header className="outline-workspace-header">
        <div className="outline-workspace-title">
          <ListTree size={21} />
          <div>
            <h2 ref={heading} tabIndex={-1}>
              {t('prompts.uiOutlineAndWrite')}
            </h2>
            {layout === 'workspace' && <p>{state.detail?.chat.title}</p>}
          </div>
        </div>
        <div className="outline-header-actions">
          {layout === 'sidecar' ? (
            <IconButton label={t('workspace.expandOutline')} icon={Maximize2} onClick={onExpand} />
          ) : (
            <>
              <IconButton
                icon={Sparkles}
                size={18}
                label={t('prompts.uiHelper')}
                className={`secondary outline-helper-toggle ${helperVisible ? 'is-active' : ''}`}
                onClick={onToggleHelper}
              />
              <IconButton
                label={t('prompts.uiCloseHierarchicalOutline')}
                icon={X}
                onClick={onClose}
              />
            </>
          )}
        </div>
      </header>
      {outline && <DismissibleError error={error} onDismiss={() => setError(null)} />}
      {outline && loadError && (
        <LoadingState
          presentation="inline"
          loading={loading}
          error={loadError}
          label={uiMessage('prompts.uiLoadingOutline')}
          onRetry={() => void load()}
        />
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
          loading={loading || !loadError}
          error={loadError}
          label={uiMessage('prompts.uiLoadingOutline')}
          onRetry={() => void load()}
        />
      )}
      {outline && !nodes.length && !adding ? (
        <div className="outline-welcome">
          <div className="outline-welcome-symbol">
            <GitBranch size={32} />
          </div>
          <p className="outline-eyebrow">{t('prompts.uiNoOutlineYet')}</p>
          <div className="outline-welcome-actions">
            <button type="button" className="primary" onClick={() => help('compose', null)}>
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
                    saveDraft(draft);
                  }}
                >
                  <div className="outline-section-heading">
                    <h3>{adding ? t('prompts.uiNewOutline') : selected?.title}</h3>
                  </div>
                  {(adding || editing) && (
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
                          {OUTLINE_LEVELS.filter(
                            (level) =>
                              outlineParentAllowed(
                                nodes.find((node) => node.id === draft.parentId)?.level ?? null,
                                level
                              ) &&
                              editingChildLevels.every((child) =>
                                outlineParentAllowed(level, child)
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
                            .filter((node) =>
                              editingDescendants
                                ? node.id !== selectedId &&
                                  !editingDescendants.has(node.id) &&
                                  outlineParentAllowed(node.level, draft.level)
                                : node.level !== 'beat'
                            )
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
                  <details className="outline-reference-picker">
                    <summary>
                      <Link2 size={15} />
                      {t('prompts.uiAdvancedRelatedOutlines')}
                      <small>{formatNumber(draft.relatedIds.length)}</small>
                    </summary>
                    <label className="outline-related-search">
                      <Search size={15} aria-hidden="true" />
                      <input
                        type="search"
                        aria-label={t('prompts.outlineSearchRelated')}
                        placeholder={t('prompts.outlineSearchRelated')}
                        value={relatedQuery}
                        onChange={(event) => setRelatedQuery(event.target.value)}
                      />
                    </label>
                    {!relatedChoices.length && <p>{t('prompts.outlineNoSearchResults')}</p>}
                    {relatedChoices.map((node) => (
                      <label key={node.id}>
                        <SelectionCheckbox
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
                      <SelectionCheckbox
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
                        if (adding) {
                          try {
                            retain(`${prefix}:new`, null);
                          } catch {}
                        }
                        setAdding(false);
                        setEditing(false);
                        setDraft(null);
                      }}
                    >
                      {t('prompts.uiClose')}
                    </button>
                    <button
                      type="submit"
                      className="primary"
                      disabled={disabled || !draft.title.trim()}
                    >
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
                      <div className="action-menu-group">
                        <button type="button" disabled={disabled} onClick={edit}>
                          <EditIcon size={16} />
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
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() =>
                            void changeFocus(outline.focusId === selected.id ? null : selected.id)
                          }
                        >
                          <Flag size={16} />
                          {outline.focusId === selected.id
                            ? t('prompts.outlineClearCurrent')
                            : t('prompts.outlineSetCurrent')}
                        </button>
                      </div>
                      <div className="action-menu-group">
                        <button type="button" disabled={disabled} onClick={() => moveSelected(-1)}>
                          <ArrowUp size={16} />
                          {t('prompts.uiMoveUp')}
                        </button>
                        <button type="button" disabled={disabled} onClick={() => moveSelected(1)}>
                          <ArrowDown size={16} />
                          {t('prompts.uiMoveDown')}
                        </button>
                      </div>
                      <div className="action-menu-group">
                        <button
                          className="danger"
                          type="button"
                          aria-haspopup="dialog"
                          disabled={disabled || allSources.length > 0}
                          onClick={() => setDeleting(selected)}
                        >
                          <Trash2 size={16} />
                          {t('prompts.uiDeleteOutline')}
                        </button>
                      </div>
                    </ActionMenu>
                  </div>
                  <div className="outline-status-line">
                    {outline.focusId === selected.id && (
                      <span>
                        <Flag size={13} />
                        {t('prompts.outlineCurrentUnit')}
                      </span>
                    )}
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
                    {(selected.progress.state === 'failed' ||
                      selected.progress.state === 'cancelled') && (
                      <span className="outline-status-alert">
                        <CircleAlert size={13} />
                        {selected.progress.state === 'failed'
                          ? t('prompts.outlineWritingFailed')
                          : t('prompts.outlineWritingCancelled')}
                      </span>
                    )}
                    {allSources.length > sources.length && (
                      <span>
                        <GitBranch size={13} />
                        {t('prompts.outlineOtherBranchSources', {
                          count: allSources.length - sources.length,
                        })}
                      </span>
                    )}
                    {lower.length > 0 && (
                      <span>
                        {t('prompts.childSources', {
                          total: lower.length,
                          count: lower.filter((node) => currentWritings(node).length).length,
                        })}
                      </span>
                    )}
                  </div>
                  <div className="outline-primary-actions">
                    <button type="button" className="secondary" disabled={disabled} onClick={edit}>
                      <EditIcon size={17} />
                      {t('prompts.uiEdit2')}
                    </button>
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
                        className="primary"
                        disabled={disabled || !!state.active}
                        onClick={() => void prepareWriting()}
                      >
                        <PenLine size={17} />
                        {sources.length ? t('prompts.uiContinueWriting') : t('prompts.uiWrite')}
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
                    {nextUnit && (
                      <button
                        type="button"
                        className="secondary outline-next-unit"
                        onClick={() => choose(nextUnit.id)}
                      >
                        {t('prompts.outlineNextUnit', { title: nextUnit.title })}
                        <ChevronRight size={17} />
                      </button>
                    )}
                  </div>
                  <article className="outline-intent-card">
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
                          <summary>{t('prompts.uiPreviousWritingRequest')}</summary>
                          <textarea
                            aria-label={t('prompts.uiPreviousWritingRequestDraft')}
                            rows={5}
                            value={previousRequest}
                            readOnly
                          />
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
                        <button
                          type="submit"
                          className="primary"
                          disabled={disabled || !!state.active}
                        >
                          {t('prompts.uiStartWriting')}
                        </button>
                      </div>
                    </form>
                  )}
                  {!writing && (
                    <button
                      type="button"
                      className="outline-preview-link"
                      aria-expanded={previewing}
                      onClick={() =>
                        previewing ? setPreviewing(false) : void prepareWriting(true)
                      }
                    >
                      <BookOpen size={15} />
                      {previewing
                        ? t('prompts.contextToggle', { expanded: true })
                        : t('prompts.uiViewOutlineInputContext')}
                    </button>
                  )}
                  {previewing && brief && (
                    <section className="outline-brief">
                      <h4>{t('prompts.uiOutlinesIncludedInThisRequest')}</h4>
                      {(
                        [
                          [t('prompts.uiParentOutlinesAndCurrentItem'), brief.outline.path],
                          [t('prompts.uiChildEvents'), brief.outline.children],
                          [t('prompts.uiRelatedPlans'), brief.outline.related ?? []],
                          [
                            t('prompts.outlineNeighborUnits'),
                            [
                              brief.outline.neighbors?.previous && {
                                ...brief.outline.neighbors.previous,
                                title: t('prompts.outlinePreviousUnit', {
                                  title: brief.outline.neighbors.previous.title,
                                }),
                              },
                              brief.outline.neighbors?.next && {
                                ...brief.outline.neighbors.next,
                                title: t('prompts.outlineNextUnit', {
                                  title: brief.outline.neighbors.next.title,
                                }),
                              },
                            ].filter((node) => !!node),
                          ],
                        ] as [string, OutlineSnapshot['path']][]
                      )
                        .filter(([, items]) => items.length > 0)
                        .map(([title, items]) => (
                          <div key={title}>
                            <h5>{title}</h5>
                            {items.map((node) => (
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
                      </div>
                      {sources.map((source, index) => (
                        <button
                          type="button"
                          key={source.sourceRevision}
                          className="outline-source"
                          onClick={() => {
                            state.chooseSource(source.sourceRevision);
                            if (layout === 'workspace') onClose();
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
      <Dialog
        open={!!deleting}
        title={t('shared.deleteConfirm')}
        variant="confirmation"
        role="alertdialog"
        className="delete-dialog"
        onClose={() => setDeleting(null)}
      >
        <p>{t('shared.deleteQuestion', { title: deleting?.title ?? '' })}</p>
        <p className="muted">
          {deleting && descendants(deleting.id).length
            ? t('prompts.outlineDeleteDescendants', { count: descendants(deleting.id).length })
            : t('prompts.outlineDeleteIrreversible')}
        </p>
        <div className="form-actions">
          <button type="button" className="secondary" onClick={() => setDeleting(null)}>
            <CloseIcon size={18} aria-hidden="true" />
            {t('shared.cancel')}
          </button>
          <button
            type="button"
            className="delete-button"
            disabled={disabled}
            onClick={() => {
              if (!deleting) return;
              apply([{ op: 'remove', id: deleting.id, expectedRevision: deleting.revision }]);
              setDeleting(null);
            }}
          >
            {t('prompts.uiDeleteOutline')}
          </button>
        </div>
      </Dialog>
    </section>
  );
}
