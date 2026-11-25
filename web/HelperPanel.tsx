import {
  t,
  useI18n,
  translateMessage,
  formatNumber,
  messageRef,
  message as uiMessage,
} from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { usageCompact } from './usage-display.js';
import { OUTLINE_REFRESH_EVENT, type OutlineHelperRequest } from './outline-helper.js';
import type { OutlineTarget } from '../core/outline.js';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type MutableRefObject,
} from 'react';
import {
  ArrowUp,
  Check,
  Copy,
  CornerDownRight,
  History,
  ListEnd,
  Square,
  X,
  Maximize2,
  Minimize2,
  ListChecks,
  MessageCircle,
  PenLine,
  Play,
} from 'lucide-react';
import { SettingsIcon, CloseIcon, LibraryIcon } from './ui-icons.js';
import type { Library } from '../core/product.js';
import {
  MAX_HELPER_REFERENCES,
  type HelperChangeAnchor,
  type HelperCompactionStart,
  type HelperContextReference,
  type HelperConversation,
  type HelperMessageMutation,
  type HelperEditor,
  type HelperMode,
  type HelperReferencePointer,
  type HelperResourceRef,
  type HelperScope,
  type HelperSelection,
} from '../core/helper.js';
import { HELPER_PERSONA_MAX_CHARS, REQUEST_TEXT_MAX_CHARS } from '../core/content-limits.js';
import { UI_HELPER_PERSONA } from './helper-persona.js';
import { api, ApiError } from './api.js';
import { RetryFailure } from './RetryFailure.js';
import { RequestMessage } from './RequestMessage.js';
import { NoticeBanner } from './NoticeBanner.js';
import { HelperActivityDetails, HelperLiveActivity, useHelperActivity } from './HelperActivity.js';
import { helperTaskError } from './helper-task-error.js';
import { HelperTaskHistory } from './HelperTaskHistory.js';
import { helperActivitySummary } from './helper-activity.js';
import { Dialog } from './Dialog.js';
import { DraftDiscardActions } from './DraftDiscardActions.js';
import { elapsedLabel } from './ActivityStatus.js';
import { TurnStatus, type StatusTone } from './TurnStatus.js';
import { ActivityBar } from './ActivityBar.js';
import { ChatComposer, ComposerInput, isApplePlatform, sendKeyLabel } from './ChatComposer.js';
import { IconButton } from './IconButton.js';
import { PartialResponse, ResponseDisplay } from './StreamingResponse.js';
import {
  readPresentationChoice,
  writePresentationSetting,
  type ResponseDisplayMode,
} from './presentation-settings.js';
import { HelperArtifactCard } from './HelperArtifactCard.js';
import { HelperTaskResults } from './HelperTaskResults.js';
import { HelperPlanCard } from './HelperPlanCard.js';
import {
  declinedHelperConfirmations,
  type HelperConfirmationGrant,
  type HelperConfirmationTarget,
} from './HelperConfirmations.js';
import { HelperContextUsage } from './HelperContextUsage.js';
import { HelperSummaryDialog, type HelperSummaryDraft } from './HelperSummaryDialog.js';
import {
  HelperMentionMenu,
  helperReferenceKindLabel,
  helperReferenceLabel,
} from './HelperMentionMenu.js';
import {
  applyMentionReplacement,
  findMentionTrigger,
  referenceKey,
  type MentionTrigger,
} from './helper-mentions.js';
import {
  HelperDeleteActions,
  HelperResponseEditor,
  type HelperDeleteScope,
} from './HelperMessageActions.js';
import { useHelperConversation, type HelperTaskView } from './useHelperConversation.js';
import { interceptAppHistory } from './app-history.js';
import { sidePanelTabsShown } from './SidePanelTabs.js';
import {
  editorContextChanged,
  captureActiveEditorContext,
  getActiveEditorContext,
  saveActiveEditor,
  type ActiveEditorContext,
} from './resource-editor.js';
import { editorFocusKey, type EditorFocus } from '../core/editor-focus.js';
import type { ResourceKind } from '../core/resource-editing.js';
import { editorHelperSuggestions } from './editor-helper.js';
import { contentSectionRegistry, presetSectionRegistry } from './studio-sections.js';
import { useHelperSessions } from './useHelperSessions.js';
import { HelperSessionBar, type HelperNavigationActions } from './HelperSessionBar.js';
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
import { TransientNotice, useTransientNotice } from './TransientNotice.js';
import { modelLabel } from './storyLabels.js';
import {
  cachedHelperRecovery,
  clearHelperRecoveryIf,
  failedHelperRecoveryKeys,
  helperRecoveryRevision,
  loadHelperSessionRecovery,
  retryHelperRecoveryWrite,
  subscribeHelperRecovery,
  writeHelperRecovery,
} from './helper-recovery.js';
import './helper.css';
import './settings-layout.css';
import { readOptionalStorage } from './optional-storage.js';
import { useRetryableEffect } from './useRetryableEffect.js';
import { useBottomFollow } from './useBottomFollow.js';
import { useShortcut, useShortcutLabel } from './shortcuts.js';
import { storageKeys } from './storage-keys.js';

type Props = {
  enterSend: boolean;
  responseDisplay: ResponseDisplayMode;
  open: boolean;
  navigation?: { conversationId: string; taskId: string; sequence: number; epoch: number } | null;
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
  onOpenChange?: (change: import('../core/helper.js').HelperChange) => void | Promise<void>;
  onScopeChange?: (scope: HelperScope) => void;
  ready?: boolean;
  scope: HelperScope;
  resource?: HelperResourceRef | null;
  onClearResource?: () => void;
  handoff?: HelperHandoff;
  handoffEpoch: MutableRefObject<number>;
  outlineWorkspace?: boolean;
  tabs?: (close: () => void) => ReactNode;
  onClose: () => void;
  onModelSettings: () => void;
  modelDescription: string;
  modelTitle: string;
  modelRevision: number;
  library: Library | null;
  currentChat?: { id: string; title: string } | null;
};
export type HelperHandoff =
  | ({ kind: 'outline'; epoch: number } & OutlineHelperRequest)
  | {
      kind: 'draft';
      epoch: number;
      key: string;
      text: string;
      scope: HelperScope;
      conversationId?: string;
    }
  | ({
      kind: 'selection';
      epoch: number;
      key: string;
      scope: Extract<HelperScope, { kind: 'chat' }>;
      conversationId?: string;
    } & HelperSelection)
  | {
      kind: 'editor';
      epoch: number;
      key: string;
      scope: HelperScope;
      conversationId?: string;
      focus: EditorFocus;
    };
type Outbox = Partial<FrozenHelperAttachments> & {
  retryOf?: string;
  resume?: true;
  steerTaskId?: string;
  requestKey: string;
  text: string;
  scope: string;
  targetConversationId: string;
  editor?: HelperEditor;
  selection?: HelperSelection;
  outline?: OutlineTarget;
  references?: HelperReferencePointer[];
  mode?: 'plan';
  confirmations?: string[];
  declinedConfirmations?: string[];
};
const active = (task: HelperTaskView) => task.status === 'queued' || task.status === 'running';
const starterKeys: Record<HelperScope['kind'], string[]> = {
  chat: ['helpers.starterChatSummary', 'helpers.starterChatConsistency', 'helpers.starterChatNext'],
  library: [
    'helpers.starterLibraryOrganize',
    'helpers.starterLibraryGaps',
    'helpers.starterLibraryDraft',
  ],
};
const attention = (task: HelperTaskView) => ['failed', 'interrupted'].includes(task.status);
const tone = (task: HelperTaskView): StatusTone =>
  attention(task) ? 'issue' : active(task) ? 'running' : 'done';
