import {
  t,
  useI18n,
  translateMessage,
  formatDate,
  formatNumber,
  messageRef,
  message as uiMessage,
} from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { OUTLINE_REFRESH_EVENT, type OutlineHelperRequest } from './outline-helper.js';
import type { OutlineTarget } from '../core/outline.js';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type MutableRefObject,
} from 'react';
import {
  ArrowUp,
  Check,
  Copy,
  History,
  Square,
  X,
  Maximize2,
  ArrowLeft,
  ChevronDown,
} from 'lucide-react';
import { SettingsIcon, CloseIcon } from './ui-icons.js';
import type { Library } from '../core/product.js';
import type {
  HelperConversation,
  HelperMessageMutation,
  HelperEditor,
  HelperResourceRef,
  HelperScope,
  HelperSelection,
} from '../core/helper.js';
import { HELPER_PERSONA_MAX_CHARS, REQUEST_TEXT_MAX_CHARS } from '../core/content-limits.js';
import { UI_HELPER_PERSONA } from './helper-persona.js';
import { api, ApiError } from './api.js';
import { RetryFailure } from './RetryFailure.js';
import { RequestMessage } from './RequestMessage.js';
import { NoticeBanner } from './NoticeBanner.js';
import { HelperActivityDetails, useHelperActivity } from './HelperActivity.js';
import { helperActivitySummary } from './helper-activity.js';
import { Dialog } from './Dialog.js';
import { DraftDiscardActions } from './DraftDiscardActions.js';
import { elapsedLabel } from './ActivityStatus.js';
import { TurnStatus, type StatusTone } from './TurnStatus.js';
import { ActivityBar } from './ActivityBar.js';
import { ChatComposer, ComposerInput } from './ChatComposer.js';
import { IconButton } from './IconButton.js';
import { PartialResponse, ResponseDisplay } from './StreamingResponse.js';
import type { ResponseDisplayMode } from './presentation-settings.js';
import { HelperArtifactCard } from './HelperArtifactCard.js';
import { HelperTaskResults } from './HelperTaskResults.js';
import {
  HelperDeleteActions,
  HelperResponseEditor,
  type HelperDeleteScope,
} from './HelperMessageActions.js';
import { HelperResourceUndo } from './HelperResourceUndo.js';
import { useHelperConversation, type HelperTaskView } from './useHelperConversation.js';
import { interceptAppHistory } from './app-history.js';
import {
  editorContextChanged,
  captureActiveEditorContext,
  getActiveEditorContext,
  type ActiveEditorContext,
} from './resource-editor.js';
import { useHelperSessions } from './useHelperSessions.js';
import { HelperSessionBar, type HelperNavigationActions } from './HelperSessionBar.js';
import { requestFileError } from './request-file-errors.js';
import { HelperModelPicker } from './HelperModelPicker.js';
import { usePromptWorkspace } from './usePromptWorkspace.js';
import {
  HelperAttachmentPicker,
  HelperDraftAttachments,
  HelperStoredFiles,
} from './HelperAttachments.js';
import {
  acceptHelperAttachments,
  helperAttachmentDraftMatches,
  useHelperAttachmentDraft,
  type FrozenHelperAttachments,
} from './helper-attachment-draft.js';
import { SaveButton } from './SaveButton.js';
import { SaveConflictDialog } from './SaveConflictDialog.js';
import { TransientNotice } from './TransientNotice.js';
import { modelLabel } from './storyLabels.js';
import {
  cachedHelperRecovery,
  clearHelperRecoveryIf,
  loadHelperRecovery,
  writeHelperRecovery,
} from './helper-recovery.js';
import './helper.css';
import './settings-layout.css';

type Props = {
  enterSend: boolean;
  responseDisplay: ResponseDisplayMode;
  open: boolean;
  navigation?: { conversationId: string; taskId: string; sequence: number } | null;
  modal?: boolean;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  returnToSidecar?: boolean;
  navigationLeading?: ReactNode;
  navigationHost?: HTMLElement | null;
  navigationActions?: MutableRefObject<HelperNavigationActions | null>;
  searchRequest?: number;
  onSelectConversation?: () => void;
  returnLabel?: string;
  onOpenTarget?: (
    target: import('../core/helper.js').HelperTaskResultTarget
  ) => void | Promise<void>;
  onScopeChange?: (scope: HelperScope) => void;
  ready?: boolean;
  scope: HelperScope;
  selection?: HelperSelection & { key: string; scope?: HelperScope; conversationId?: string };
  resource?: HelperResourceRef | null;
  onClearResource?: () => void;
  outlineRequest?: OutlineHelperRequest;
  draftRequest?: { key: string; text: string; scope: HelperScope; conversationId?: string };
  outlineWorkspace?: boolean;
  onClose: () => void;
  onModelSettings: () => void;
  /** Current global helper model, worded like the reader's main-model chip. */
  modelDescription: string;
  modelTitle: string;
  modelRevision: number;
  library: Library | null;
};
type Outbox = Partial<FrozenHelperAttachments> & {
  retryOf?: string;
  steerTaskId?: string;
  requestKey: string;
  text: string;
  scope: string;
  targetConversationId: string;
  editor?: HelperEditor;
  selection?: HelperSelection;
  outline?: OutlineTarget;
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
  return !active(task) && Date.parse(task.updatedAt) - Date.parse(task.startedAt) < 1000
    ? ''
    : measured;
}
function HelperTaskElapsed({
  task,
  visible,
  prefix = '',
}: {
  task: HelperTaskView;
  visible: boolean;
  prefix?: string;
}) {
  useI18n();
  const [now, setNow] = useState(Date.now);
  const ticking = active(task);
  useEffect(() => {
    if (!visible || !ticking) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const update = () => {
      clearInterval(timer);
      if (document.hidden) return;
      setNow(Date.now());
      timer = setInterval(() => setNow(Date.now()), 1000);
    };
    update();
    document.addEventListener('visibilitychange', update);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
    };
  }, [visible, ticking]);
  const elapsed = taskElapsed(task, now);
  return elapsed ? <span className="activity-elapsed">{`${prefix}${elapsed}`}</span> : null;
}
const statusLabel: Record<string, string> = {
  queued: 'helpers.m002',
  running: 'helpers.m003',
  completed: 'helpers.m004',
  failed: 'helpers.m005',
  cancelled: 'helpers.m006',
  interrupted: 'helpers.m007',
};
const activityKey = (task: HelperTaskView) =>
  `helper-task-activity:${task.conversationId}:${task.id}${active(task) ? '' : ':settled'}`;
function savedActivityOpen(task: HelperTaskView) {
  try {
    return sessionStorage.getItem(activityKey(task)) === 'open';
  } catch {
    return false;
  }
}

function HelperResponseActions({ text }: { text: string }) {
  useI18n();
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (copyState !== 'copied') return;
    const timer = setTimeout(() => setCopyState('idle'), 1800);
    return () => clearTimeout(timer);
  }, [copyState]);

  const copyResponse = async () => {
    setCopyState('copying');
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  return (
    <>
      <IconButton
        icon={copyState === 'copied' ? Check : Copy}
        label={copyState === 'copied' ? t('helpers.m008') : t('helpers.m009')}
        className="secondary"
        size={18}
        disabled={copyState === 'copying'}
        onClick={() => void copyResponse()}
      />
      <span className="sr-only" role="status">
        {copyState === 'copied' ? t('helpers.m010') : ''}
      </span>
      {copyState === 'failed' && (
        <p className="error helper-copy-error" role="alert">
          {t('helpers.m011')}
        </p>
      )}
    </>
  );
}