function taskElapsed(task: HelperTaskView, now: number) {
  if (task.status === 'queued') return elapsedLabel(task.createdAt, now);
  if (!task.startedAt) return '';
  const measured = elapsedLabel(task.startedAt, active(task) ? now : Date.parse(task.updatedAt));
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
  storageKeys.helperTaskActivity(task.conversationId, task.id, !active(task));
function savedActivityOpen(task: HelperTaskView) {
  return readOptionalStorage('session', activityKey(task)) === 'open';
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
  return cachedHelperRecovery(key) ?? null;
}
function saveLocal(key: string, value: string | null) {
  void writeHelperRecovery(key, value).catch(() => {});
}
function storedOutbox(scope: string): Outbox | null {
  try {
    const value = JSON.parse(local(`helper-outbox:${scope}`) ?? 'null') as Outbox | null;
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
      local(`helper-selection:${scope}`) ?? 'null'
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
    const value = JSON.parse(local(`helper-outline:${scope}`) ?? 'null') as SelectedOutline | null;
    return value &&
      ['compose', 'review'].includes(value.target?.purpose) &&
      typeof value.title === 'string'
      ? value
      : null;
  } catch {
    return null;
  }
}
const selectionRequest = () => t('helpers.reviewSelection');
function editorFocusParts(kind: ResourceKind, focus: EditorFocus) {
  const registry: readonly { id: string; labelKey: string }[] =
    kind === 'content' ? contentSectionRegistry : presetSectionRegistry;
  const section = registry.find((entry) => entry.id === focus.section);
  const item = focus.item?.label;
  const field = focus.field?.label;
  return {
    place: section ? t(section.labelKey) : focus.section,
    detail: [
      item,
      field && field !== item ? field : '',
      focus.selection
        ? t('editorHelper.focusSelection', { count: focus.selection.to - focus.selection.from })
        : '',
      focus.diagnostic
        ? t('editorHelper.focusError', { line: focus.diagnostic.line })
        : focus.diagnostics?.length
          ? t('editorHelper.focusErrors', {
              count: focus.diagnostics.length + (focus.diagnosticsOmitted ?? 0),
            })
          : '',
    ]
      .filter(Boolean)
      .join(', '),
  };
}

export const HelperPanel = memo(function HelperPanel(props: Props) {
  useI18n();
  const sessions = useHelperSessions(
    props.open && props.ready !== false,
    props.scope,
    props.expanded,
    props.handoffEpoch
  );
  const navigatedTask = useRef<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The mutable epoch only rejects stale navigation; it is not a trigger.
  useEffect(() => {
    const target = props.navigation;
    if (
      !props.open ||
      !target ||
      target.epoch !== props.handoffEpoch.current ||
      navigatedTask.current === target.sequence
    )
      return;
    const match = sessions.sessions.find((session) => session.id === target.conversationId);
    if (!match) return;
    navigatedTask.current = target.sequence;
    sessions.select(match);
    setTaskHistory({ taskId: target.taskId });
  }, [props.navigation, props.open, sessions.sessions, sessions.select]);
  const scopeKey = sessions.currentId ?? '';
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  const data = useHelperConversation(props.open && props.ready !== false, sessions.currentId);
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
  const latestTaskId = messages.findLast((message) => taskMap.has(message.taskId))?.taskId;
  const [latestUsage, setLatestUsage] = useState<{
    taskId: string;
    usage: import('../core/helper.js').HelperTaskResultsView['usage'];
  } | null>(null);
  const reportUsage = useCallback(
    (taskId: string, usage: import('../core/helper.js').HelperTaskResultsView['usage']) =>
      setLatestUsage({ taskId, usage }),
    []
  );
  const shownUsage = latestUsage && latestUsage.taskId === latestTaskId ? latestUsage.usage : null;
  const compactionRequest = async (method: 'POST' | 'DELETE') => {
    if (!conversation || compactStarting[conversation.id]) return;
    const owner = conversation.id;
    const target = conversation;
    setCompactStarting((old) => ({ ...old, [owner]: true }));
    setCompactErrors((old) => ({ ...old, [owner]: '' }));
    try {
      const result = await api<HelperCompactionStart | { cancelled: boolean }>(
        `/helper/conversations/${encodeURIComponent(owner)}/compact`,
        {},
        method
      );
      if ('started' in result && result.started)
        requestedCompactions.current.set(owner, result.startedAt);
      await data.refresh(target);
      if ('noopReason' in result && result.noopReason === 'already-compacted')
        notify(uiMessage('helperUsage.alreadyCompacted'));
    } catch (cause) {
      setCompactErrors((old) => ({
        ...old,
        [owner]:
          cause instanceof Error ? cause.message : uiMessage('errors.HELPER_COMPACTION_FAILED'),
      }));
    } finally {
      setCompactStarting((old) => ({ ...old, [owner]: false }));
    }
  };
  const running = tasks.find((task) => task.status === 'running');
  const queuedTasks = tasks.filter((task) => task.status === 'queued');
  const pendingSteers = (running?.instructions ?? []).filter((item) => item.status === 'pending');
  const activeTask = Boolean(running || queuedTasks.length);
  const [runningSendMode, setRunningSendMode] = useState<'queue' | 'steer'>(() =>
    readPresentationChoice(storageKeys.helperRunningSend, ['queue', 'steer'], 'queue')
  );
  const updateRunningSendMode = (next: 'queue' | 'steer') => {
    setRunningSendMode(next);
    writePresentationSetting(storageKeys.helperRunningSend, next);
  };
  const stopShortcutLabel = useShortcutLabel('run.stop');
  const helperModeShortcutLabel = useShortcutLabel('helper.mode');
  const panel = useRef<HTMLElement>(null);
  useShortcut('run.stop', () => running && void cancel(running), {
    scope: panel,
    ready: () => !!running,
    confirmNotice: uiMessage('shortcuts.cancelHelperAgain', { key: stopShortcutLabel }),
  });
  const [modes, setModes] = useState<Record<string, HelperMode>>({});
  const [chosenMode, setChosenMode] = useState<HelperMode>(() =>
    readPresentationChoice<HelperMode>(storageKeys.helperMode, ['apply', 'plan'], 'apply')
  );
  const mode = modes[scopeKey] ?? chosenMode;
  const chooseMode = (next: HelperMode) => {
    setModes((old) => ({ ...old, [scopeKey]: next }));
    setChosenMode(next);
    writePresentationSetting(storageKeys.helperMode, next);
  };
  const [grants, setGrants] = useState<Record<string, HelperConfirmationGrant[]>>({});
  const grantList = grants[scopeKey] ?? [];
  const [mentionRefsByScope, setMentionRefsByScope] = useState<
    Record<string, HelperContextReference[]>
  >({});
  const mentionRefs = mentionRefsByScope[scopeKey] ?? [];
  const [mentionTrigger, setMentionTrigger] = useState<MentionTrigger | null>(null);
  const [mentionItems, setMentionItems] = useState<HelperContextReference[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionDismissed = useRef<string | null>(null);
  const mentionOpen = Boolean(mentionTrigger && conversation);
  const mentionQuery = mentionTrigger ? mentionTrigger.query : null;
  const mentionConversationId = props.open && conversation ? conversation.id : null;
  useEffect(() => {
    void scopeKey;
    void props.open;
    setMentionTrigger(null);
    setMentionItems([]);
    setMentionIndex(0);
    mentionDismissed.current = null;
  }, [scopeKey, props.open]);
  useEffect(() => {
    if (mentionQuery === null || !mentionConversationId) {
      setMentionItems([]);
      setMentionLoading(false);
      return;
    }
    const controller = new AbortController();
    setMentionLoading(true);
    setMentionIndex(0);
    const timer = setTimeout(() => {
      void api<HelperContextReference[]>(
        `/helper/conversations/${encodeURIComponent(mentionConversationId)}/references?q=${encodeURIComponent(mentionQuery)}`,
        undefined,
        'GET',
        controller.signal
      )
        .then((items) => {
          if (controller.signal.aborted) return;
          setMentionItems(items);
          setMentionIndex(0);
          setMentionLoading(false);
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setMentionItems([]);
            setMentionLoading(false);
          }
        });
    }, 80);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [mentionConversationId, mentionQuery]);
  const syncMentionTrigger = (value: string, cursor: number | null | undefined) => {
    if (cursor == null || !conversation) {
      setMentionTrigger(null);
      return;
    }
    const found = findMentionTrigger(value, cursor);
    if (!found) {
      mentionDismissed.current = null;
      setMentionTrigger(null);
      return;
    }
    const key = `${found.start}:${found.query}`;
    if (mentionDismissed.current === key) {
      setMentionTrigger(null);
      return;
    }
    setMentionTrigger(found);
  };
  const chooseMention = (item: HelperContextReference) => {
    if (!mentionTrigger || !scopeKey) return;
    const label = helperReferenceLabel(item);
    const { text: nextText, cursor: nextCursor } = applyMentionReplacement(
      draft,
      mentionTrigger,
      label
    );
    editDraft(nextText);
    setMentionRefsByScope((old) => {
      const current = old[scopeKey] ?? [];
      if (current.some((entry) => referenceKey(entry) === referenceKey(item))) return old;
      if (current.length >= MAX_HELPER_REFERENCES) return old;
      return { ...old, [scopeKey]: [...current, item] };
    });
    setMentionTrigger(null);
    mentionDismissed.current = null;
    requestAnimationFrame(() => {
      const node = input.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(nextCursor, nextCursor);
    });
  };
  const openReference = (ref: HelperContextReference) => {
    if (!props.onOpenChange) return;
    let anchor: HelperChangeAnchor | null = null;
    if (ref.kind === 'scene' && ref.chatId)
      anchor = {
        domain: 'scene',
        chatId: ref.chatId,
        sourceId: ref.id,
        field: 'original',
        paragraph: null,
      };
    else if (ref.kind === 'outline' && ref.chatId)
      anchor = { domain: 'outline', chatId: ref.chatId, nodeId: ref.id, field: null };
    else if (ref.kind === 'content' || ref.kind === 'prompt-preset')
      anchor = {
        domain: 'resource',
        kind: ref.kind,
        id: ref.id,
        path: null,
        section: null,
        index: null,
      };
    if (anchor)
      void props.onOpenChange({
        domain: anchor.domain,
        targetId: ref.id,
        title: helperReferenceLabel(ref),
        location: null,
        action: 'update',
        diff: null,
        anchor,
      });
  };
  const toggleMode = () => {
    if (!scopeKey || document.activeElement?.closest('dialog')) return false;
    const next = mode === 'plan' ? 'apply' : 'plan';
    chooseMode(next);
    if (next === 'plan') setGrants((old) => ({ ...old, [scopeKey]: [] }));
  };
  useShortcut('helper.mode', toggleMode, { scope: panel, active: props.open });
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
  const [recoveryReadFailed, setRecoveryReadFailed] = useState<Record<string, boolean>>({});
  useSyncExternalStore(subscribeHelperRecovery, helperRecoveryRevision);
  const [outlineSelections, setOutlineSelections] = useState<
    Record<string, SelectedOutline | null>
  >({});
  const [selections, setSelections] = useState<Record<string, HelperSelection | null>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [modelRequired, setModelRequired] = useState<Record<string, boolean>>({});
  const [busyScopes, setBusyScopes] = useState<Record<string, boolean>>({});
  const [editor, setEditor] = useState<ActiveEditorContext | null>(null);
  const [editorAsks, setEditorAsks] = useState<Record<string, string>>({});
  const [detachedFocus, setDetachedFocus] = useState<Record<string, string>>({});
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
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
  const notify = useTransientNotice();
  const [compactStarting, setCompactStarting] = useState<Record<string, boolean>>({});
  const requestedCompactions = useRef(new Map<string, string>());
  const compaction = data.current?.context?.compaction;
  const compactionOwner = data.current?.conversation.id;
  useEffect(() => {
    const startedAt = compactionOwner && requestedCompactions.current.get(compactionOwner);
    const last = compaction?.last;
    if (!startedAt || compaction?.running || !last || last.finishedAt < startedAt) return;
    requestedCompactions.current.delete(compactionOwner);
    if (last.status === 'completed')
      notify(uiMessage('helperUsage.compactedNotice', { count: last.compactedMessages }));
  }, [compactionOwner, compaction, notify]);
  const [compactErrors, setCompactErrors] = useState<Record<string, string>>({});
  const [summaryDialog, setSummaryDialog] = useState<string | null>(null);
  const [summaryDrafts, setSummaryDrafts] = useState<Record<string, HelperSummaryDraft>>({});
  useEffect(() => {
    if (!props.open) setModelPicker(false);
  }, [props.open]);
  const [taskHistory, setTaskHistory] = useState<{ taskId?: string } | null>(null);
  const [openTaskActivities, setOpenTaskActivities] = useState<Record<string, boolean>>({});
  const [liveActivityOpen, setLiveActivityOpen] = useState(
    () =>
      readPresentationChoice(storageKeys.helperLiveActivity, ['closed', 'open'], 'closed') ===
      'open'
  );
  const toggleLiveActivity = () => {
    const next = !liveActivityOpen;
    setLiveActivityOpen(next);
    writePresentationSetting(storageKeys.helperLiveActivity, next ? 'open' : 'closed');
  };
  const [personas, setPersonas] = useState<Record<string, { text: string; revision: number }>>({});
  const [savingPersona, setSavingPersona] = useState(false);
  const compact = (props.modal ?? false) && !props.expanded;
  const docked = !props.modal && !props.expanded;
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
    input = useRef<HTMLTextAreaElement>(null),
    inputFocusPending = useRef(false);
  const scroll = useRef<HTMLDivElement>(null),
    content = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, { top: number; following: boolean }>());
  const bottom = useBottomFollow(scroll, content, props.open, true);
  const following = bottom.following,
    displayedScope = useRef('');
  const prepend = useRef<{ scope: string; height: number; top: number } | null>(null);
  const editRevisions = useRef(new Map<string, number>());
  const [editConflict, setEditConflict] = useState<{
    conversationId: string;
    messageId: string;
    draft: string;
  } | null>(null);
  const locks = useRef(new Set<string>()),
    appliedHandoff = useRef<string | null>(null);
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
  const draft = drafts[scopeKey] ?? local(`helper-input:${scopeKey}`) ?? '';
  const editorFocus = currentResource ? undefined : displayEditor?.focus;
  const editorFocusId = editorFocusKey(editorFocus);
  const shownFocus =
    editorFocus && detachedFocus[scopeKey] !== editorFocusId ? editorFocus : undefined;
  const editorUnsaved = !currentResource && !!editor && displayEditor === editor && editor.dirty;
  const editorSuggestions =
    shownFocus && editorAsks[scopeKey] === editorFocusId && !draft.trim()
      ? editorHelperSuggestions(shownFocus)
      : [];
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
  const failedRecoveryWrites = failedHelperRecoveryKeys(scopeKey);
  const recoveryError = recoveryReadFailed[scopeKey]
    ? t('helpers.m012')
    : failedRecoveryWrites.length
      ? t('helpers.draftSaveFailed')
      : '';
  const error =
    recoveryError || errors[scopeKey] || data.error || sessions.error || attachments.error;
  const persona =
    personas[scopeKey] ??
    (conversation
      ? { text: conversation.persona, revision: conversation.revision }
      : { text: '', revision: 0 });
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
  const retryRecoveryRead = useRetryableEffect(() => {
    if (!scopeKey) return;
    let disposed = false;
    const restore = async () => {
      try {
        await loadHelperSessionRecovery(scopeKey);
      } catch {
        if (!disposed) setRecoveryReadFailed((old) => ({ ...old, [scopeKey]: true }));
        return;
      }
      if (disposed) return;
      setDrafts((old) =>
        old[scopeKey] === undefined
          ? { ...old, [scopeKey]: local(`helper-input:${scopeKey}`) ?? '' }
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
      setRecoveryReadFailed((old) => ({ ...old, [scopeKey]: false }));
    };
    void restore();
    return () => {
      disposed = true;
    };
  }, [scopeKey]);
  const editDraft = useCallback(
    (text: string) => {
      if (!scopeKey || !hydrated[scopeKey]) return;
      attachments.touch();
      saveLocal(`helper-input:${scopeKey}`, text);
      setDrafts((old) => ({ ...old, [scopeKey]: text }));
    },
    [scopeKey, hydrated, attachments.touch]
  );
  const setOutbox = (key: string, value: Outbox | null) => {
    setOutboxes((old) => ({ ...old, [key]: value }));
  };
  const selectSession = sessions.select;
  const retryHandoff = useRetryableEffect(() => {
    const selected = props.handoff;
    if (!selected || appliedHandoff.current === selected.key) return;
    let disposed = false;
    const current = () => !disposed && props.handoffEpoch.current === selected.epoch;
    if (!current()) return;
    void (async () => {
      let owner: HelperConversation;
      try {
        owner = selected.conversationId
          ? await api<HelperConversation>(
              `/helper/conversations/${encodeURIComponent(selected.conversationId)}`
            )
          : await api<HelperConversation>('/helper/conversations', { scope: selected.scope });
      } catch (cause) {
        if (!current()) return;
        if (selected.kind !== 'selection' || !(cause instanceof ApiError) || cause.status !== 404)
          throw cause;
        owner = await api<HelperConversation>('/helper/conversations', { scope: selected.scope });
      }
      if (!current()) return;
      if (JSON.stringify(owner.scope) !== JSON.stringify(selected.scope))
        throw new Error(uiMessage(selected.kind === 'selection' ? 'helpers.m014' : 'helpers.m013'));
      try {
        await loadHelperSessionRecovery(owner.id);
      } catch {
        if (current()) {
          selectSession(owner);
          setRecoveryReadFailed((old) => ({ ...old, [owner.id]: true }));
        }
        return;
      }
      if (!current()) return;
      appliedHandoff.current = selected.key;
      if (selected.kind === 'outline' && selected.target) {
        setSelections((old) => ({ ...old, [owner.id]: null }));
        saveLocal(`helper-selection:${owner.id}`, null);
        const value = { target: selected.target, title: selected.title, request: selected.text };
        setOutlineSelections((old) => ({ ...old, [owner.id]: value }));
        saveLocal(`helper-outline:${owner.id}`, JSON.stringify(value));
      } else if (selected.kind === 'selection') {
        setOutlineSelections((old) => ({ ...old, [owner.id]: null }));
        saveLocal(`helper-outline:${owner.id}`, null);
        const value: HelperSelection = {
          sourceId: selected.sourceId,
          sourceHash: selected.sourceHash,
          text: selected.text,
        };
        setSelections((old) => ({ ...old, [owner.id]: value }));
        saveLocal(`helper-selection:${owner.id}`, JSON.stringify(value));
      } else if (selected.kind === 'editor') {
        const key = editorFocusKey(selected.focus);
        setEditorAsks((old) => ({ ...old, [owner.id]: key }));
        setDetachedFocus((old) => ({ ...old, [owner.id]: '' }));
        setComposerFocusRequest((value) => value + 1);
      }
      if (selected.kind !== 'editor' && (selected.kind !== 'outline' || selected.target))
        setDrafts((old) => {
          if (!current()) return old;
          const previous = old[owner.id] ?? local(`helper-input:${owner.id}`) ?? '';
          const text = selected.kind === 'selection' ? selectionRequest() : selected.text;
          const next = previous.trim()
            ? selected.kind === 'draft'
              ? `${previous}\n\n${text}`
              : previous
            : text;
          saveLocal(`helper-input:${owner.id}`, next);
          return { ...old, [owner.id]: next };
        });
      selectSession(owner);
    })().catch((cause) => {
      if (current())
        setErrors((old) => ({
          ...old,
          [currentScope.current]:
            cause instanceof Error ? cause.message : uiMessage('helpers.m207'),
        }));
    });
    return () => {
      disposed = true;
    };
  }, [props.handoff, props.handoffEpoch, selectSession]);
  const taskStamp = tasks.map((task) => `${task.id}:${task.status}`).join('|');
  useEffect(() => {
    dispatchEvent(new CustomEvent(OUTLINE_REFRESH_EVENT, { detail: taskStamp }));
  }, [taskStamp]);
  useEffect(() => {
    const update = () => setEditor(getActiveEditorContext());
    update();
    addEventListener(editorContextChanged, update);
    return () => removeEventListener(editorContextChanged, update);
  }, []);
  useEffect(() => {
    if (!props.open) return;
    const prior = document.activeElement as HTMLElement | null;
    inputFocusPending.current =
      Boolean(closeButton.current) && matchMedia('(hover: hover) and (pointer: fine)').matches;
    closeButton.current?.focus();
    return () => {
      inputFocusPending.current = false;
      if (prior?.isConnected && prior.checkVisibility() && !sidePanelTabsShown()) prior.focus();
    };
  }, [props.open]);
  useEffect(() => {
    if (!props.open || docked) {
      closePanel.current = () => close.current();
      return;
    }
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
    };
  }, [props.open, docked]);
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
  }, [props.open, scopeKey, data.current, following]);
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
      if (captured?.focus && detachedFocus[owner] === editorFocusKey(captured.focus)) {
        const { focus: _detached, ...rest } = captured;
        captured = rest;
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
          ...(!steerTaskId && (mentionRefsByScope[owner]?.length ?? 0) > 0
            ? {
                references: (mentionRefsByScope[owner] ?? []).map(({ kind, id }) => ({
                  kind,
                  id,
                })),
              }
            : {}),
          ...(!steerTaskId && (modes[owner] ?? chosenMode) === 'plan'
            ? { mode: 'plan' as const }
            : {}),
          ...(!steerTaskId && grants[owner]?.length
            ? { confirmations: grants[owner].map((grant) => grant.id) }
            : {}),
        };
        const declined =
          !steerTaskId && latestTaskId ? declinedHelperConfirmations(latestTaskId) : [];
        if (declined.length) request.declinedConfirmations = declined;
      }
      setOutbox(owner, request);
      if (!steerTaskId) setEditorAsks((old) => ({ ...old, [owner]: '' }));
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
          ...(request.resume ? { resume: true } : {}),
          text: request.text,
          ...(request.editor ? { editor: request.editor } : {}),
          ...(request.selection ? { selection: request.selection } : {}),
          ...(request.outline ? { outline: request.outline } : {}),
          ...(request.references?.length && !request.steerTaskId
            ? { references: request.references }
            : {}),
          ...(request.images?.length ? { images: request.images } : {}),
          ...(request.files?.length ? { files: request.files } : {}),
          ...(request.mode && !request.steerTaskId ? { mode: request.mode } : {}),
          ...(request.confirmations?.length && !request.steerTaskId
            ? { confirmations: request.confirmations }
            : {}),
          ...(request.declinedConfirmations?.length && !request.steerTaskId && !request.retryOf
            ? { declinedConfirmations: request.declinedConfirmations }
            : {}),
        }
      );
      setOutbox(owner, null);
      setUnpersisted((old) => ({ ...old, [owner]: false }));
      if (request.confirmations?.length)
        setGrants((old) => ({
          ...old,
          [owner]: (old[owner] ?? []).filter((grant) => !request.confirmations?.includes(grant.id)),
        }));
      if (request.references?.length)
        setMentionRefsByScope((old) => ({
          ...old,
          [owner]: (old[owner] ?? []).filter(
            (ref) => !request.references?.some((sent) => referenceKey(sent) === referenceKey(ref))
          ),
        }));
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
          const existing = old[owner] ?? local(`helper-input:${owner}`) ?? '';
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
      ?.text ?? task.request,
    resume = false
  ) {
    if (props.ready === false || !conversation || outbox || busy || locks.current.has(scopeKey))
      return false;
    if (!resume && task.completedEffects?.count) {
      setError(uiMessage('helpers.m022'));
      return false;
    }
    const request: Outbox = {
      requestKey: crypto.randomUUID(),
      text,
      scope: scopeKey,
      targetConversationId: conversation.id,
      retryOf: task.id,
      ...(resume ? { resume: true as const } : {}),
    };
    return send(request);
  }
  function confirmHeld(grant: HelperConfirmationGrant) {
    if (!scopeKey) return;
    chooseMode('apply');
    setGrants((old) => ({
      ...old,
      [scopeKey]: [...(old[scopeKey] ?? []).filter((item) => item.id !== grant.id), grant],
    }));
    editDraft(draft.trim() ? `${draft}\n\n${grant.text}` : grant.text);
    input.current?.focus();
  }
  const nameTarget = (target: HelperConfirmationTarget) => {
    if (target.kind === 'chat')
      return target.id === props.currentChat?.id
        ? props.currentChat.title
        : t('helperConfirm.chat');
    if (target.kind === 'scene') return t('helperConfirm.scene');
    const found =
      target.kind === 'prompt-preset'
        ? props.library?.promptPresets?.find((preset) => preset.id === target.id)
        : props.library?.contents.find((content) => content.id === target.id);
    return found?.title ?? target.id;
  };
  async function carryOutPlan() {
    if (!conversation || outbox) return;
    chooseMode('apply');
    await send({
      requestKey: crypto.randomUUID(),
      text: t('helperPlan.carryOutRequest'),
      scope: scopeKey,
      targetConversationId: conversation.id,
    });
  }
  async function answerQuestion(choice: string) {
    if (!conversation || outbox || !hydrated[scopeKey]) return;
    await send({
      requestKey: crypto.randomUUID(),
      text: choice,
      scope: scopeKey,
      targetConversationId: conversation.id,
      ...(mode === 'plan' ? { mode: 'plan' as const } : {}),
    });
  }
  const taskStatus = (task: HelperTaskView) => (
    <div className="helper-task" data-task-id={task.id}>
      <TurnStatus
        key={`${task.id}:${active(task) ? 'active' : 'settled'}`}
        tone={tone(task)}
        quiet={task.status === 'completed' || task.id === summarized?.id}
        text={
          (task.id === summarized?.id ? activityLabel : undefined) ??
          t(statusLabel[task.status] ?? task.status)
        }
        elapsed={
          task.id === summarized?.id ? undefined : active(task) ? (
            <HelperTaskElapsed task={task} visible={props.open} />
          ) : (
            taskElapsed(task, Date.now())
          )
        }
        badges={
          task.mode === 'plan' ? (
            <span className="activity-count helper-plan-badge">{t('helperPlan.title')}</span>
          ) : undefined
        }
        storageKey={activityKey(task)}
        onOpenChange={(open) => setOpenTaskActivities((old) => ({ ...old, [task.id]: open }))}
        dataProps={{ 'data-testid': 'helper-task-activity', 'data-task-id': task.id }}
      >
        <div className="helper-task-meta ui-meta-row">
          <span>{t('helpers.m310', { model: task.modelTitle ?? t('helpers.m026') })}</span>
          <span>
            {task.usage.outputTokens == null
              ? t('helpers.m311Unknown', {
                  calls: formatNumber(task.usage.modelCalls),
                })
              : t('helpers.m311', {
                  calls: formatNumber(task.usage.modelCalls),
                  output: usageCompact(task.usage.outputTokens),
                })}
          </span>
        </div>
        {task.error && <p className="error">{helperTaskError(task.error)}</p>}
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
        <div
          className="helper-instruction"
          data-status={instruction.status}
          key={instruction.id}
          data-testid="helper-instruction"
        >
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
            error={task.error}
            disabled={busy || Boolean(outbox)}
            onResume={task.resumable ? () => void retry(task, undefined, true) : undefined}
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
    </button>
  );
  const submitDisabled =
    props.ready === false ||
    !hydrated[scopeKey] ||
    busy ||
    data.loading ||
    !attachments.ready ||
    attachments.busy ||
    !conversation ||
    (!draft.trim() && !attachments.hasAttachments && !outbox);
  const inputDisabled =
    props.ready === false || !conversation || !hydrated[scopeKey] || !attachments.ready;
  useEffect(() => {
    if (!props.open || inputDisabled || !inputFocusPending.current) return;
    inputFocusPending.current = false;
    if (document.activeElement === closeButton.current) input.current?.focus();
  }, [props.open, inputDisabled]);
  const focusedComposerRequest = useRef(0);
  useEffect(() => {
    if (
      !props.open ||
      inputDisabled ||
      composerFocusRequest === focusedComposerRequest.current ||
      !matchMedia('(hover: hover) and (pointer: fine)').matches
    )
      return;
    focusedComposerRequest.current = composerFocusRequest;
    input.current?.focus();
  }, [props.open, inputDisabled, composerFocusRequest]);
  const steering = Boolean(running && runningSendMode === 'steer' && !attachments.hasAttachments);
  const submitRequest = () => {
    if (outbox) setOutboxDecision(outbox);
    else if (steering && running && draft.trim()) void send(undefined, false, running.id);
    else void send();
  };
  return (
    <aside
      ref={panel}
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
      {props.tabs?.(() => closePanel.current())}
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
            props.handoffEpoch.current++;
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
            props.handoffEpoch.current++;
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
          onDelete={(id) => {
            props.handoffEpoch.current++;
            sessions.remove(id);
          }}
          onCloneStart={() => ++props.handoffEpoch.current}
          onClone={(session, epoch) => {
            if (props.handoffEpoch.current !== epoch) return;
            if (props.expanded) {
              setFrozenEditors((old) => ({ ...old, [session.id]: null }));
              setFrozenResources((old) => ({ ...old, [session.id]: null }));
            }
            sessions.select(session);
            props.onSelectConversation?.();
          }}
        />
        <IconButton label={t('helpers.m106')} icon={History} onClick={() => setTaskHistory({})} />
        {props.onToggleExpanded && (
          <IconButton
            label={
              props.expanded
                ? (props.returnLabel ?? t('helpers.returnToPrevious'))
                : t('helpers.expand')
            }
            icon={!props.expanded ? Maximize2 : props.returnToSidecar ? Minimize2 : X}
            onClick={() => {
              if (props.expanded && !props.returnToSidecar) closePanel.current();
              else props.onToggleExpanded?.();
            }}
          />
        )}
        {!props.expanded && !props.tabs && (
          <IconButton
            ref={closeButton}
            icon={X}
            label={t('helpers.m045')}
            onClick={() => closePanel.current()}
          />
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
                        } catch {}
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
            bottom.onScroll();
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
          {conversation && !data.loading && messages.length === 0 && (
            <div className="helper-start" data-testid="helper-start">
              <p className="helper-start-scope">
                {scope.kind === 'chat' ? (
                  <MessageCircle size={16} aria-hidden="true" />
                ) : (
                  <LibraryIcon size={16} aria-hidden="true" />
                )}
                <span>
                  {scope.kind === 'chat' && scope.chatId === props.currentChat?.id
                    ? props.currentChat.title
                    : t(scope.kind === 'chat' ? 'helpers.chatTitle' : 'helpers.libraryTitle')}
                </span>
              </p>
              {editorSuggestions.length === 0 && (
                <ul className="helper-start-list" aria-label={t('helpers.starters')}>
                  {starterKeys[scope.kind].map((key) => (
                    <li key={key}>
                      <button
                        type="button"
                        className="secondary"
                        disabled={
                          props.ready === false || !hydrated[scopeKey] || !attachments.ready
                        }
                        onClick={() => {
                          editDraft(t(key));
                          input.current?.focus();
                        }}
                      >
                        {t(key)}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
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
                  ) : task?.mode === 'plan' && message.role === 'assistant' ? (
                    <HelperPlanCard
                      action={
                        task.status === 'completed' &&
                        task.id === latestTaskId &&
                        !pending.length && (
                          <button
                            type="button"
                            className="primary"
                            disabled={messageDisabled || !hydrated[scopeKey]}
                            onClick={() => void carryOutPlan()}
                          >
                            <Play size={16} aria-hidden="true" />
                            {t('helperPlan.carryOut')}
                          </button>
                        )
                      }
                    >
                      {response}
                    </HelperPlanCard>
                  ) : (
                    response
                  )}
                  {message.role === 'user' && (message.references?.length ?? 0) > 0 && (
                    <div
                      className="helper-message-references"
                      aria-label={t('helpers.mentionReferencesLabel')}
                    >
                      {message.references!.map((ref) =>
                        props.onOpenChange ? (
                          <button
                            key={referenceKey(ref)}
                            type="button"
                            className="helper-context-chip helper-mention-chip helper-mention-chip-link"
                            onClick={() => openReference(ref)}
                          >
                            <span className="helper-chip-badge">
                              {helperReferenceKindLabel(ref)}
                            </span>
                            <span className="helper-chip-label">{helperReferenceLabel(ref)}</span>
                          </button>
                        ) : (
                          <span
                            key={referenceKey(ref)}
                            className="helper-context-chip helper-mention-chip"
                          >
                            <span className="helper-chip-badge">
                              {helperReferenceKindLabel(ref)}
                            </span>
                            <span className="helper-chip-label">{helperReferenceLabel(ref)}</span>
                          </span>
                        )
                      )}
                    </div>
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
                    <div className="helper-turn-meta">
                      <HelperTaskResults
                        taskId={task.id}
                        status={task.status}
                        visible={props.open}
                        eager={task.id === latestTaskId}
                        onUsage={task.id === latestTaskId ? reportUsage : undefined}
                        onOpenTarget={props.onOpenTarget}
                        onOpenChange={props.onOpenChange}
                        rollbackUnavailable={pending.length > 0 || busy}
                        review={task.id === latestTaskId}
                        confirmation={{
                          nameTarget,
                          pending: grantList.map((grant) => grant.id),
                          latestTaskId,
                          onConfirm: task.id === latestTaskId ? confirmHeld : undefined,
                        }}
                        questionAnswer={{
                          isLatest: task.id === latestTaskId,
                          disabled: messageDisabled || !hydrated[scopeKey],
                          onAnswer: (choice) => void answerQuestion(choice),
                        }}
                      />
                      {taskStatus(task)}
                    </div>
                  )}
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
            return () => ({
              content: (
                <>
                  <p>{t('helpers.messageMissing')}</p>
                  <label>
                    {t('helpers.messageDraft')}
                    <textarea readOnly value={editConflict.draft} rows={5} />
                  </label>
                </>
              ),
            });
          const revision = view.conversation.revision;
          return () => ({
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
          });
        }}
      />
      {conversation && (
        <HelperSummaryDialog
          key={conversation.id}
          open={props.open && summaryDialog === conversation.id}
          conversationId={conversation.id}
          checkpointRevision={data.current?.context?.checkpointRevision}
          busy={
            activeTask ||
            Boolean(data.current?.context?.compaction.running) ||
            Boolean(compactStarting[conversation.id])
          }
          draft={summaryDrafts[conversation.id] ?? null}
          onDraftChange={(draft) => {
            const owner = conversation.id;
            setSummaryDrafts((old) => {
              const { [owner]: _previous, ...rest } = old;
              return draft ? { ...rest, [owner]: draft } : rest;
            });
          }}
          onChanged={async (message) => {
            notify(message);
            await data.refresh(conversation);
          }}
          onClose={() => setSummaryDialog(null)}
        />
      )}
      <Dialog
        open={!!taskHistory}
        title={t('helpers.m064')}
        className="helper-task-history"
        wide
        scopeKey={taskHistory?.taskId ?? 'all'}
        onClose={() => setTaskHistory(null)}
      >
        <HelperTaskHistory
          tasks={tasks}
          focusedTaskId={taskHistory?.taskId}
          visible={props.open && !!taskHistory}
          hasOlder={!!data.current?.hasOlderTasks}
          loadingOlder={data.loadingEarlier}
          onLoadOlder={() => void data.earlier('tasks')}
          onShowAll={() => setTaskHistory({})}
          inConversation={(taskId) => messages.some((message) => message.taskId === taskId)}
          onShowInConversation={(taskId) => {
            setTaskHistory(null);
            requestAnimationFrame(() => {
              const node = [
                ...(content.current?.querySelectorAll<HTMLElement>('[data-task-id]') ?? []),
              ].find((item) => item.dataset.taskId === taskId);
              if (node) {
                following.current = false;
                node.scrollIntoView({ block: 'center' });
              }
            });
          }}
          liveActivity={summarized ? { taskId: summarized.id, view: liveActivity } : undefined}
          onOpenTarget={
            props.onOpenTarget &&
            (async (target) => {
              await props.onOpenTarget!(target);
              setTaskHistory(null);
            })
          }
          onOpenChange={
            props.onOpenChange &&
            (async (change) => {
              await props.onOpenChange!(change);
              setTaskHistory(null);
            })
          }
          rollbackUnavailable={pending.length > 0 || busy}
        />
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
            className="primary"
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
              expanded={liveActivityOpen}
              collapsed={!liveActivityOpen}
              toggleLabel={t('helperConversation.activity')}
              toggleTitle={t('helperConversation.activity')}
              onToggle={toggleLiveActivity}
              onDetails={() => setTaskHistory({ taskId: summarized.id })}
              testId="helper-current-activity"
            />
            {liveActivityOpen && (
              <HelperLiveActivity
                taskId={summarized.id}
                status={summarized.status}
                visible={props.open}
                source={liveActivity}
              />
            )}
          </>
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
                {(recoveryReadFailed[scopeKey] || !attachments.ready) && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      retryRecoveryRead();
                      retryHandoff();
                      void attachments.retry();
                    }}
                  >
                    {t('helpers.m102')}
                  </button>
                )}
                {!recoveryReadFailed[scopeKey] && failedRecoveryWrites.length > 0 && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      void Promise.allSettled(failedRecoveryWrites.map(retryHelperRecoveryWrite));
                    }}
                  >
                    {t('prompts.uiSaveAgain')}
                  </button>
                )}
                {!recoveryError && (
                  <IconButton
                    icon={CloseIcon}
                    size={18}
                    label={t('helpers.m078')}
                    className="secondary"
                    onClick={() => {
                      setError('');
                      data.setError('');
                      sessions.clearError();
                      attachments.clearError();
                    }}
                  />
                )}
              </>
            }
          >
            {translateMessage(error)}
          </NoticeBanner>
        )}
        {(pendingSteers.length > 0 || queuedTasks.length > 0) && (
          <div
            className="helper-followup-tray"
            aria-label={t('helpers.followUpTrayLabel')}
            data-testid="helper-followup-tray"
          >
            {pendingSteers.map((instruction) => (
              <div
                key={`steer-${instruction.id}`}
                className="helper-followup-item"
                data-kind="steer"
              >
                <span className="helper-followup-badge" data-kind="steer">
                  {t('helpers.followUpSteerBadge')}
                </span>
                <span className="helper-followup-text">{instruction.text}</span>
                <small className="helper-followup-meta">{t('helpers.followUpSteerPending')}</small>
              </div>
            ))}
            {queuedTasks.map((queuedTask, index) => (
              <div
                key={`queue-${queuedTask.id}`}
                className="helper-followup-item"
                data-kind="queue"
              >
                <span className="helper-followup-badge" data-kind="queue">
                  {t('helpers.followUpQueueBadge')}
                </span>
                <span className="helper-followup-text">{queuedTask.request}</span>
                <small className="helper-followup-meta">
                  {t('helpers.followUpQueueOrder', { index: index + 1 })}
                </small>
                <button
                  type="button"
                  className="helper-chip-dismiss"
                  aria-label={t('helpers.m030')}
                  onClick={() => void cancel(queuedTask)}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}
        {mentionOpen && (
          <HelperMentionMenu
            items={mentionItems}
            selectedIndex={mentionIndex}
            loading={mentionLoading}
            onSelect={chooseMention}
            onHover={setMentionIndex}
          />
        )}
        {editorSuggestions.length > 0 && (
          <div className="helper-editor-suggestions">
            {editorUnsaved && <p className="muted">{t('editorHelper.unsavedNote')}</p>}
            <ul className="helper-start-list" aria-label={t('editorHelper.suggestions')}>
              {editorSuggestions.map((suggestion) => (
                <li key={suggestion}>
                  <button
                    type="button"
                    className="secondary"
                    disabled={props.ready === false || !hydrated[scopeKey] || !attachments.ready}
                    onClick={() => {
                      editDraft(suggestion);
                      input.current?.focus();
                    }}
                  >
                    {suggestion}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <ChatComposer
          className="helper-request-composer"
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes('Files')) event.preventDefault();
          }}
          onDrop={(event) => {
            if (!event.dataTransfer.files.length) return;
            event.preventDefault();
            if (props.ready !== false && conversation && hydrated[scopeKey] && !busy)
              void attachments.addFiles(Array.from(event.dataTransfer.files));
          }}
          onSubmit={(event) => {
            event.preventDefault();
            if (hydrated[scopeKey]) submitRequest();
          }}
        >
          <HelperDraftAttachments
            draft={attachments.draft}
            remove={attachments.remove}
            disabled={!hydrated[scopeKey] || busy || attachments.busy}
          />
          {(currentResource ||
            (displayEditor && !currentResource) ||
            selectedOutline ||
            selection ||
            grantList.length > 0 ||
            mentionRefs.length > 0) && (
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
                <div className="helper-context-chip helper-editor helper-editor-draft">
                  <span className="helper-chip-label">
                    {t('helpers.m317', { title: displayEditor.title || t('helpers.m085') })}
                  </span>
                  {editorUnsaved && (
                    <>
                      <span className="helper-chip-badge helper-editor-unsaved">
                        {t('editorHelper.unsaved')}
                      </span>
                      <button
                        type="button"
                        className="helper-chip-action"
                        aria-label={t('editorHelper.saveEditor')}
                        onClick={() => void saveActiveEditor()}
                      >
                        {t('shared.save')}
                      </button>
                    </>
                  )}
                </div>
              )}
              {shownFocus &&
                displayEditor &&
                (() => {
                  const parts = editorFocusParts(displayEditor.kind, shownFocus);
                  return (
                    <div
                      className="helper-context-chip helper-editor-focus"
                      data-testid="helper-editor-focus"
                      aria-label={t('editorHelper.focusLabel')}
                      role="group"
                    >
                      <span className="helper-chip-badge">{parts.place}</span>
                      {parts.detail && <span className="helper-chip-label">{parts.detail}</span>}
                      <button
                        type="button"
                        className="helper-chip-dismiss"
                        aria-label={t('editorHelper.focusRemove')}
                        onClick={() =>
                          setDetachedFocus((old) => ({ ...old, [scopeKey]: editorFocusId }))
                        }
                      >
                        <X size={14} aria-hidden="true" />
                      </button>
                    </div>
                  );
                })()}
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
                      disabled={!hydrated[scopeKey]}
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
                    disabled={!hydrated[scopeKey]}
                    onClick={() => {
                      setOutlineSelections((old) => ({ ...old, [scopeKey]: null }));
                      saveLocal(`helper-outline:${scopeKey}`, null);
                      if (draft === selectedOutline.request) editDraft('');
                    }}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
              )}
              {grantList.map((grant) => (
                <div key={grant.id} className="helper-context-chip helper-confirmation-chip">
                  <span className="helper-chip-label">
                    {t('helperConfirm.chip', { operation: grant.operation })}
                  </span>
                  <button
                    type="button"
                    className="helper-chip-dismiss"
                    aria-label={t('helperConfirm.removeChip', { operation: grant.operation })}
                    onClick={() =>
                      setGrants((old) => ({
                        ...old,
                        [scopeKey]: (old[scopeKey] ?? []).filter((item) => item.id !== grant.id),
                      }))
                    }
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
              ))}
              {mentionRefs.map((ref) => {
                const label = helperReferenceLabel(ref);
                return (
                  <div
                    key={referenceKey(ref)}
                    className="helper-context-chip helper-mention-chip"
                    data-testid="helper-mention-chip"
                  >
                    <span className="helper-chip-badge">{helperReferenceKindLabel(ref)}</span>
                    <span className="helper-chip-label">{label}</span>
                    <button
                      type="button"
                      className="helper-chip-dismiss"
                      aria-label={t('helpers.mentionRemove', { label })}
                      onClick={() =>
                        setMentionRefsByScope((old) => ({
                          ...old,
                          [scopeKey]: (old[scopeKey] ?? []).filter(
                            (item) => referenceKey(item) !== referenceKey(ref)
                          ),
                        }))
                      }
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  </div>
                );
              })}
              {selection && (
                <div className="helper-context-chip helper-selection">
                  <details>
                    <summary>{t('helpers.m318', { count: selection.text.length })}</summary>
                    <p>{selection.text}</p>
                  </details>
                  <button
                    type="button"
                    className="helper-chip-dismiss"
                    aria-label={t('helpers.m093')}
                    disabled={!hydrated[scopeKey]}
                    onClick={() => {
                      if (draft === selectionRequest()) editDraft('');
                      setSelections((old) => ({ ...old, [scopeKey]: null }));
                      saveLocal(`helper-selection:${scopeKey}`, null);
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
            disabled={inputDisabled}
            placeholder={
              compact
                ? t('helpers.m104')
                : t('helpers.requestPlaceholder', { key: sendKeyLabel(props.enterSend) })
            }
            maxLength={REQUEST_TEXT_MAX_CHARS}
            onChange={(event) => {
              editDraft(event.target.value);
              syncMentionTrigger(event.target.value, event.target.selectionStart);
            }}
            onClick={(event) =>
              syncMentionTrigger(event.currentTarget.value, event.currentTarget.selectionStart)
            }
            onKeyUp={(event) => {
              if (
                ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Backspace', 'Delete'].includes(
                  event.key
                )
              )
                syncMentionTrigger(event.currentTarget.value, event.currentTarget.selectionStart);
            }}
            onKeyDown={(event) => {
              if (!mentionOpen || event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                if (mentionTrigger)
                  mentionDismissed.current = `${mentionTrigger.start}:${mentionTrigger.query}`;
                setMentionTrigger(null);
                return;
              }
              if (!mentionItems.length) return;
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setMentionIndex((index) => (index + 1) % mentionItems.length);
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setMentionIndex((index) => (index - 1 + mentionItems.length) % mentionItems.length);
              } else if (
                (event.key === 'Enter' || event.key === 'Tab') &&
                !event.ctrlKey &&
                !event.metaKey &&
                !event.altKey &&
                !event.shiftKey
              ) {
                event.preventDefault();
                const chosen = mentionItems[mentionIndex];
                if (chosen) chooseMention(chosen);
              }
            }}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (!files.length) return;
              event.preventDefault();
              if (!busy) void attachments.addFiles(files);
            }}
            onSend={submitRequest}
            onAlternateSend={
              running && !outbox
                ? () => {
                    if (runningSendMode === 'steer') void send();
                    else if (draft.trim() && !attachments.hasAttachments)
                      void send(undefined, false, running.id);
                  }
                : undefined
            }
          />
          <div className="quick-controls">
            <HelperAttachmentPicker
              accept={attachments.accept}
              disabled={
                props.ready === false ||
                !conversation ||
                !hydrated[scopeKey] ||
                !attachments.ready ||
                busy ||
                attachments.busy
              }
              addFiles={attachments.addFiles}
            />
            {modelChip}
            <button
              type="button"
              className="model-chip secondary helper-model-chip helper-mode-chip"
              data-mode={mode}
              aria-label={t('helperPlan.modeLabel', {
                mode: t(mode === 'plan' ? 'helperPlan.plan' : 'helperPlan.apply'),
              })}
              title={t('helperPlan.modeHint', { key: helperModeShortcutLabel })}
              disabled={!conversation}
              onClick={toggleMode}
            >
              {mode === 'plan' ? (
                <ListChecks size={16} aria-hidden="true" />
              ) : (
                <PenLine size={16} aria-hidden="true" />
              )}
              <span>{t(mode === 'plan' ? 'helperPlan.planShort' : 'helperPlan.applyShort')}</span>
            </button>
            {running && (
              <button
                type="button"
                className="model-chip secondary helper-model-chip helper-running-mode"
                data-mode={steering ? 'steer' : 'queue'}
                data-testid="helper-running-mode"
                aria-label={t('helpers.runningSendModeLabel', {
                  mode: t(steering ? 'helpers.followUpSteerBadge' : 'helpers.followUpQueueBadge'),
                })}
                title={
                  attachments.hasAttachments
                    ? t('helpers.followUpSteerAttachmentsNote')
                    : t(steering ? 'helpers.followUpHintSteer' : 'helpers.followUpHintQueue', {
                        sendKey: sendKeyLabel(props.enterSend),
                        altKey: isApplePlatform() ? 'Option+Enter' : 'Alt+Enter',
                      })
                }
                disabled={attachments.hasAttachments}
                onClick={() =>
                  updateRunningSendMode(runningSendMode === 'steer' ? 'queue' : 'steer')
                }
              >
                {steering ? (
                  <CornerDownRight size={16} aria-hidden="true" />
                ) : (
                  <ListEnd size={16} aria-hidden="true" />
                )}
                <span>
                  {t(steering ? 'helpers.followUpSteerBadge' : 'helpers.followUpQueueBadge')}
                </span>
              </button>
            )}
            {shownUsage && (
              <HelperContextUsage
                usage={shownUsage}
                context={data.current?.context}
                busy={busy || activeTask || data.loading}
                starting={Boolean(compactStarting[scopeKey])}
                compactError={compactErrors[scopeKey] ?? ''}
                onCompact={() => void compactionRequest('POST')}
                onCancel={() => void compactionRequest('DELETE')}
                onShowSummary={() => setSummaryDialog(scopeKey)}
              />
            )}
          </div>
          <div className="send-actions">
            {running && (
              <button
                className="send-button helper-stop"
                type="button"
                aria-label={t('helpers.m031')}
                title={t('helpers.m031')}
                onClick={() => void cancel(running)}
              >
                <Square size={18} aria-hidden="true" />
              </button>
            )}
            <button
              className="send-button"
              type="submit"
              aria-label={
                outbox
                  ? t('helpers.m109')
                  : !running
                    ? t('helpers.m110')
                    : steering
                      ? t('helpers.m108')
                      : t('helpers.queueRequest')
              }
              title={
                outbox
                  ? t('helpers.m096')
                  : !running
                    ? t('helpers.m110')
                    : steering
                      ? t('helpers.m107')
                      : t('helpers.queueRequest')
              }
              disabled={submitDisabled}
            >
              <ArrowUp size={20} aria-hidden="true" />
            </button>
          </div>
        </ChatComposer>
      </footer>
    </aside>
  );
});