function local(key: string): string | null {
  return cachedHelperRecovery(key.replace(/^uimori:/u, '')) ?? null;
}
function saveLocal(key: string, value: string | null) {
  void writeHelperRecovery(key.replace(/^uimori:/u, ''), value).catch(() => {});
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
type SelectedOutline = { target: OutlineTarget; title: string; request: string };
function storedOutline(scope: string): SelectedOutline | null {
  try {
    const value = JSON.parse(
      local(`uimori:helper-outline:${scope}`) ?? 'null'
    ) as SelectedOutline | null;
    return value &&
      ['compose', 'review'].includes(value.target?.purpose) &&
      typeof value.title === 'string'
      ? value
      : null;
  } catch {
    return null;
  }
}
const selectionRequest = '선택한 원문을 검토해 주세요.';

export function HelperPanel(props: Props) {
  useI18n();
  const sessions = useHelperSessions(
    props.open && props.ready !== false,
    props.scope,
    props.expanded
  );
  const navigatedTask = useRef<number | null>(null);
  useEffect(() => {
    const target = props.navigation;
    if (!props.open || !target || navigatedTask.current === target.sequence) return;
    const match = sessions.sessions.find((session) => session.id === target.conversationId);
    if (!match) return;
    navigatedTask.current = target.sequence;
    sessions.select(match);
    setTaskHistory({ taskId: target.taskId });
  }, [props.navigation, props.open, sessions.sessions, sessions.select]);
  const scopeKey = sessions.currentId ?? '';
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  const data = useHelperConversation(
    props.open && props.ready !== false,
    sessions.currentId,
    sessions.sessions.find((session) => session.id === sessions.currentId)?.latestEventSeq
  );
  const conversation = data.current?.conversation ?? null;
  const currentActivitySequence = sessions.sessions.find(
    (session) => session.id === sessions.currentId
  )?.latestActivityEventSeq;
  useEffect(() => {
    if (
      !props.open ||
      data.loading ||
      currentActivitySequence === undefined ||
      conversation?.id !== sessions.currentId ||
      !sessions.currentId
    )
      return;
    const id = sessions.currentId;
    const acknowledgeVisible = () => {
      if (!document.hidden) sessions.acknowledge([id]);
    };
    acknowledgeVisible();
    document.addEventListener('visibilitychange', acknowledgeVisible);
    return () => document.removeEventListener('visibilitychange', acknowledgeVisible);
  }, [
    props.open,
    data.loading,
    conversation?.id,
    sessions.currentId,
    currentActivitySequence,
    sessions.acknowledge,
  ]);
  const scope = conversation?.scope ?? props.scope;
  const selectedScope = conversation?.scope;
  useEffect(() => {
    if (selectedScope) props.onScopeChange?.(selectedScope);
  }, [selectedScope, props.onScopeChange]);
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
  const [unpersisted, setUnpersisted] = useState<Record<string, boolean>>({});
  const [outboxDecision, setOutboxDecision] = useState<Outbox | null>(null);
  useEffect(() => {
    setOutboxDecision((old) => (old && (!props.open || old.scope !== scopeKey) ? null : old));
  }, [scopeKey, props.open]);
  const [hydrated, setHydrated] = useState<Record<string, boolean>>({});
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  const [outlineSelections, setOutlineSelections] = useState<
    Record<string, SelectedOutline | null>
  >({});
  const [selections, setSelections] = useState<Record<string, HelperSelection | null>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [modelRequired, setModelRequired] = useState<Record<string, boolean>>({});
  const [busyScopes, setBusyScopes] = useState<Record<string, boolean>>({});
  const [editor, setEditor] = useState<ActiveEditorContext | null>(null);
  const [settingsOwner, setSettingsOwner] = useState<string | null>(null);
  const [discardSettingsOwner, setDiscardSettingsOwner] = useState<string | null>(null);
  const settings = props.open && !!scopeKey && settingsOwner === scopeKey;
  const discardSettings = settings && discardSettingsOwner === scopeKey;
  useEffect(() => {
    if (!props.open || settingsOwner !== scopeKey) {
      setSettingsOwner(null);
      setDiscardSettingsOwner(null);
    }
  }, [props.open, scopeKey, settingsOwner]);
  const [modelPicker, setModelPicker] = useState(false);
  const [savedModel, setSavedModel] = useState<{
    id: string | undefined;
    revision: number;
  } | null>(null);
  const [saveNotice, setSaveNotice] = useState('');
  useEffect(() => {
    if (!props.open) setModelPicker(false);
  }, [props.open]);
  const [taskHistory, setTaskHistory] = useState<{ taskId?: string } | null>(null);
  const [openTaskActivities, setOpenTaskActivities] = useState<Record<string, boolean>>({});
  const [currentActivityClosed, setCurrentActivityClosed] = useState<string | null>(null);
  const [personas, setPersonas] = useState<Record<string, { text: string; revision: number }>>({});
  const [savingPersona, setSavingPersona] = useState(false);
  const compact = (props.modal ?? false) && !props.expanded;
  const [frozenEditors, setFrozenEditors] = useState<
    Record<string, ReturnType<typeof captureActiveEditorContext>>
  >({});
  const [frozenResources, setFrozenResources] = useState<Record<string, HelperResourceRef | null>>(
    {}
  );
  const contextualOpen = useRef<{ kind: HelperScope['kind']; chatId?: string } | null>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (props.open && !wasOpen.current && !props.expanded)
      contextualOpen.current =
        props.scope.kind === 'chat'
          ? { kind: 'chat', chatId: props.scope.chatId }
          : { kind: 'library' };
    if (!props.open) contextualOpen.current = null;
    wasOpen.current = props.open;
    const origin = contextualOpen.current;
    if (
      !origin ||
      props.expanded ||
      !scopeKey ||
      !conversation ||
      conversation.scope.kind !== origin.kind ||
      (conversation.scope.kind === 'chat' && conversation.scope.chatId !== origin.chatId)
    )
      return;
    contextualOpen.current = null;
    try {
      const snapshot = captureActiveEditorContext();
      setFrozenEditors((old) => ({ ...old, [scopeKey]: snapshot }));
      if (snapshot && !props.resource) setFrozenResources((old) => ({ ...old, [scopeKey]: null }));
    } catch (cause) {
      setErrors((old) => ({
        ...old,
        [scopeKey]: cause instanceof Error ? cause.message : uiMessage('helpers.m015'),
      }));
    }
  }, [props.open, props.expanded, props.resource, props.scope, scopeKey, conversation]);
  const wasExpanded = useRef(false);
  useEffect(() => {
    if (props.expanded && !wasExpanded.current && scopeKey && conversation) {
      try {
        const attached = frozenEditors[scopeKey];
        const live = getActiveEditorContext();
        const matchingEditor =
          attached && live && attached.kind === live.kind && attached.targetId === live.targetId;
        if (scopeKey in frozenEditors && (!props.returnToSidecar || !matchingEditor)) {
          wasExpanded.current = true;
          return;
        }
        const sameScope =
          props.returnToSidecar &&
          JSON.stringify(conversation.scope) === JSON.stringify(props.scope);
        const snapshot = sameScope ? captureActiveEditorContext() : null;
        setFrozenResources((old) => ({
          ...old,
          [scopeKey]: sameScope ? (props.resource ?? null) : null,
        }));
        setFrozenEditors((old) => ({ ...old, [scopeKey]: snapshot }));
      } catch (cause) {
        setErrors((old) => ({
          ...old,
          [scopeKey]: cause instanceof Error ? cause.message : uiMessage('helpers.m015'),
        }));
      }
    }
    if (!props.expanded) wasExpanded.current = false;
    else if (scopeKey && conversation) {
      if (wasExpanded.current && !(scopeKey in frozenEditors)) {
        setFrozenEditors((old) => ({ ...old, [scopeKey]: null }));
        setFrozenResources((old) => ({ ...old, [scopeKey]: null }));
      }
      wasExpanded.current = true;
    }
  }, [
    props.expanded,
    props.returnToSidecar,
    props.resource,
    props.scope,
    scopeKey,
    conversation,
    frozenEditors,
  ]);
  const closeButton = useRef<HTMLButtonElement>(null),
    input = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef<HTMLDivElement>(null),
    content = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, { top: number; following: boolean }>());
  const following = useRef(true),
    displayedScope = useRef('');
  const prepend = useRef<{ scope: string; height: number; top: number } | null>(null);
  const editRevisions = useRef(new Map<string, number>());
  const [editConflict, setEditConflict] = useState<{
    conversationId: string;
    messageId: string;
    draft: string;
  } | null>(null);
  const locks = useRef(new Set<string>()),
    appliedSelections = useRef(new Set<string>());
  const close = useRef(props.onClose);
  close.current = props.onClose;
  const closePanel = useRef(() => props.onClose());
  const attachedEditor = frozenEditors[scopeKey];
  const matchingLiveEditor =
    !props.expanded &&
    editor &&
    attachedEditor &&
    editor.kind === attachedEditor.kind &&
    editor.targetId === attachedEditor.targetId;
  const displayEditor = matchingLiveEditor
    ? editor
    : props.expanded || scopeKey in frozenEditors
      ? attachedEditor
      : editor;
  const currentResource =
    props.expanded || scopeKey in frozenResources
      ? (frozenResources[scopeKey] ?? null)
      : (props.resource ?? null);
  const attachedResourceRequest = useRef<HelperResourceRef | null>(null);
  useEffect(() => {
    if (!props.resource || !scopeKey || attachedResourceRequest.current === props.resource) return;
    attachedResourceRequest.current = props.resource;
    setFrozenResources((old) => ({ ...old, [scopeKey]: props.resource ?? null }));
  }, [props.resource, scopeKey]);
  const draft = drafts[scopeKey] ?? local(`uimori:helper-input:${scopeKey}`) ?? '';
  const helperWorkspace = usePromptWorkspace();
  const modelRef =
    savedModel && savedModel.revision > (helperWorkspace.workspace?.revision ?? -1)
      ? savedModel
      : helperWorkspace.workspace?.helperModel;
  const attachmentModelPreset = props.library?.models.find((model) => model.id === modelRef?.id);
  const attachmentConnection = props.library?.connections.find(
    (connection) => connection.id === attachmentModelPreset?.connectionId
  );
  const attachments = useHelperAttachmentDraft(
    scopeKey,
    attachmentModelPreset && attachmentConnection
      ? { protocol: attachmentConnection.protocol, modelId: attachmentModelPreset.modelId }
      : null
  );
  const outbox = outboxes[scopeKey] === undefined ? storedOutbox(scopeKey) : outboxes[scopeKey];
  const selection =
    selections[scopeKey] === undefined ? storedSelection(scopeKey) : selections[scopeKey];
  const selectedOutline =
    outlineSelections[scopeKey] === undefined
      ? storedOutline(scopeKey)
      : outlineSelections[scopeKey];
  const busy = busyScopes[scopeKey] ?? false;
  const storedError = errors[scopeKey] || data.error || sessions.error || attachments.error;
  const error = storedError === 'helper-draft-read-failed' ? t('helpers.m012') : storedError;
  const persona =
    personas[scopeKey] ??
    (conversation
      ? { text: conversation.persona, revision: conversation.revision }
      : { text: '', revision: 0 });
  const recorded = taskHistory?.taskId
    ? tasks.filter((task) => task.id === taskHistory.taskId)
    : tasks;
  const pending = tasks.filter(active);
  const summarized = pending.find((task) => task.status === 'running') ?? pending[0];
  const liveActivity = useHelperActivity(summarized?.id, summarized?.status, props.open);
  const activityLabel =
    liveActivity.error || !liveActivity.data || !summarized
      ? undefined
      : helperActivitySummary({ ...liveActivity.data, status: summarized.status });
  const setError = (message: string) => {
    setModelRequired((old) => ({ ...old, [scopeKey]: false }));
    setErrors((old) => ({ ...old, [scopeKey]: message }));
  };
  useEffect(() => {
    if (!scopeKey) return;
    if (recoveryAttempt > 0) setErrors((old) => ({ ...old, [scopeKey]: '' }));
    let disposed = false;
    const restore = async () => {
      const keys = ['helper-input', 'helper-outbox', 'helper-selection', 'helper-outline'];
      try {
        await Promise.all(keys.map((kind) => loadHelperRecovery(`${kind}:${scopeKey}`)));
      } catch {
        if (!disposed)
          setErrors((old) => ({
            ...old,
            [scopeKey]: 'helper-draft-read-failed',
          }));
        return;
      }
      if (disposed) return;
      setDrafts((old) =>
        old[scopeKey] === undefined
          ? { ...old, [scopeKey]: local(`uimori:helper-input:${scopeKey}`) ?? '' }
          : old
      );
      setOutboxes((old) =>
        old[scopeKey] === undefined ? { ...old, [scopeKey]: storedOutbox(scopeKey) } : old
      );
      setSelections((old) =>
        old[scopeKey] === undefined ? { ...old, [scopeKey]: storedSelection(scopeKey) } : old
      );
      setOutlineSelections((old) =>
        old[scopeKey] === undefined ? { ...old, [scopeKey]: storedOutline(scopeKey) } : old
      );
      setHydrated((old) => ({ ...old, [scopeKey]: true }));
      setErrors((old) =>
        old[scopeKey] === 'helper-draft-read-failed' ? { ...old, [scopeKey]: '' } : old
      );
    };
    void restore();
    return () => {
      disposed = true;
    };
  }, [scopeKey, recoveryAttempt]);
  const editDraft = useCallback(
    (text: string) => {
      if (!scopeKey) return;
      attachments.touch();
      saveLocal(`uimori:helper-input:${scopeKey}`, text);
      setDrafts((old) => ({ ...old, [scopeKey]: text }));
    },
    [scopeKey, attachments.touch]
  );
  const setOutbox = (key: string, value: Outbox | null) => {
    setOutboxes((old) => ({ ...old, [key]: value }));
  };
  const selectSession = sessions.select;
  useEffect(() => {
    const selected = props.outlineRequest;
    if (!selected || appliedSelections.current.has(selected.key)) return;
    let disposed = false;
    void (async () => {
      const owner = selected.conversationId
        ? await api<HelperConversation>(
            `/helper/conversations/${encodeURIComponent(selected.conversationId)}`
          )
        : await api<HelperConversation>('/helper/conversations', { scope: selected.scope });
      if (disposed || appliedSelections.current.has(selected.key)) return;
      if (JSON.stringify(owner.scope) !== JSON.stringify(selected.scope))
        throw new Error(uiMessage('helpers.m013'));
      appliedSelections.current.add(selected.key);
      await loadHelperRecovery(`helper-input:${owner.id}`).catch(() => null);
      if (selected.target) {
        setSelections((old) => ({ ...old, [owner.id]: null }));
        saveLocal(`uimori:helper-selection:${owner.id}`, null);
        const value = { target: selected.target, title: selected.title, request: selected.text };
        setOutlineSelections((old) => ({ ...old, [owner.id]: value }));
        saveLocal(`uimori:helper-outline:${owner.id}`, JSON.stringify(value));
        setDrafts((old) => {
          const previous = old[owner.id] ?? local(`uimori:helper-input:${owner.id}`) ?? '';
          const next = previous.trim() ? previous : selected.text;
          saveLocal(`uimori:helper-input:${owner.id}`, next);
          return { ...old, [owner.id]: next };
        });
      }
      selectSession(owner);
    })().catch((cause) => {
      if (!disposed) setErrors((old) => ({ ...old, [currentScope.current]: cause.message }));
    });
    return () => {
      disposed = true;
    };
  }, [props.outlineRequest, selectSession]);
  const taskStamp = tasks.map((task) => `${task.id}:${task.status}`).join('|');
  useEffect(() => {
    const selected = props.draftRequest;
    if (!selected || appliedSelections.current.has(selected.key)) return;
    let disposed = false;
    void (async () => {
      const owner = selected.conversationId
        ? await api<HelperConversation>(
            `/helper/conversations/${encodeURIComponent(selected.conversationId)}`
          )
        : await api<HelperConversation>('/helper/conversations', { scope: selected.scope });
      if (disposed || appliedSelections.current.has(selected.key)) return;
      if (JSON.stringify(owner.scope) !== JSON.stringify(selected.scope))
        throw new Error(uiMessage('helpers.m013'));
      await loadHelperRecovery(`helper-input:${owner.id}`).catch(() => null);
      if (disposed) return;
      appliedSelections.current.add(selected.key);
      setDrafts((old) => {
        const previous = old[owner.id] ?? local(`uimori:helper-input:${owner.id}`) ?? '';
        const next = previous.trim() ? `${previous}\n\n${selected.text}` : selected.text;
        saveLocal(`uimori:helper-input:${owner.id}`, next);
        return { ...old, [owner.id]: next };
      });
      selectSession(owner);
    })().catch((cause) => {
      if (!disposed) setErrors((old) => ({ ...old, [currentScope.current]: cause.message }));
    });
    return () => {
      disposed = true;
    };
  }, [props.draftRequest, selectSession]);
  useEffect(() => {
    dispatchEvent(new CustomEvent(OUTLINE_REFRESH_EVENT, { detail: taskStamp }));
  }, [taskStamp]);
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
        throw new Error(uiMessage('helpers.m014'));
      const key = owner.id;
      appliedSelections.current.add(selected.key);
      await loadHelperRecovery(`helper-input:${key}`).catch(() => null);
      setOutlineSelections((old) => ({ ...old, [key]: null }));
      saveLocal(`uimori:helper-outline:${key}`, null);
      const value: HelperSelection = {
        sourceId: selected.sourceId,
        sourceHash: selected.sourceHash,
        text: selected.text,
      };
      setSelections((old) => ({ ...old, [key]: value }));
      saveLocal(`uimori:helper-selection:${key}`, JSON.stringify(value));
      setDrafts((old) => {
        const previous = old[key] ?? local(`uimori:helper-input:${key}`) ?? '';
        const text = previous.trim() ? previous : selectionRequest;
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
  useEffect(() => {
    if (!props.open) return;
    const prior = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
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
      if (owns()) history.replaceState(base, '', url);
      if (prior?.isConnected && prior.checkVisibility()) prior.focus();
    };
  }, [props.open]);
  useEffect(() => {
    if (!props.open || !compact) return;
    const background = [
      ...document.querySelectorAll<HTMLElement>(
        '.app-shell > .sidebar,.app-shell > .story-workspace'
      ),
    ];
    const original = background.map((node) => node.inert);
    background.forEach((node) => {
      node.inert = true;
    });
    return () =>
      background.forEach((node, index) => {
        node.inert = original[index];
      });
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
    else node.scrollTop = positions.current.get(scopeKey)?.top ?? node.scrollTop;
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
  async function send(
    saved?: Outbox,
    withoutStorage = false,
    steerTaskId?: string
  ): Promise<boolean> {
    if (
      props.ready === false ||
      !hydrated[scopeKey] ||
      (props.expanded && !(scopeKey in frozenEditors)) ||
      locks.current.has(scopeKey) ||
      (!saved && (!conversation || (!draft.trim() && !attachments.hasAttachments))) ||
      (!saved && (!attachments.ready || attachments.busy)) ||
      (steerTaskId && attachments.hasAttachments)
    )
      return false;
    if (!saved && outbox) return false;
    const text = saved?.text ?? draft,
      owner = scopeKey;
    if (saved && (saved.scope !== owner || saved.targetConversationId !== conversation?.id))
      return false;
    // An explicit library-card target takes precedence over another mounted editor.
    const sameScope = JSON.stringify(scope) === JSON.stringify(props.scope);
    const targeted = sameScope ? currentResource : null;
    let captured: ReturnType<typeof captureActiveEditorContext> = null;
    if (!saved && !steerTaskId && !targeted) {
      try {
        captured = matchingLiveEditor
          ? captureActiveEditorContext()
          : props.expanded || owner in frozenEditors
            ? (frozenEditors[owner] ?? null)
            : sameScope
              ? captureActiveEditorContext()
              : null;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : uiMessage('helpers.m015'));
        return false;
      }
    }
    locks.current.add(owner);
    setBusyScopes((old) => ({ ...old, [owner]: true }));
    setError('');
    data.setError('');
    let pendingRequest: Outbox | undefined;
    try {
      if (text.length > REQUEST_TEXT_MAX_CHARS)
        throw new Error(uiMessage('helpers.m016', { v0: formatNumber(REQUEST_TEXT_MAX_CHARS) }));
      if (((saved?.selection ?? selection)?.text.length ?? 0) > REQUEST_TEXT_MAX_CHARS)
        throw new Error(uiMessage('helpers.m017', { v0: formatNumber(REQUEST_TEXT_MAX_CHARS) }));
      let request = saved;
      if (!request) {
        request = {
          ...(await attachments.freeze()),
          requestKey: crypto.randomUUID(),
          text,
          scope: owner,
          targetConversationId: conversation!.id,
          ...(steerTaskId ? { steerTaskId } : {}),
          ...(!steerTaskId && targeted
            ? {
                editor: {
                  kind: targeted.kind,
                  targetId: targeted.id,
                  revision: targeted.revision,
                  title: targeted.title,
                  source: 'saved' as const,
                },
              }
            : captured
              ? { editor: captured }
              : {}),
          ...(!steerTaskId && selection ? { selection } : {}),
          ...(!steerTaskId && selectedOutline ? { outline: selectedOutline.target } : {}),
        };
      }
      setOutbox(owner, request);
      pendingRequest = request;
      if (!withoutStorage) {
        try {
          await writeHelperRecovery(`helper-outbox:${owner}`, JSON.stringify(request));
          setUnpersisted((old) => ({ ...old, [owner]: false }));
        } catch {
          setUnpersisted((old) => ({ ...old, [owner]: true }));
          throw new Error(uiMessage('helpers.m018'));
        }
      }
      const task = await api<HelperTaskView>(
        request.steerTaskId
          ? `/helper/tasks/${encodeURIComponent(request.steerTaskId)}/steer`
          : `/helper/conversations/${encodeURIComponent(request.targetConversationId)}/messages`,
        {
          requestKey: request.requestKey,
          ...(request.retryOf ? { retryOf: request.retryOf } : {}),
          text: request.text,
          ...(request.editor ? { editor: request.editor } : {}),
          ...(request.selection ? { selection: request.selection } : {}),
          ...(request.outline ? { outline: request.outline } : {}),
          ...(request.images?.length ? { images: request.images } : {}),
          ...(request.files?.length ? { files: request.files } : {}),
        }
      );
      setOutbox(owner, null);
      setUnpersisted((old) => ({ ...old, [owner]: false }));
      void clearHelperRecoveryIf(`helper-outbox:${owner}`, JSON.stringify(request)).catch(() => {});
      const sameDraft =
        !request.draftToken || helperAttachmentDraftMatches(owner, request.draftToken);
      if (!request.retryOf && request.draftToken)
        void acceptHelperAttachments(owner, request.draftToken).catch(() => {
          setErrors((old) => ({
            ...old,
            [owner]: uiMessage('helperAttachments.acceptCleanupFailed'),
          }));
        });
      if (!request.retryOf && sameDraft)
        setDrafts((old) => {
          const existing = old[owner] ?? local(`uimori:helper-input:${owner}`) ?? '';
          if (existing !== text) return old;
          void clearHelperRecoveryIf(`helper-input:${owner}`, text).catch(() => {});
          return { ...old, [owner]: '' };
        });
      setSelections((old) => {
        const existing = old[owner] === undefined ? storedSelection(owner) : old[owner];
        if (JSON.stringify(existing ?? null) !== JSON.stringify(request.selection ?? null))
          return old;
        if (existing)
          void clearHelperRecoveryIf(`helper-selection:${owner}`, JSON.stringify(existing)).catch(
            () => {}
          );
        return { ...old, [owner]: null };
      });
      setOutlineSelections((old) => {
        const existing = old[owner] === undefined ? storedOutline(owner) : old[owner];
        if (JSON.stringify(existing?.target ?? null) !== JSON.stringify(request.outline ?? null))
          return old;
        if (existing)
          void clearHelperRecoveryIf(`helper-outline:${owner}`, JSON.stringify(existing)).catch(
            () => {}
          );
        return { ...old, [owner]: null };
      });
      data.updateTask(task);
      if (currentScope.current === owner) following.current = true;
      if (conversation)
        void data.refresh(conversation).catch((cause) => {
          setErrors((old) => ({
            ...old,
            [owner]: uiMessage('helpers.m019', { v0: messageRef(cause.message) }),
          }));
        });
      return true;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status < 500 && ![408, 429].includes(cause.status)) {
        setOutbox(owner, null);
        if (pendingRequest)
          void clearHelperRecoveryIf(
            `helper-outbox:${owner}`,
            JSON.stringify(pendingRequest)
          ).catch(() => {});
      }
      setModelRequired((old) => ({
        ...old,
        [owner]: cause instanceof ApiError && cause.code?.startsWith('MODEL_REQUIRED:') === true,
      }));
      setErrors((old) => ({
        ...old,
        [owner]: cause instanceof Error ? cause.message : uiMessage('helpers.m020'),
      }));
      return false;
    } finally {
      locks.current.delete(owner);
      setBusyScopes((old) => ({ ...old, [owner]: false }));
    }
  }
  async function mutateMessage(
    messageId: string,
    mutation: { text: string } | { scope: HelperDeleteScope },
    expectedRevision = conversation?.revision
  ): Promise<boolean> {
    if (
      !conversation ||
      expectedRevision === undefined ||
      busy ||
      outbox ||
      pending.length ||
      locks.current.has(scopeKey)
    )
      return false;
    const owner = conversation.id;
    locks.current.add(owner);
    setBusyScopes((old) => ({ ...old, [owner]: true }));
    setErrors((old) => ({ ...old, [owner]: '' }));
    try {
      const result = await api<HelperMessageMutation>(
        `/helper/conversations/${encodeURIComponent(owner)}/messages/${encodeURIComponent(messageId)}`,
        { expectedRevision, ...mutation },
        'text' in mutation ? 'PATCH' : 'DELETE'
      );
      data.applyMessageMutation(result);
      return true;
    } catch (cause) {
      if ('text' in mutation && cause instanceof ApiError && cause.status === 409) {
        if (currentScope.current === owner)
          setEditConflict({ conversationId: owner, messageId, draft: mutation.text });
        return false;
      }
      setErrors((old) => ({
        ...old,
        [owner]: cause instanceof Error ? cause.message : uiMessage('helpers.m207'),
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
      setError(cause instanceof Error ? cause.message : uiMessage('helpers.m021'));
    }
  }
  async function retry(
    task: HelperTaskView,
    text = messages.find((message) => message.taskId === task.id && message.role === 'user')
      ?.text ?? task.request
  ) {
    if (props.ready === false || !conversation || outbox || busy || locks.current.has(scopeKey))
      return false;
    if (task.completedEffects?.count) {
      setError(uiMessage('helpers.m022'));
      return false;
    }
    const request: Outbox = {
      requestKey: crypto.randomUUID(),
      text,
      scope: scopeKey,
      targetConversationId: conversation.id,
      retryOf: task.id,
    };
    return send(request);
  }
  const taskStatus = (task: HelperTaskView) => (
    <div className="helper-task" data-task-id={task.id}>
      <TurnStatus
        key={`${task.id}:${active(task) ? 'active' : 'settled'}`}
        tone={tone(task)}
        text={
          (task.id === summarized?.id ? activityLabel : undefined) ??
          t(statusLabel[task.status] ?? task.status)
        }
        elapsed={
          active(task) ? (
            <HelperTaskElapsed task={task} visible={props.open} />
          ) : (
            taskElapsed(task, Date.now())
          )
        }
        badges={
          task.id === summarized?.id && pending.length > 1 ? (
            <span className="activity-count">
              {t('helpers.m329', { count: formatNumber(pending.length - 1) })}
            </span>
          ) : undefined
        }
        storageKey={activityKey(task)}
        onOpenChange={(open) => setOpenTaskActivities((old) => ({ ...old, [task.id]: open }))}
        dataProps={{ 'data-testid': 'helper-task-activity', 'data-task-id': task.id }}
      >
        <div className="helper-task-meta ui-meta-row">
          <span>{t('helpers.m310', { model: task.modelTitle ?? t('helpers.m026') })}</span>
          <span>
            {t('helpers.m311', {
              calls: formatNumber(task.usage.modelCalls),
              input:
                task.usage.inputTokens == null
                  ? t('helpers.m026')
                  : formatNumber(task.usage.inputTokens),
              output:
                task.usage.outputTokens == null
                  ? t('helpers.m026')
                  : formatNumber(task.usage.outputTokens),
            })}
          </span>
        </div>
        {task.error && (
          <p className="error">{requestFileError(task.error) ?? translateMessage(task.error)}</p>
        )}
        {task.completedEffects && (
          <p>
            {t('helpers.m312', {
              labels: task.completedEffects.labels.map(translateMessage).join(', '),
            })}
          </p>
        )}
        <HelperActivityDetails
          inline
          taskId={task.id}
          status={task.status}
          visible={props.open && (openTaskActivities[task.id] ?? savedActivityOpen(task))}
          source={task.id === summarized?.id ? liveActivity : undefined}
        />
        {active(task) && (
          <div className="form-actions">
            <button type="button" className="secondary" onClick={() => void cancel(task)}>
              {task.status === 'queued' ? t('helpers.m030') : t('helpers.m031')}
            </button>
          </div>
        )}
      </TurnStatus>
      {task.instructions?.map((instruction) => (
        <div className="helper-instruction" key={instruction.id} data-testid="helper-instruction">
          <small role="status">{t('helpers.m335', { status: instruction.status })}</small>
          <p>{instruction.text}</p>
          {(instruction.status === 'not-delivered' || instruction.status === 'unconfirmed') && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                editDraft(draft.trim() ? `${draft}\n\n${instruction.text}` : instruction.text);
                input.current?.focus();
              }}
            >
              {t('helpers.m037')}
            </button>
          )}
        </div>
      ))}
      {!answered.has(task.id) && (
        <div className="run-outcome">
          <ResponseDisplay
            mode={props.responseDisplay}
            taskKind="helper"
            taskId={task.id}
            taskStatus={task.status}
            visible={props.open}
          />
        </div>
      )}
      {!active(task) && task.status !== 'completed' && (
        <>
          {task.completedEffects && (
            <p role="status" data-testid="helper-completed-effects">
              {t('helpers.m313', { count: formatNumber(task.completedEffects.count) })}
            </p>
          )}
          <RetryFailure
            status={task.status}
            error={requestFileError(task.error) ?? translateMessage(task.error ?? '')}
            disabled={busy || Boolean(outbox)}
            onRetry={task.completedEffects ? undefined : () => void retry(task)}
            onSettings={props.onModelSettings}
            onDetails={() => setTaskHistory({ taskId: task.id })}
            onHistory={() => setTaskHistory({})}
          />
        </>
      )}
    </div>
  );
  const confirmedModel =
    savedModel && savedModel.revision > props.modelRevision ? savedModel : null;
  const savedModelPreset = props.library?.models.find((model) => model.id === confirmedModel?.id);
  const modelDescription = confirmedModel
    ? savedModelPreset
      ? modelLabel(savedModelPreset, props.library)
      : confirmedModel.id
        ? t('main.m011')
        : t('helpers.modelPickerNone')
    : props.modelDescription;
  const modelChip = (
    <button
      type="button"
      className="model-chip secondary helper-model-chip"
      aria-haspopup="dialog"
      aria-expanded={modelPicker}
      aria-label={t('helpers.m049', { v0: modelDescription })}
      title={t('helpers.modelPickerScope')}
      disabled={!props.library}
      onClick={() => setModelPicker(true)}
    >
      <span>
        {confirmedModel ? (savedModelPreset?.title ?? modelDescription) : props.modelTitle}
      </span>
      <ChevronDown size={14} aria-hidden="true" />
    </button>
  );
  return (
    <aside
      id="helper-panel"
      className={`helper-panel${props.expanded ? ' helper-expanded' : ''}${props.expanded && props.navigationHost ? ' helper-has-navigation' : ''}`}
      hidden={!props.open}
      role={props.expanded ? 'main' : compact ? 'dialog' : undefined}
      aria-modal={compact && props.open ? true : undefined}
      aria-label={t(props.expanded ? 'main.m062' : 'helpers.m040')}
      onKeyDown={(event) => {
        if (event.target instanceof Element && event.target.closest('dialog[open]')) return;
        if (event.key === 'Escape' && !props.expanded) {
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
        {props.navigationLeading}
        <h2 className="sr-only">
          {props.expanded
            ? t('main.m062')
            : scope.kind === 'chat'
              ? t('helpers.chatTitle')
              : t('helpers.libraryTitle')}
        </h2>
        <HelperSessionBar
          navigationActions={props.navigationActions}
          searchRequest={props.searchRequest}
          open={props.open && props.ready !== false}
          sessions={sessions.sessions}
          unread={sessions.unread}
          conversation={conversation}
          currentId={sessions.currentId}
          creating={sessions.creating || props.ready === false}
          busy={props.ready === false || busy || Boolean(outbox)}
          expanded={props.expanded}
          navigationHost={props.navigationHost}
          onSettings={() => setSettingsOwner(scopeKey)}
          onSelect={(session) => {
            if (props.expanded && session.id !== scopeKey) {
              setFrozenEditors((old) => (session.id in old ? old : { ...old, [session.id]: null }));
              setFrozenResources((old) =>
                session.id in old ? old : { ...old, [session.id]: null }
              );
            }
            sessions.select(session);
            props.onSelectConversation?.();
          }}
          onCreate={(projectId) => {
            void sessions.create(projectId).then((session) => {
              if (props.expanded && session) {
                setFrozenEditors((old) => ({ ...old, [session.id]: null }));
                setFrozenResources((old) => ({ ...old, [session.id]: null }));
              }
            });
          }}
          onAcknowledge={(ids) => void sessions.acknowledge(ids)}
          onProjectsChanged={() => void sessions.reload()}
          onUpdate={(value) => {
            sessions.update(value);
            if (value.id === sessions.currentId) data.updateConversation(value);
          }}
          onDelete={(id) => sessions.remove(id)}
          onClone={(session) => {
            if (props.expanded) {
              setFrozenEditors((old) => ({ ...old, [session.id]: null }));
              setFrozenResources((old) => ({ ...old, [session.id]: null }));
            }
            sessions.select(session);
            props.onSelectConversation?.();
          }}
        />
        {props.onToggleExpanded && (
          <IconButton
            label={
              props.expanded
                ? (props.returnLabel ?? t('helpers.returnToPrevious'))
                : t('helpers.expand')
            }
            icon={props.expanded ? ArrowLeft : Maximize2}
            onClick={() => {
              if (props.expanded && !props.returnToSidecar) closePanel.current();
              else props.onToggleExpanded?.();
            }}
          />
        )}
        {!props.expanded && (
          <button
            ref={closeButton}
            type="button"
            className="icon-button"
            aria-label={t('helpers.m045')}
            onClick={() => closePanel.current()}
          >
            <X size={20} />
          </button>
        )}
      </header>
      {props.library && (
        <HelperModelPicker
          open={modelPicker && props.open}
          library={props.library}
          onClose={() => setModelPicker(false)}
          onManage={() => {
            setModelPicker(false);
            props.onModelSettings();
          }}
          onSaved={(workspace) =>
            setSavedModel((old) =>
              old && old.revision > workspace.revision
                ? old
                : { id: workspace.helperModel?.id, revision: workspace.revision }
            )
          }
        />
      )}
      <TransientNotice message={saveNotice} />
      {props.outlineWorkspace && (
        <div className="outline-helper-return">
          <button
            type="button"
            className="secondary"
            onClick={() => {
              closePanel.current();
            }}
          >
            {t('helpers.m046')}
          </button>
        </div>
      )}
      <Dialog
        open={settings && !!conversation && props.open}
        title={t('helpers.settings')}
        className="helper-settings"
        onClose={() => {
          if (savingPersona) return;
          if (conversation && persona.text !== conversation.persona)
            setDiscardSettingsOwner(scopeKey);
          else setSettingsOwner(null);
        }}
      >
        {conversation && (
          <>
            <div className="helper-settings-body">
              <section className="settings-group">
                <header className="settings-group-heading">
                  <h3>{t('helpers.sessionVoice')}</h3>
                </header>
                <div className="settings-group-body helper-persona">
                  <textarea
                    aria-label={t('helpers.m051')}
                    value={persona.text}
                    maxLength={HELPER_PERSONA_MAX_CHARS}
                    onChange={(event) =>
                      setPersonas((old) => ({
                        ...old,
                        [scopeKey]: { ...persona, text: event.target.value },
                      }))
                    }
                    placeholder={t('helpers.m053')}
                  />
                </div>
              </section>
              {persona.revision !== conversation.revision && (
                <p role="alert">
                  {t('helpers.m055')}{' '}
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
                    {t('helpers.m056')}
                  </button>
                </p>
              )}

              {error && <NoticeBanner tone="error">{translateMessage(error)}</NoticeBanner>}
            </div>
            <div className="helper-settings-actions">
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  setPersonas((old) => ({
                    ...old,
                    [scopeKey]: { ...persona, text: UI_HELPER_PERSONA },
                  }))
                }
              >
                {t('helpers.m057')}
              </button>
              <SaveButton
                type="button"
                label={t('helpers.m058')}
                aria-busy={savingPersona}
                disabled={
                  props.ready === false ||
                  savingPersona ||
                  persona.revision !== conversation.revision
                }
                onClick={() => {
                  if (props.ready === false) return;
                  setSavingPersona(true);
                  setSaveNotice('');
                  void api<HelperConversation>(
                    `/helper/conversations/${conversation.id}`,
                    {
                      expectedRevision: persona.revision,
                      persona: persona.text,
                    },
                    'PATCH'
                  )
                    .then((value) => {
                      setSaveNotice(uiMessage('helpers.toneSaved'));
                      data.updateConversation(value);
                      setPersonas((old) => ({
                        ...old,
                        [scopeKey]: {
                          text: value.persona,
                          revision: value.revision,
                        },
                      }));
                    })
                    .catch(async (cause) => {
                      setError(cause.message);
                      if (cause instanceof ApiError && cause.status === 409) {
                        try {
                          data.updateConversation(
                            await api<HelperConversation>(
                              `/helper/conversations/${conversation.id}`
                            )
                          );
                        } catch {
                          /* Keep the local settings draft. */
                        }
                      }
                    })
                    .finally(() => setSavingPersona(false));
                }}
              />
            </div>
          </>
        )}
      </Dialog>
      <Dialog
        open={discardSettings && settings && props.open}
        title={t('helpers.settings')}
        role="alertdialog"
        variant="confirmation"
        onClose={() => setDiscardSettingsOwner(null)}
      >
        <p>{t('helpers.discardTone')}</p>
        <DraftDiscardActions
          open={discardSettings}
          onContinue={() => setDiscardSettingsOwner(null)}
          onDiscard={() => {
            setPersonas((old) => {
              const next = { ...old };
              delete next[scopeKey];
              return next;
            });
            setDiscardSettingsOwner(null);
            setSettingsOwner(null);
          }}
          discardLabel={t('visualpanels.discardChangesAndClose')}
        />
      </Dialog>
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
        <div
          ref={content}
          className={`helper-thread-content${messages.length === 0 ? ' helper-thread-empty' : ''}`}
        >
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
              {t('helpers.m060')}
            </button>
          )}
          {data.loading ? (
            <LoadingState
              presentation={messages.length ? 'inline' : 'region'}
              loading={!data.error}
              error={data.error}
              label={t('helpers.m061')}
            />
          ) : null}
          {conversation &&
            messages.map((message) => {
              const task = taskMap.get(message.taskId);
              const status = task?.status ?? message.taskStatus;
              const messageDisabled = busy || Boolean(outbox) || pending.length > 0;
              const saveMessage = (
                text: string,
                revision = editRevisions.current.get(message.id) ?? conversation.revision
              ) => mutateMessage(message.id, { text }, revision);
              const deleteMessage = (deleteScope: HelperDeleteScope, revision: number) =>
                mutateMessage(message.id, { scope: deleteScope }, revision);
              const response = (
                <HelperResponseEditor
                  id={message.id}
                  text={message.text}
                  disabled={messageDisabled}
                  revision={conversation.revision}
                  onSave={saveMessage}
                  onEditingChange={(editing) => {
                    if (editing) editRevisions.current.set(message.id, conversation.revision);
                    else editRevisions.current.delete(message.id);
                  }}
                  onDelete={deleteMessage}
                  copy={<HelperResponseActions text={message.text} />}
                />
              );
              return (
                <article
                  key={message.id}
                  className={`helper-message ${message.role === 'user' ? 'request' : message.role}`}
                  data-message-id={message.id}
                  data-task-id={message.taskId}
                >
                  {message.role === 'user' ? (
                    <RequestMessage
                      runId={message.taskId}
                      request={message.text}
                      images={message.images}
                      maxLength={REQUEST_TEXT_MAX_CHARS}
                      saveHint=""
                      disabled={messageDisabled}
                      onSave={saveMessage}
                      onEditingChange={(editing) => {
                        if (editing) editRevisions.current.set(message.id, conversation.revision);
                        else editRevisions.current.delete(message.id);
                      }}
                      menuActions={
                        <HelperDeleteActions
                          disabled={messageDisabled}
                          revision={conversation.revision}
                          onDelete={deleteMessage}
                        />
                      }
                    />
                  ) : props.responseDisplay === 'complete' && status !== 'completed' ? (
                    status && !['queued', 'running'].includes(status) ? (
                      <PartialResponse>{response}</PartialResponse>
                    ) : null
                  ) : (
                    response
                  )}
                  {message.role === 'user' && <HelperStoredFiles files={message.files} />}
                  {message.artifacts.map((artifact) => (
                    <HelperArtifactCard
                      conversationId={conversation.id}
                      key={`${artifact.id}:${artifact.revision}`}
                      {...artifact}
                    />
                  ))}
                  {task && (message.role === 'assistant' || !answered.has(task.id)) && (
                    <HelperTaskResults
                      taskId={task.id}
                      status={task.status}
                      visible={props.open}
                      onOpenTarget={props.onOpenTarget}
                    />
                  )}
                  {message.role === 'user' &&
                    taskMap.get(message.taskId) &&
                    !answered.has(message.taskId) &&
                    taskStatus(taskMap.get(message.taskId)!)}
                  {message.role === 'assistant' && task && taskStatus(task)}
                </article>
              );
            })}
        </div>
      </div>
      <SaveConflictDialog
        open={props.open && editConflict?.conversationId === scopeKey}
        title={t('helpers.messageConflict')}
        onClose={() => setEditConflict(null)}
        readSaved={async () => {
          if (!editConflict) throw new Error(t('shared.savedFailure'));
          await data.refresh({ id: editConflict.conversationId });
          const view = data.readCurrent(editConflict.conversationId);
          const saved = view?.messages.find((message) => message.id === editConflict.messageId);
          if (!view) throw new Error(t('shared.savedFailure'));
          if (!saved)
            return {
              content: (
                <>
                  <p>{t('helpers.messageMissing')}</p>
                  <label>
                    {t('helpers.messageDraft')}
                    <textarea readOnly value={editConflict.draft} rows={5} />
                  </label>
                </>
              ),
            };
          const revision = view.conversation.revision;
          return {
            content: (
              <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{saved.text}</p>
            ),
            actions: (
              <>
                <button type="button" className="secondary" onClick={() => setEditConflict(null)}>
                  {t('shared.keepInput')}
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    editRevisions.current.set(editConflict.messageId, revision);
                    setEditConflict(null);
                  }}
                >
                  {t('helpers.continueMessageEdit')}
                </button>
              </>
            ),
          };
        }}
      />
      <Dialog
        open={!!taskHistory}
        title={t('helpers.m064')}
        className="helper-task-history"
        scopeKey={taskHistory?.taskId ?? 'all'}
        onClose={() => setTaskHistory(null)}
      >
        {taskHistory?.taskId && (
          <div className="activity-notification-toolbar">
            <button type="button" className="secondary" onClick={() => setTaskHistory({})}>
              {t('helpers.m066')}
            </button>
          </div>
        )}
        <ul className="activity-notification-items">
          {recorded.map((task) => (
            <li key={task.id} data-testid="helper-task-record" data-task-id={task.id}>
              <div className="activity-notification-heading">
                <div>
                  <strong>{t(statusLabel[task.status] ?? task.status)}</strong>
                  <small className="ui-meta-row">
                    <time dateTime={task.createdAt}>
                      {formatDate(new Date(task.createdAt), {
                        dateStyle: 'medium',
                        timeStyle: 'medium',
                      })}
                    </time>
                    <span>
                      {t('helpers.m310', { model: task.modelTitle ?? t('helpers.m026') })}
                    </span>
                    <span>{t('helpers.m314', { count: formatNumber(task.usage.modelCalls) })}</span>
                    <HelperTaskElapsed task={task} visible={props.open && !!taskHistory} />
                  </small>
                </div>
              </div>
              {task.request.length > 240 || task.request.split(/\r\n|\r|\n/u).length > 4 ? (
                <details className="task-request-disclosure">
                  <summary aria-label={t('helpers.historyFullRequest')}>
                    <span className="task-request-preview">
                      {task.request
                        .slice(0, 180)
                        .split(/\r\n|\r|\n/u)
                        .slice(0, 3)
                        .join('\n')}
                      …
                    </span>
                    <span className="task-request-toggle">
                      <ChevronDown size={14} aria-hidden="true" />
                      {t('helpers.historyFullRequest')}
                    </span>
                  </summary>
                  <p className="task-request">{task.request}</p>
                </details>
              ) : (
                <p className="task-request">{task.request}</p>
              )}
              {messages.some((message) => message.taskId === task.id) && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setTaskHistory(null);
                    requestAnimationFrame(() => {
                      const node = [
                        ...(content.current?.querySelectorAll<HTMLElement>('[data-task-id]') ?? []),
                      ].find((item) => item.dataset.taskId === task.id);
                      if (node) {
                        following.current = false;
                        node.scrollIntoView({ block: 'center' });
                      }
                    });
                  }}
                >
                  {t('helpers.showInConversation')}
                </button>
              )}
              {task.error && (
                <p className="error">
                  {requestFileError(task.error) ?? translateMessage(task.error)}
                </p>
              )}
              {task.completedEffects && (
                <p>
                  {t('helpers.m315', {
                    count: formatNumber(task.completedEffects.count),
                    labels: task.completedEffects.labels.map(translateMessage).join(', '),
                  })}
                </p>
              )}
              <HelperActivityDetails
                taskId={task.id}
                status={task.status}
                visible={props.open && !!taskHistory}
                source={task.id === summarized?.id ? liveActivity : undefined}
              />
            </li>
          ))}
        </ul>
        {!recorded.length && <p role="status">{t('helpers.m071')}</p>}
        {!taskHistory?.taskId && data.current?.hasOlderTasks && (
          <button
            type="button"
            className="secondary"
            disabled={data.loadingEarlier}
            onClick={() => void data.earlier('tasks')}
          >
            {t('helpers.m072')}
          </button>
        )}
      </Dialog>
      <Dialog
        open={
          props.open &&
          !!outboxDecision &&
          outboxDecision.scope === scopeKey &&
          outboxDecision.requestKey === outbox?.requestKey
        }
        title={unpersisted[scopeKey] ? t('helpers.m073') : t('helpers.m074')}
        variant="confirmation"
        onClose={() => setOutboxDecision(null)}
      >
        <p>{unpersisted[scopeKey] ? t('helpers.m075') : t('helpers.m076')}</p>
        <p>{t('helpers.m077')}</p>
        <div className="form-actions">
          <button type="button" className="secondary" onClick={() => setOutboxDecision(null)}>
            {t('helpers.m078')}
          </button>
          {unpersisted[scopeKey] && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                if (!outboxDecision) return;
                const request = outboxDecision;
                setOutboxDecision(null);
                void send(request, true);
              }}
            >
              {t('helpers.m079')}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              if (!outboxDecision) return;
              const request = outboxDecision;
              setOutboxDecision(null);
              void send(request);
            }}
          >
            {unpersisted[scopeKey] ? t('helpers.m080') : t('helpers.m081')}
          </button>
        </div>
      </Dialog>
      <footer className="helper-composer">
        {summarized && (
          <>
            <ActivityBar
              tone={tone(summarized)}
              issue={attention(summarized)}
              label={activityLabel ?? t(statusLabel[summarized.status] ?? summarized.status)}
              elapsed={<HelperTaskElapsed task={summarized} visible={props.open} />}
              extra={pending.length - 1}
              expanded={currentActivityClosed !== summarized.id}
              collapsed={currentActivityClosed === summarized.id}
              toggleLabel={t('helperConversation.activity')}
              toggleTitle={t('helperConversation.activity')}
              onToggle={() =>
                setCurrentActivityClosed((old) => (old === summarized.id ? null : summarized.id))
              }
              onDetails={() => setTaskHistory({ taskId: summarized.id })}
              testId="helper-current-activity"
            />
            {currentActivityClosed !== summarized.id && (
              <div className="helper-current-activity-details">
                <HelperActivityDetails
                  inline
                  taskId={summarized.id}
                  status={summarized.status}
                  visible={props.open}
                  source={liveActivity}
                />
              </div>
            )}
          </>
        )}
        {conversation && data.current?.lastResourceEdit && (
          <HelperResourceUndo
            key={`${conversation.id}:${data.current.lastResourceEdit.editSeq}`}
            conversationId={conversation.id}
            edit={data.current.lastResourceEdit}
            disabled={props.ready === false || tasks.some(active) || busy || !!outbox}
            refresh={() => data.refresh(conversation)}
          />
        )}
        {outbox && !busy && (
          <div className="helper-outbox" role="status">
            <p>{unpersisted[scopeKey] ? t('helpers.m094') : t('helpers.m095')}</p>
            <button
              type="button"
              className="secondary"
              disabled={
                props.ready === false ||
                !hydrated[scopeKey] ||
                !conversation ||
                conversation.id !== outbox.targetConversationId
              }
              onClick={() => setOutboxDecision(outbox)}
            >
              {t('helpers.m096')}
            </button>
          </div>
        )}
        {error && (
          <NoticeBanner
            tone="error"
            className="helper-notice"
            actions={
              <>
                {modelRequired[scopeKey] && (
                  <button
                    type="button"
                    className="secondary helper-notice-lead"
                    onClick={props.onModelSettings}
                  >
                    <SettingsIcon size={18} aria-hidden="true" />
                    {t('helpers.m101')}{' '}
                  </button>
                )}
                {(!hydrated[scopeKey] || !attachments.ready) && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setRecoveryAttempt((old) => old + 1);
                      void attachments.retry();
                    }}
                  >
                    {t('helpers.m102')}
                  </button>
                )}
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setError('');
                    data.setError('');
                    sessions.clearError();
                    attachments.clearError();
                  }}
                >
                  <CloseIcon size={18} aria-hidden="true" />
                  {t('helpers.m078')}
                </button>
              </>
            }
          >
            {translateMessage(error)}
          </NoticeBanner>
        )}
        <ChatComposer
          className="helper-request-composer"
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes('Files')) event.preventDefault();
          }}
          onDrop={(event) => {
            if (!event.dataTransfer.files.length) return;
            event.preventDefault();
            if (props.ready !== false && conversation && !busy)
              void attachments.addFiles(Array.from(event.dataTransfer.files));
          }}
          onSubmit={(event) => {
            event.preventDefault();
            if (outbox) setOutboxDecision(outbox);
            else void send();
          }}
        >
          <HelperDraftAttachments
            draft={attachments.draft}
            remove={attachments.remove}
            disabled={busy || attachments.busy}
          />
          {(currentResource ||
            (displayEditor && !currentResource) ||
            selectedOutline ||
            selection) && (
            <div className="composer-request-chips helper-context-chips">
              {currentResource && JSON.stringify(scope) === JSON.stringify(props.scope) && (
                <div className="helper-context-chip helper-editor">
                  <span className="helper-chip-label">
                    {t('helpers.m316', { title: currentResource.title })}
                  </span>
                  <button
                    type="button"
                    className="helper-chip-dismiss"
                    aria-label={t('helpers.m083')}
                    onClick={() => {
                      setFrozenResources((old) => ({ ...old, [scopeKey]: null }));
                      props.onClearResource?.();
                    }}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
              )}
              {displayEditor && !currentResource && (
                <details className="helper-context-chip helper-editor">
                  <summary>
                    {t('helpers.m317', { title: displayEditor.title || t('helpers.m085') })}
                  </summary>
                  <pre>{JSON.stringify(displayEditor.model, null, 2)}</pre>
                </details>
              )}
              {selectedOutline && (
                <div className="helper-context-chip helper-outline-selection">
                  <span className="helper-chip-badge">
                    {selectedOutline.target.purpose === 'review'
                      ? t('helpers.m086')
                      : t('helpers.m087')}
                  </span>
                  <span className="helper-chip-label">{selectedOutline.title}</span>
                  {draft !== selectedOutline.request && (
                    <button
                      type="button"
                      className="helper-chip-action"
                      onClick={() =>
                        editDraft(
                          draft.trim()
                            ? `${draft}\n\n${selectedOutline.request}`
                            : selectedOutline.request
                        )
                      }
                    >
                      {t('helpers.m090')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="helper-chip-dismiss"
                    aria-label={t('helpers.m083')}
                    onClick={() => {
                      setOutlineSelections((old) => ({ ...old, [scopeKey]: null }));
                      saveLocal(`uimori:helper-outline:${scopeKey}`, null);
                      if (draft === selectedOutline.request) editDraft('');
                    }}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
              )}
              {selection && (
                <div className="helper-context-chip helper-selection">
                  <details>
                    <summary>
                      {t('helpers.m318', { count: formatNumber(selection.text.length) })}
                    </summary>
                    <p>{selection.text}</p>
                  </details>
                  <button
                    type="button"
                    className="helper-chip-dismiss"
                    aria-label={t('helpers.m093')}
                    onClick={() => {
                      if (draft === selectionRequest) editDraft('');
                      setSelections((old) => ({ ...old, [scopeKey]: null }));
                      saveLocal(`uimori:helper-selection:${scopeKey}`, null);
                    }}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
              )}
            </div>
          )}
          <ComposerInput
            inputRef={input}
            enterSend={props.enterSend}
            aria-label={t('helpers.m103')}
            value={draft}
            disabled={props.ready === false || !conversation || !attachments.ready}
            placeholder={t('helpers.m104')}
            maxLength={REQUEST_TEXT_MAX_CHARS}
            onChange={(event) => editDraft(event.target.value)}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (!files.length) return;
              event.preventDefault();
              if (!busy) void attachments.addFiles(files);
            }}
            onSend={() => {
              if (outbox) setOutboxDecision(outbox);
              else void send();
            }}
          />
          <div className="quick-controls">
            <HelperAttachmentPicker
              accept={attachments.accept}
              disabled={
                props.ready === false ||
                !conversation ||
                !attachments.ready ||
                busy ||
                attachments.busy
              }
              addFiles={attachments.addFiles}
            />
            {modelChip}
            <IconButton
              label={t('helpers.m106')}
              icon={History}
              onClick={() => setTaskHistory({})}
            />
            {running && draft.trim() && !attachments.hasAttachments && (
              <button
                type="button"
                className="secondary helper-steer"
                disabled={
                  props.ready === false ||
                  !hydrated[scopeKey] ||
                  busy ||
                  data.loading ||
                  Boolean(outbox)
                }
                title={t('helpers.m107')}
                onClick={() => void send(undefined, false, running.id)}
              >
                {t('helpers.m108')}
              </button>
            )}
            {running && (draft.trim() || attachments.hasAttachments || outbox) && (
              <IconButton
                label={t('helpers.m031')}
                icon={Square}
                onClick={() => void cancel(running)}
              />
            )}
          </div>
          {running && !draft.trim() && !attachments.hasAttachments && !outbox ? (
            <button
              className="send-button"
              type="button"
              aria-label={t('helpers.m031')}
              onClick={() => void cancel(running)}
            >
              <Square size={18} />
            </button>
          ) : (
            <button
              className="send-button"
              type="submit"
              aria-label={
                outbox ? t('helpers.m109') : running ? t('helpers.queueRequest') : t('helpers.m110')
              }
              title={
                outbox ? t('helpers.m096') : running ? t('helpers.queueRequest') : t('helpers.m110')
              }
              disabled={
                props.ready === false ||
                !hydrated[scopeKey] ||
                busy ||
                data.loading ||
                !attachments.ready ||
                attachments.busy ||
                !conversation ||
                (!draft.trim() && !attachments.hasAttachments && !outbox)
              }
            >
              <ArrowUp size={20} />
              {running && !outbox && (
                <span className="helper-queue-label">{t('helpers.queueRequest')}</span>
              )}
            </button>
          )}
        </ChatComposer>
      </footer>
    </aside>
  );
}
