import { t, useI18n, loadInitialLocale } from './i18n.js';
import { toUiMessage } from './api-errors.js';
import {
  formatUiMessage,
  sameUiMessage,
  UiError,
  uiMessage,
  type UiMessage,
} from './ui-message.js';
import { imageInputSupported } from '../core/provider-image-reference.js';
import { DraftRequestImages } from './RequestImages.js';
import { downloadArchive } from './archive-download.js';
import { ReaderEditingContext } from './Bookmarks.js';
import { ResourceAnchorContext, type ResourceAnchor } from './resource-anchor.js';
import { EditorHelperContext } from './editor-helper.js';
import type { EditorFocus } from '../core/editor-focus.js';
import type { NotificationIntent } from '../core/push.js';
import { startPwa, subscribeNotificationNavigation } from './pwa.js';
import type { ReaderTarget } from '../core/reader-target.js';
import { ThemeProvider, useThemes } from './ThemeContext.js';
import { FontProvider, useFonts } from './FontContext.js';
import { REQUEST_TEXT_MAX_CHARS } from '../core/content-limits.js';
import { promptControls } from '../core/risu-prompt.js';
import { DraftDiscardActions } from './DraftDiscardActions.js';
import type { BotChatImportDialog as BotChatImportDialogPanel } from './BotChatImportDialog.js';
import { ReadingSettingsSearch } from './ReadingSettingsSearch.js';
import { ReadabilitySettings } from './ReadabilitySettings.js';
import { Switch } from './BooleanControls.js';
import { ReadingPreferencesContext } from './ReadingPreferencesContext.js';
import { useReadingPreferences } from './useReadingPreferences.js';
import { RequestMessage } from './RequestMessage.js';
import { RetryFailure } from './RetryFailure.js';
import { isModelSelectable } from './model-selection.js';
import { combinationOwner, matchesPromptCombination } from '../core/prompt-combinations.js';
import { DismissibleError } from './DismissibleError.js';
import { NoticeBanner } from './NoticeBanner.js';
import { TransientNotice, TransientNoticeProvider } from './TransientNotice.js';
import { ShortcutKeys, useShortcut, useShortcutLabel } from './shortcuts.js';
import { ReaderLoadingState } from './ReaderLoadingState.js';
import { ChatComposer, ComposerInput, sendKeyLabel } from './ChatComposer.js';
import { InputTranslationControls, InputTranslationFeedback } from './InputTranslation.js';
import { ComposerMore, LoreResetChip } from './ComposerMore.js';
import type { ChatContextDialog as ChatContextDialogPanel } from './ChatContextDialog.js';
import { ChatModelPicker } from './ChatModelPicker.js';
import type { RequestPreviewDialog as RequestPreviewDialogPanel } from './RequestPreviewDialog.js';
import type { ManuscriptExportDialog as ManuscriptExportDialogPanel } from './ManuscriptExportDialog.js';
import { ManuscriptSearchPanel } from './ManuscriptSearch.js';
import { IconButton } from './IconButton.js';
import {
  PinIcon,
  CloseIcon,
  DownIcon,
  HelperIcon,
  NewChatIcon,
  LibraryIcon,
  BotIcon,
  PersonaIcon,
  ModuleIcon,
  PromptIcon,
} from './ui-icons.js';
import { ActionMenu } from './ActionMenu.js';
import { useCompactLayout } from './useCompactLayout.js';
import { subscribeAppHistory } from './app-history.js';
import { ChatPromptOptions } from './ChatPromptOptions.js';
import type { HelperHandoff } from './HelperPanel.js';
import { api } from './api.js';
import { selectedHelperSession } from './useHelperSessions.js';
import type { HelperRecentTask } from '../core/activity-feed.js';
import type {
  HelperChange,
  HelperScope,
  HelperResourceRef,
  HelperTaskResultTarget,
} from '../core/helper.js';
import { ResponseDisplay } from './StreamingResponse.js';
import { CancelledRun } from './CancelledRun.js';
import { canDismissReaderRun } from '../core/reader-conversation.js';
import {
  readPresentationChoice,
  readFontSize,
  usePresentationSetting,
  watchPresentationWriteFailure,
  type ResponseDisplayMode,
} from './presentation-settings.js';
import {
  captureActiveEditorContext,
  discardActiveEditor,
  getActiveEditorContext,
  saveActiveEditor,
  ResourceEditorLeaveWarning,
} from './resource-editor.js';
import type { Section as ChatSettingsSection } from './ChatSettingsPanel.js';
import { ReaderPages } from './ReaderPages.js';
import { SceneNavigator } from './SceneNavigator.js';
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  useComposerDraftEmpty,
  useComposerDraftText,
  type ComposerDraft,
} from './composer-draft.js';
import { useStableHandler } from './useStableHandler.js';
import { useBottomFollow } from './useBottomFollow.js';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowUp,
  BookOpen,
  ChevronDown,
  BookOpenText,
  DatabaseBackup,
  Eye,
  GitFork,
  ImagePlus,
  ListEnd,
  ListTree,
  Maximize,
  Menu,
  Minimize,
  RefreshCw,
  SlidersHorizontal,
  Square,
  Type,
  X,
} from 'lucide-react';
import type { Content } from '../core/product.js';
import { refValue } from './content-ref.js';
import { deferredPanel } from './deferredPanel.js';
import { LoadingState } from './LoadingState.js';
import { ContentPicker } from './ContentPicker.js';
import { ContentAvatar } from './ContentAvatar.js';
import { ReaderGallery, ReaderPortraitButton } from './ReaderGallery.js';
import { contentPortraitUrl } from './content-portrait.js';
import { ThemeBackground } from './ThemeBackground.js';
import type { ContentRole } from '../core/risu-content.js';
import { SourceReader } from './SourceReader.js';
import { pendingSceneDeletions, SceneDeleteDialog } from './SceneDeleteAction.js';
import type { SceneDeletionResult } from '../core/scene-deletion.js';
import { TurnActivity } from './TurnActivity.js';
import { SessionGate, SessionRequiredContext } from './SessionGate.js';
import { CommandPalette, type PaletteEntry } from './CommandPalette.js';
import { getSettingsCategories } from './settings-categories.js';
import { libraryCategory } from '../core/library-organization.js';
import { MaintenanceBanner } from './MaintenanceBanner.js';
import { Dialog } from './Dialog.js';
import { CodexContentWarningDialog } from './CodexContentWarningDialog.js';
import { DeleteButton } from './DeleteButton.js';
import { BotNavigation, NavigationQuickActions, type ChatFolder } from './BotTreeNavigation.js';
import {
  completePendingStoryProfile,
  PendingStoryProfileConflict,
  acceptSavedStoryProfile,
} from './pendingStory.js';
import { useStory } from './useStory.js';
import { useTestMode } from './useTestMode.js';
import { ActivityStatus } from './ActivityStatus.js';
import { NextRequestStatus } from './NextRequestStatus.js';
import { focusSidePanelTab, SidePanelTabs } from './SidePanelTabs.js';
import { StoryBoardPanel, useStoryBoard } from './StoryBoardPanel.js';
import { SidePanelResizer } from './SidePanelResizer.js';
import {
  fitSidePanelWidth,
  MIN_CENTER_WIDTH,
  readSidePanelWidth,
  readWorkspacePanelState,
  SIDE_PANEL_MAX_WIDTH,
  sidePanelMinimumWidth,
  writeWorkspacePanelState,
  type SidePanelTab,
} from './side-panel.js';
import { modelLabel } from './storyLabels.js';
import { forgetChatStorage, storageKeys, sweepUnregisteredStorage } from './storage-keys.js';
import './style.css';
import './product.css';
import './sidebar.css';
import './side-panel.css';

function workspaceFallback(title: UiMessage, navigation: ReactNode, content: ReactNode) {
  return (
    <>
      <header className="workspace-header">
        {navigation}
        <div className="header-title">
          <h1>{formatUiMessage(title)}</h1>
        </div>
      </header>
      <div className="workspace-fallback-body">{content}</div>
    </>
  );
}
const noSources: import('../core/types.js').Source[] = [];
const LibraryPanel = deferredPanel(
  uiMessage('main.m001'),
  async () => ({
    default: (await import('./LibraryPanel.js')).LibraryPanel,
  }),
  (content, props) => workspaceFallback(uiMessage('main.m001'), props.headerLeading, content)
);
const PromptLibrary = deferredPanel(
  uiMessage('transfer.m286'),
  async () => ({
    default: (await import('./PromptLibrary.js')).PromptLibrary,
  }),
  (content, props) => workspaceFallback(uiMessage('transfer.m286'), props.headerLeading, content)
);
const ChatSettingsPanel = deferredPanel(
  uiMessage('main.m003'),
  async () => ({
    default: (await import('./ChatSettingsPanel.js')).ChatSettingsPanel,
  }),
  (content, props) => (
    <Dialog open title={t('main.m003')} onClose={props.onClose} wide className="settings-dialog">
      {content}
    </Dialog>
  )
);
const NewStory = deferredPanel(uiMessage('transfer.m246'), async () => ({
  default: (await import('./NewStory.js')).NewStory,
}));
const AppSettingsPanel = deferredPanel(
  uiMessage('main.m005'),
  async () => ({
    default: (await import('./WorkspacePanels.js')).AppSettingsPanel,
  }),
  (content, props) => (
    <Dialog open title={t('main.m005')} onClose={props.onClose} wide className="settings-dialog">
      {content}
    </Dialog>
  )
);

const HelperPanel = deferredPanel(
  uiMessage('visualpanels.helper'),
  async () => ({
    default: (await import('./HelperPanel.js')).HelperPanel,
  }),
  (content, props) => (props.open ? <aside className="helper-panel">{content}</aside> : null)
);
const TasksPanel = deferredPanel(uiMessage('main.m006'), async () => ({
  default: (await import('./WorkspacePanels.js')).TasksPanel,
}));
const OutlinePanel = deferredPanel(uiMessage('prompts.uiStoryOutline'), async () => ({
  default: (await import('./OutlinePanel.js')).OutlinePanel,
}));
const BotChatImportDialog = deferredPanel<ComponentProps<typeof BotChatImportDialogPanel>>(
  uiMessage('transfer.m106'),
  async () => ({ default: (await import('./BotChatImportDialog.js')).BotChatImportDialog }),
  (content, props) => (
    <Dialog open title={t('transfer.m106')} onClose={props.onClose}>
      {content}
    </Dialog>
  )
);
const RequestPreviewDialog = deferredPanel<ComponentProps<typeof RequestPreviewDialogPanel>>(
  uiMessage('reader.nextRequestPreview'),
  async () => ({ default: (await import('./RequestPreviewDialog.js')).RequestPreviewDialog }),
  (content, props) => (
    <Dialog open={props.open} title={t('reader.nextRequestPreview')} onClose={props.onClose}>
      {content}
    </Dialog>
  )
);
const ManuscriptExportDialog = deferredPanel<ComponentProps<typeof ManuscriptExportDialogPanel>>(
  uiMessage('transfer.m192'),
  async () => ({ default: (await import('./ManuscriptExportDialog.js')).ManuscriptExportDialog }),
  (content, props) => (
    <Dialog open={props.open} title={t('transfer.m192')} onClose={props.onClose}>
      {content}
    </Dialog>
  )
);
const ChatContextDialog = deferredPanel<ComponentProps<typeof ChatContextDialogPanel>>(
  uiMessage('settings.m104'),
  async () => ({ default: (await import('./ChatContextDialog.js')).ChatContextDialog }),
  (content, props) => (
    <Dialog
      open={!!props.mode}
      title={t(props.mode === 'compact' ? 'settings.m105' : 'settings.m104')}
      onClose={props.onClose}
    >
      {content}
    </Dialog>
  )
);
function useOpenedOnce(open: boolean) {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return opened || open;
}

type Panel =
  | ''
  | 'navigation'
  | 'new'
  | 'story'
  | 'tasks'
  | 'settings'
  | 'reading'
  | 'outline'
  | 'model';
const READING_WIDTHS = [760, 880, 1040];
const SIDEBAR_WIDTH = 248;
const SIDEBAR_WIDTHS = [SIDEBAR_WIDTH, 320, 400];
const RAIL_WIDTH = 56;
const runFailed = (status: string) =>
  ['failed', 'cancelled', 'interrupted', 'refused', 'partial'].includes(status);
function DraftComposerInput({
  draft,
  ...props
}: Omit<ComponentProps<typeof ComposerInput>, 'value'> & { draft: ComposerDraft }) {
  return <ComposerInput {...props} value={useComposerDraftText(draft)} />;
}
function DraftRequestPreviewDialog({
  draft,
  ...props
}: Omit<ComponentProps<typeof RequestPreviewDialogPanel>, 'request'> & { draft: ComposerDraft }) {
  return <RequestPreviewDialog {...props} request={useComposerDraftText(draft)} />;
}
function App() {
  const { locale } = useI18n();
  const s = useStory();
  const readerContent = useRef<HTMLElement>(null);
  const readerFollow = useBottomFollow(
    s.reader,
    readerContent,
    !!s.active || s.submitting.includes(s.viewKey),
    false
  );
  const generate: typeof s.generate = (...args) => {
    readerFollow.follow();
    return s.generate(...args);
  };
  const latestGenerate = useRef(generate);
  latestGenerate.current = generate;
  const readerFollowing = readerFollow.following;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Changing the chat ends following the previous chat.
  useEffect(() => {
    readerFollowing.current = false;
  }, [s.viewKey]);
  const draftEmpty = useComposerDraftEmpty(s.composerDraft);
  const { setScope: setThemeScope } = useThemes();
  const themeChatId = s.destination === 'story' ? s.selected : undefined;
  const themeBotId = themeChatId
    ? s.chats.find((chat) => chat.id === themeChatId)?.botId
    : undefined;
  useEffect(() => {
    setThemeScope({ chatId: themeChatId || undefined, botId: themeBotId });
  }, [themeChatId, themeBotId, setThemeScope]);
  const [nativeNotices, setNativeNotices] = useState<string[]>([]);
  const [sceneDeletion, setSceneDeletion] = useState<{
    chatId: string;
    sourceId: string;
    onDeleted: (result: SceneDeletionResult) => Promise<void>;
  } | null>(null);
  const [sceneDeletionVersion, setSceneDeletionVersion] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The version invalidates the session storage snapshot.
  const pendingScenes = useMemo(
    () => pendingSceneDeletions(s.selected),
    [s.selected, sceneDeletionVersion]
  );
  const openSceneDeletion = (chatId: string, sourceId: string) => {
    setSceneDeletion({ chatId, sourceId, onDeleted: s.sceneDeletionCompletion(chatId) });
  };
  const testMode = useTestMode();
  const compact = useCompactLayout();

  const [sceneList, setSceneList] = useState(false);
  const sceneListOpener = useRef<HTMLButtonElement>(null);
  const [scenePosition, setScenePosition] = useState<{ scope: string; label: string } | null>(null);
  const updateScenePosition = useCallback(
    (label: string) => setScenePosition({ scope: s.viewKey, label }),
    [s.viewKey]
  );
  const [latestPosition, setLatestPosition] = useState<{ scope: string; visible: boolean } | null>(
    null
  );
  const updateLatestPosition = useCallback(
    (visible: boolean) => setLatestPosition({ scope: s.viewKey, visible }),
    [s.viewKey]
  );
  const sceneCount = s.detail?.reader.navigation.length ?? 0;
  const [settingsSection, setSettingsSection] = useState<ChatSettingsSection | undefined>();
  const openChatSettings = (section?: ChatSettingsSection) => {
    setSettingsSection(section);
    setPanel('story');
  };
  const [seenRuns, setSeenRuns] = useState<string[]>([]);
  const pendingObserver = useRef<IntersectionObserver | null>(null);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.runId;
          if (id && entry.isIntersecting)
            setSeenRuns((old) => (old.includes(id) ? old : [...old, id]));
        }
      },
      { threshold: 0.4 }
    );
    pendingObserver.current = observer;
    return () => observer.disconnect();
  }, []);
  const menuReturn = useRef<HTMLElement | null>(null);
  const fromChatMenu = (event: { currentTarget: HTMLElement }) => {
    menuReturn.current =
      event.currentTarget.closest('.chat-menu')?.querySelector<HTMLElement>('summary') ?? null;
  };
  const [settingsTab, setSettingsTab] = useState<string | undefined>();
  const [storyUiThemeTarget, setStoryUiThemeTarget] = useState<{ botId: string; title: string }>();
  const [promptToEdit, setPromptToEdit] = useState<string | null>(null);
  const [helperResource, setHelperResource] = useState<HelperResourceRef | null>(null);
  const clearHelperResource = useCallback(() => setHelperResource(null), []);
  const [restoredPanel] = useState(() => {
    const state = readWorkspacePanelState();
    if (compact) return 'closed';
    if (
      state !== 'helper-workspace' &&
      innerWidth - RAIL_WIDTH - MIN_CENTER_WIDTH < sidePanelMinimumWidth('helper')
    )
      return 'closed';
    return state;
  });
  const [workspacePanel, setWorkspacePanel] = useState<SidePanelTab | null>(
    restoredPanel === 'helper' || restoredPanel === 'helper-workspace' ? 'helper' : null
  );
  const lastSidePanelTab = useRef<SidePanelTab>('helper');
  useEffect(() => {
    if (workspacePanel) lastSidePanelTab.current = workspacePanel;
  }, [workspacePanel]);
  const [helperExpanded, setHelperExpanded] = useState(restoredPanel === 'helper-workspace');
  const [helperScope, setHelperScope] = useState<HelperScope | null>(null);
  const rememberHelperScope = useCallback((next: HelperScope) => {
    setHelperScope((previous) =>
      JSON.stringify(previous) === JSON.stringify(next) ? previous : next
    );
  }, []);
  const helperReturnToSidecar = useRef(false);
  const [helperNavigationHost, setHelperNavigationHost] = useState<HTMLDivElement | null>(null);
  const helperNavigationActions = useRef<{ create: () => void; activity: () => void } | null>(null);
  const [helperSearchRequest, setHelperSearchRequest] = useState(0);
  const [contentToOpen, setContentToOpen] = useState<string | null>(null);
  const [resourceAnchor, setResourceAnchor] = useState<ResourceAnchor | null>(null);
  const consumeResourceAnchor = useCallback(
    (epoch: number) => setResourceAnchor((current) => (current?.epoch === epoch ? null : current)),
    []
  );
  const resourceAnchorRequest = useMemo(
    () => ({ anchor: resourceAnchor, consume: consumeResourceAnchor }),
    [resourceAnchor, consumeResourceAnchor]
  );
  const helperResultNavigation = useRef(0);
  const helperAnchorEpoch = useRef(0);
  const [helperNavigation, setHelperNavigation] = useState<{
    conversationId: string;
    taskId: string;
    sequence: number;
    epoch: number;
  } | null>(null);
  const optionsOpen = workspacePanel === 'options';
  const helperOpen = workspacePanel === 'helper';
  const helperWorkspaceOpen = helperOpen && helperExpanded;
  useEffect(() => {
    if (!helperOpen) setHelperScope(null);
  }, [helperOpen]);
  const [optionsDirty, setOptionsDirty] = useState(false),
    [optionsBusy, setOptionsBusy] = useState(false);
  const inputTranslationDisabled =
    !s.draftReady ||
    optionsBusy ||
    !s.detail ||
    s.pendingProfile ||
    s.hasPendingRequest ||
    s.submitting.includes(s.viewKey);
  const helperHandoffEpoch = useRef(0);
  const [helperHandoff, setHelperHandoff] = useState<HelperHandoff>();
  const [helperMounted, setHelperMounted] = useState(false);
  if (!helperMounted && (helperOpen || !!helperHandoff || !!helperNavigation))
    setHelperMounted(true);
  const [editingSources, setEditingSources] = useState<string[]>([]);
  const onSourceEditing = useCallback((sourceId: string, editing: boolean) => {
    setEditingSources((current) =>
      editing === current.includes(sourceId)
        ? current
        : editing
          ? [...current, sourceId]
          : current.filter((id) => id !== sourceId)
    );
  }, []);
  const sourceEditing = editingSources.length > 0;
  const [requestDecision, setRequestDecision] = useState<{
    scope: string;
    kind: 'profile' | 'admission';
  } | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileSaveError, setProfileSaveError] = useState<UiMessage | null>(null);
  const [profileConflict, setProfileConflict] = useState<{
    chatId: string;
    savedIntent: string;
  } | null>(null);
  const currentRequestDecision =
    requestDecision?.scope === s.viewKey &&
    (requestDecision.kind === 'profile' ? s.pendingProfile : s.hasPendingRequest)
      ? requestDecision.kind
      : null;
  useEffect(() => {
    if (requestDecision && !currentRequestDecision) setRequestDecision(null);
  }, [requestDecision, currentRequestDecision]);
  const submitRequest = async (checkingEditedRequest = false) => {
    if (
      optionsBusy ||
      (sourceEditing && !checkingEditedRequest) ||
      s.submitting.includes(s.viewKey)
    )
      return false;
    if (s.active && !s.pendingProfile && !s.hasPendingRequest && !checkingEditedRequest)
      return s.queueRequest();
    if (s.pendingProfile || s.hasPendingRequest) {
      setProfileSaveError(null);
      setProfileConflict(null);
      setRequestDecision({ scope: s.viewKey, kind: s.pendingProfile ? 'profile' : 'admission' });
      return false;
    }
    return generate();
  };
  const optionsButton = useRef<HTMLButtonElement>(null);
  const requestImageInput = useRef<HTMLInputElement>(null);
  const [panel, setPanel] = useState<Panel>('');
  const [outlineTarget, setOutlineTarget] = useState<{ nodeId: string; epoch: number } | null>(
    null
  );
  useEffect(() => {
    if (panel !== 'settings') setStoryUiThemeTarget(undefined);
  }, [panel]);
  const [searchingChats, setSearchingChats] = useState(false);
  const [keyboardSearch, setKeyboardSearch] = useState<{ query: string } | null>(null);
  const searchOpener = useRef<HTMLElement | null>(null);
  const openChatSearch = () => {
    searchOpener.current = document.activeElement as HTMLElement | null;
    setKeyboardSearch(null);
    setSearchingChats(true);
  };
  const searchFromKeyboard = (query = '') => {
    openChatSearch();
    setKeyboardSearch({ query });
  };
  const openWorkspaceSearch = () => {
    if (!helperWorkspaceOpen) return openChatSearch();
    if (compact) setPanel('navigation');
    else setSidebarCollapsed(false);
    setHelperSearchRequest((value) => value + 1);
  };
  const createHelperSession = () => {
    helperNavigationActions.current?.create();
    if (panel === 'navigation') setPanel('');
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new chat starts with the list closed and nothing seen yet.
  useEffect(() => {
    setSceneList(false);
    setSeenRuns([]);
  }, [s.viewKey]);
  useEffect(() => {
    if (panel !== '' || !menuReturn.current) return;
    const target = menuReturn.current;
    menuReturn.current = null;
    const frame = requestAnimationFrame(() => target.focus());
    return () => cancelAnimationFrame(frame);
  }, [panel]);
  const [initialBot, setInitialBot] = useState<Content>();
  const [initialFolder, setInitialFolder] = useState<ChatFolder>();
  const [initialPersona, setInitialPersona] = useState<Content>();
  const [initialModules, setInitialModules] = useState<Content[] | undefined>();
  const [quickStartNew, setQuickStartNew] = useState(false);
  const [moduleToUse, setModuleToUse] = useState<Content | null>(null);
  const [libraryTab, setLibraryTab] = useState<'bot' | 'persona' | 'module' | 'prompts'>('bot');
  useEffect(() => {
    if (s.destination !== 'library' || libraryTab !== 'prompts') setHelperResource(null);
  }, [s.destination, libraryTab]);
  const [libraryListRequest, setLibraryListRequest] = useState(0);
  const errorScope = `${s.destination}:${libraryTab}:${s.viewKey}`;
  const previousErrorScope = useRef(errorScope);
  useEffect(() => {
    if (previousErrorScope.current !== errorScope) {
      previousErrorScope.current = errorScope;
      s.setError(null);
    }
  }, [errorScope, s.setError]);
  useEffect(
    () => watchPresentationWriteFailure(() => s.setError(uiMessage('main.settingNotStored'))),
    [s.setError]
  );
  const [newKey, setNewKey] = useState(0);
  const newStoryView = useRef({ key: newKey, active: panel === 'new' });
  newStoryView.current = { key: newKey, active: panel === 'new' };
  const modelPickerScope = useRef<string | null>(null);
  modelPickerScope.current = panel === 'model' ? s.viewKey : null;
  const settingsReturnToNew = useRef(false);
  const [focus, setFocus] = useState(false);
  const [sceneNavigatorEnabled, setSceneNavigatorEnabled] = usePresentationSetting(
    storageKeys.sceneNavigator,
    () => readPresentationChoice(storageKeys.sceneNavigator, ['true', 'false'], 'true') === 'true'
  );
  const showSceneNavigator = sceneNavigatorEnabled && !focus;
  useEffect(() => {
    if (focus) setSceneList(false);
  }, [focus]);
  const [inspectedRun, setInspectedRun] = useState('');
  const [chatTool, setChatTool] = useState<{
    scope: string;
    kind: 'lore' | 'compact' | 'export' | 'preview';
  } | null>(null);
  const currentChatTool = chatTool?.scope === s.viewKey ? chatTool.kind : null;
  const navigationOpener = useRef<HTMLButtonElement>(null);
  const navigationReturnFocus = useRef<HTMLButtonElement>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = usePresentationSetting(
    storageKeys.sidebarCollapsed,
    () =>
      readPresentationChoice(storageKeys.sidebarCollapsed, ['true', 'false'], 'false') === 'true',
    { follow: false }
  );
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [panelSidebarExpanded, setPanelSidebarExpanded] = useState(false);
  const [libraryEditorOpen, setLibraryEditorOpen] = useState(false);
  const [editorSidebarExpanded, setEditorSidebarExpanded] = useState(false);
  const [readingWidth, setReadingWidth] = usePresentationSetting(storageKeys.readingWidth, () =>
    readPresentationChoice(storageKeys.readingWidth, READING_WIDTHS, 880)
  );
  const [panelWidth, setPanelWidth] = usePresentationSetting(
    storageKeys.panelWidth,
    readSidePanelWidth,
    { follow: false }
  );
  const [sidebarWidth, setSidebarWidth] = usePresentationSetting(storageKeys.sidebarWidth, () =>
    readPresentationChoice(storageKeys.sidebarWidth, SIDEBAR_WIDTHS, SIDEBAR_WIDTH)
  );
  const desktopSidebarWidth = Math.min(
    sidebarWidth,
    Math.max(SIDEBAR_WIDTH, viewportWidth - MIN_CENTER_WIDTH)
  );
  useEffect(() => {
    const resize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const storyPanels = s.destination === 'story' && !!s.selected;
  const optionsVisible = optionsOpen && storyPanels;
  const storyBoard = useStoryBoard(
    storyPanels ? s.selected : '',
    s.detail?.sources.some((source) => source.id === s.readingSourceId)
      ? s.readingSourceId
      : undefined,
    !!s.detail?.chat.settings.storyUi,
    s.detail?.sources ?? noSources,
    s.detail?.jobs
  );
  const boardOffered = storyBoard.available || (storyBoard.enabled && workspacePanel === 'board');
  const boardVisible = workspacePanel === 'board' && storyPanels && boardOffered;
  const roomBesideRail = viewportWidth - RAIL_WIDTH - MIN_CENTER_WIDTH;
  const outlineSidecarAvailable = !compact && roomBesideRail >= sidePanelMinimumWidth('outline');
  const outlineSidecarVisible =
    workspacePanel === 'outline' &&
    storyPanels &&
    !!s.detail &&
    outlineSidecarAvailable &&
    panel !== 'outline';
  const workspacePanelOpen =
    (helperOpen && !helperExpanded) || optionsVisible || outlineSidecarVisible || boardVisible;
  const panelMinimum = sidePanelMinimumWidth(outlineSidecarVisible ? 'outline' : 'helper');
  const shownPanelWidth = fitSidePanelWidth(panelWidth, panelMinimum, roomBesideRail);
  const dockBesideSidebar = desktopSidebarWidth + shownPanelWidth + MIN_CENTER_WIDTH;
  const dockBesideRail = RAIL_WIDTH + shownPanelWidth + MIN_CENTER_WIDTH;
  const autoCollapseSidebar =
    workspacePanelOpen &&
    viewportWidth >= dockBesideRail &&
    viewportWidth < dockBesideSidebar &&
    !panelSidebarExpanded;
  const editorNeedsRoom = !compact && s.destination === 'library' && libraryEditorOpen;
  const editorCollapsesSidebar = editorNeedsRoom && !editorSidebarExpanded;
  const sidebarHidden =
    sidebarCollapsed || (!helperWorkspaceOpen && (autoCollapseSidebar || editorCollapsesSidebar));
  const panelModal =
    viewportWidth < dockBesideRail || (!sidebarHidden && viewportWidth < dockBesideSidebar);
  const shownNavigationWidth =
    focus && !helperWorkspaceOpen ? 0 : sidebarHidden ? RAIL_WIDTH : desktopSidebarWidth;
  const panelMaximum = Math.min(
    SIDE_PANEL_MAX_WIDTH,
    Math.max(panelMinimum, viewportWidth - shownNavigationWidth - MIN_CENTER_WIDTH)
  );
  useEffect(() => {
    if (!workspacePanelOpen) setPanelSidebarExpanded(false);
  }, [workspacePanelOpen]);
  useEffect(() => {
    if (!editorNeedsRoom) setEditorSidebarExpanded(false);
  }, [editorNeedsRoom]);
  const panelRestorePending = useRef(
    restoredPanel === 'outline' || restoredPanel === 'options' || restoredPanel === 'board'
  );
  useLayoutEffect(() => {
    if (!panelRestorePending.current) return;
    if (workspacePanel || panel || s.destination !== 'story') {
      panelRestorePending.current = false;
      return;
    }
    if (s.selected && s.detail?.chat.id !== s.selected) return;
    panelRestorePending.current = false;
    if (
      viewportWidth >= dockBesideRail &&
      storyPanels &&
      !!s.detail &&
      (restoredPanel === 'options' ||
        (restoredPanel === 'outline' && outlineSidecarAvailable) ||
        (restoredPanel === 'board' && storyBoard.enabled))
    )
      setWorkspacePanel(restoredPanel);
  }, [
    restoredPanel,
    workspacePanel,
    panel,
    s.destination,
    s.selected,
    s.detail,
    viewportWidth,
    dockBesideRail,
    storyPanels,
    outlineSidecarAvailable,
    storyBoard.enabled,
  ]);
  useEffect(() => {
    if (!panelRestorePending.current)
      writeWorkspacePanelState(
        helperWorkspaceOpen ? 'helper-workspace' : (workspacePanel ?? 'closed')
      );
  }, [workspacePanel, helperWorkspaceOpen]);
  const [theme, setTheme] = usePresentationSetting(storageKeys.theme, () =>
    readPresentationChoice(storageKeys.theme, ['system', 'dark', 'light'] as const, 'system')
  );
  const [font, setFont] = usePresentationSetting<string>(storageKeys.font, () =>
    readPresentationChoice(storageKeys.font, ['sans', 'serif'], 'sans')
  );
  const [fontSize, setFontSize] = usePresentationSetting(storageKeys.fontSize, readFontSize);
  const [enterSend, setEnterSend] = usePresentationSetting(
    storageKeys.enterSend,
    () => readPresentationChoice(storageKeys.enterSend, ['true', 'false'], 'false') === 'true'
  );
  const [readingLanguage, setReadingLanguage] = usePresentationSetting<string>(
    storageKeys.readingLanguage,
    () =>
      readPresentationChoice(
        storageKeys.readingLanguage,
        ['translation', 'original'],
        'translation'
      )
  );
  const [illustrationsCollapsed, setIllustrationsCollapsed] = usePresentationSetting(
    storageKeys.illustrationsCollapsed,
    () =>
      readPresentationChoice(storageKeys.illustrationsCollapsed, ['true', 'false'], 'false') ===
      'true'
  );
  const [responseDisplay, setResponseDisplay] = usePresentationSetting<ResponseDisplayMode>(
    storageKeys.responseDisplay,
    () =>
      readPresentationChoice(storageKeys.responseDisplay, ['stream', 'complete'] as const, 'stream')
  );
  const fonts = useFonts();
  const reading = useReadingPreferences(font, fontSize, readingWidth, fonts);

  const [libraryDirty, setLibraryDirty] = useState(false);
  const [importBot, setImportBot] = useState<Content | null>(null);
  const [pendingNavigation, setPendingNavigation] = useState<null | (() => void)>(null);
  const [discardingNavigation, setDiscardingNavigation] = useState(false);
  const [navigationDiscardError, setNavigationDiscardError] = useState<UiMessage | null>(null);
  const currentPrompt = s.currentPrompt;
  const pinned = s.detail?.profile?.pinned;
  const promptAvailable = !pinned?.mainPromptPresetId || !!currentPrompt;
  const hasCreativeOptions = !!currentPrompt && promptControls(currentPrompt.program).length > 0;
  const creativePresets =
    s.library?.promptCombinations?.filter(
      (item) =>
        currentPrompt &&
        matchesPromptCombination(
          item,
          combinationOwner(currentPrompt, 'main'),
          'main',
          currentPrompt.program
        )
    ) ?? [];
  const recentChatByContent: Record<string, string> = {};
  const recentActivity: Record<string, string> = {};
  for (const chat of s.chats) {
    if (
      chat.botId &&
      chat.lastActivityAt &&
      (!recentActivity[chat.botId] || chat.lastActivityAt > recentActivity[chat.botId])
    ) {
      recentActivity[chat.botId] = chat.lastActivityAt;
      recentChatByContent[chat.botId] = chat.id;
    }
  }
  const mainModelRef = pinned?.mainModel ?? s.promptWorkspace?.modelRoutes.main;
  const mainModel = s.library?.models.find((item) => item.id === mainModelRef?.id);
  const mainAvailable =
    !!mainModel &&
    !!s.library &&
    isModelSelectable(mainModel, s.library.models, s.library.connections);
  const mainConnection = s.library?.connections.find(
    (connection) => connection.id === mainModel?.connectionId
  );
  const imageSupport =
    mainModel && mainConnection
      ? imageInputSupported(mainConnection.protocol, mainModel.modelId)
      : null;
  const modelCheckReady = !!s.detail && !!s.library && !!s.promptWorkspace;
  const mainDescription = !modelCheckReady
    ? t('main.m008')
    : mainModel
      ? t('main.modelAvailability', {
          model: modelLabel(mainModel, s.library),
          available: String(mainAvailable),
        })
      : mainModelRef
        ? t('main.m009')
        : t('main.m010');
  const helperModel = s.library?.models.find(
    (item) => item.id === s.promptWorkspace?.helperModel?.id
  );
  const helperAvailable =
    !!helperModel &&
    !!s.library &&
    isModelSelectable(helperModel, s.library.models, s.library.connections);
  const helperDescription = helperModel
    ? t('main.modelAvailability', {
        model: modelLabel(helperModel, s.library),
        available: String(helperAvailable),
      })
    : s.promptWorkspace?.helperModel
      ? t('main.m011')
      : t('main.m012');
  const mainShortDescription = !modelCheckReady
    ? t('main.m013')
    : mainModel
      ? t('main.modelAvailability', { model: mainModel.title, available: String(mainAvailable) })
      : mainModelRef
        ? t('main.m014')
        : t('main.m015');
  const mainModelChip = (
    <button
      type="button"
      className="model-chip secondary"
      aria-haspopup="dialog"
      aria-expanded={panel === 'model'}
      disabled={
        !s.detail?.profile ||
        !s.library ||
        s.profileDirty ||
        optionsDirty ||
        optionsBusy ||
        s.pendingProfile ||
        s.hasPendingRequest
      }
      aria-label={t('main.modelAria', {
        model: mainDescription,
        pinned: String(!!pinned?.mainModel),
        prompt: pinned?.mainPromptPresetId ? (promptAvailable ? 'pinned' : 'unavailable') : 'none',
      })}
      title={
        pinned?.mainModel || pinned?.mainPromptPresetId
          ? t('main.modelPinnedTitle', {
              model: mainDescription,
              pinned: String(!!pinned.mainModel),
              prompt: String(!!pinned.mainPromptPresetId),
              title: currentPrompt?.title ?? t('main.unavailable'),
            })
          : t('main.m019')
      }
      onClick={() => {
        s.setError(null);
        setPanel('model');
      }}
    >
      {(pinned?.mainModel || pinned?.mainPromptPresetId) && (
        <PinIcon size={12} aria-hidden="true" />
      )}
      <span>
        {t('main.modelChip', {
          model: compact ? mainShortDescription : mainDescription,
          prompt: String(promptAvailable),
        })}
      </span>
    </button>
  );
  const chatContext = !s.bot?.title
    ? ''
    : s.bot.title !== s.detail?.chat.title
      ? t('main.botPersona', {
          bot: s.bot.title,
          persona: s.persona?.title ?? '',
          hasPersona: String(!!s.persona),
        })
      : s.persona
        ? t('main.persona', { persona: s.persona.title })
        : '';
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const update = () => setPageVisible(!document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  const queuedRunEnded =
    !!s.queuedRequest &&
    s.detail?.chat.id === s.queuedRequest.chatId &&
    s.active?.id !== s.queuedRequest.runId;
  const queueBlocked =
    optionsBusy ||
    optionsDirty ||
    sourceEditing ||
    s.profileDirty ||
    s.quickBusy ||
    s.pendingProfile ||
    s.hasPendingRequest ||
    !!currentRequestDecision ||
    s.submitting.includes(s.viewKey) ||
    !!s.codexWarning.warning ||
    !s.draftReady ||
    !!s.draftRecovery ||
    (!testMode && !mainAvailable) ||
    !promptAvailable;
  const sendQueuedRequest = s.sendQueuedRequest;
  useEffect(() => {
    if (queuedRunEnded && pageVisible)
      void sendQueuedRequest(queueBlocked, (queued) =>
        latestGenerate.current(undefined, undefined, false, undefined, queued)
      );
  }, [queuedRunEnded, pageVisible, queueBlocked, sendQueuedRequest]);
  const composerStatus = [
    s.hasPendingRequest && !s.submitting.includes(s.viewKey) ? t('main.m020') : '',
    s.cancelling ? t('main.m021') : '',
    s.imagesDecoding ? t('main.m022') : '',
    s.draftImages.length && !testMode && imageSupport === false ? t('main.m023') : '',
    s.profileDirty ? t('main.m025') : '',
  ]
    .filter(Boolean)
    .join(' ');
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => {
    document.documentElement.style.setProperty('--sidebar-w', `${desktopSidebarWidth}px`);
  }, [desktopSidebarWidth]);
  useEffect(() => {
    const viewport = visualViewport;
    const update = () =>
      document.documentElement.style.setProperty(
        '--app-height',
        `${viewport?.height ?? innerHeight}px`
      );
    update();
    viewport?.addEventListener('resize', update);
    return () => viewport?.removeEventListener('resize', update);
  }, []);
  useEffect(() => {
    const onPop = () => {
      settingsReturnToNew.current = false;
      setPanel('');
    };
    return subscribeAppHistory(onPop);
  }, []);
  function newStory(
    bot?: Content,
    folder?: ChatFolder,
    persona?: Content,
    modules?: Content[],
    quickStart = !!bot && !persona && modules === undefined
  ) {
    settingsReturnToNew.current = false;
    setInitialBot(bot);
    setInitialFolder(folder);
    setInitialPersona(persona);
    setInitialModules(modules);
    setQuickStartNew(quickStart);
    setNewKey((old) => old + 1);
    setPanel('new');
  }
  function configureNewStory(bot: Content, folder?: ChatFolder) {
    newStory(bot, folder, undefined, undefined, false);
  }
  const [pendingNotification, setPendingNotification] = useState<NotificationIntent | null>(null);
  const notificationBlocked = sourceEditing || optionsDirty || libraryDirty || panel === 'settings';
  const notificationSelect = useRef((intent: NotificationIntent) => {
    if (notificationBlocked) setPendingNotification(intent);
    else select(intent.chatId, intent.target);
  });
  notificationSelect.current = (intent) => {
    if (notificationBlocked) setPendingNotification(intent);
    else select(intent.chatId, intent.target);
  };
  useEffect(
    () => subscribeNotificationNavigation((intent) => notificationSelect.current(intent)),
    []
  );
  function select(id: string, target?: ReaderTarget) {
    helperResultNavigation.current++;
    const go = () => {
      if (helperWorkspaceOpen) setWorkspacePanel(null);
      setHelperExpanded(false);
      if (target) s.openTarget(target);
      else s.select(id);
      setPanel('');
    };
    if (libraryDirty && s.destination === 'library') {
      setPanel('');
      setPendingNavigation(() => go);
    } else go();
  }
  function openRecentHelper(task: HelperRecentTask) {
    helperReturnToSidecar.current = false;
    const epoch = ++helperHandoffEpoch.current;
    setPanel('');
    setHelperExpanded(true);
    setWorkspacePanel('helper');
    setHelperNavigation((previous) => ({
      conversationId: task.conversationId,
      taskId: task.id,
      sequence: (previous?.sequence ?? 0) + 1,
      epoch,
    }));
  }
  function showLibrary(tab: 'bot' | 'persona' | 'module' | 'prompts' = 'bot') {
    helperResultNavigation.current++;
    const go = () => {
      if (helperWorkspaceOpen) setWorkspacePanel(null);
      setHelperExpanded(false);
      setLibraryTab(tab);
      setLibraryListRequest((value) => value + 1);
      s.showLibrary();
      setPanel('');
    };
    if (
      libraryDirty &&
      s.destination === 'library' &&
      (tab === 'prompts') !== (libraryTab === 'prompts')
    ) {
      setPanel('');
      setPendingNavigation(() => go);
    } else go();
  }
  function useContent(content: Content, role: ContentRole) {
    if (role === 'bot') newStory(content);
    else if (role === 'persona') newStory(undefined, undefined, content);
    else setModuleToUse(content);
  }
  async function openResultDestination(navigation: number, target: HelperTaskResultTarget) {
    if (target.kind === 'content') {
      const content = await api<Content>(`/content/${encodeURIComponent(target.id)}`);
      await s.loadLibrary();
      if (navigation !== helperResultNavigation.current) return;
      setLibraryTab(content.kind === 'persona' || content.kind === 'module' ? content.kind : 'bot');
      setContentToOpen(content.id);
      s.showLibrary();
    } else if (target.kind === 'prompt-preset') {
      await s.loadLibrary();
      if (navigation !== helperResultNavigation.current) return;
      setLibraryTab('prompts');
      setPromptToEdit(target.id);
      s.showLibrary();
    } else if (target.kind === 'illustration' || target.kind === 'scene') {
      const chatId =
        target.chatId ?? s.detail?.sources.find((source) => source.id === target.id)?.chatId;
      if (!chatId) throw new UiError(uiMessage('helperResults.openFailed'));
      s.openTarget({ chatId, sourceId: target.id, representation: 'original' });
      setPanel('');
    } else if (target.kind === 'translation' && target.chatId) {
      s.openTarget({ chatId: target.chatId, sourceId: target.id, representation: 'translation' });
      setPanel('');
    } else if (target.kind === 'chat') {
      if (s.selected !== target.id || s.destination !== 'story') s.select(target.id);
      setPanel('');
    } else if (
      target.kind === 'settings' &&
      (target.setting?.startsWith('newChat.') ||
        target.setting === 'global.autoTranslate' ||
        target.setting === 'global.translationLanguage')
    ) {
      setSettingsTab(target.setting === 'newChat.loreContext' ? 'lore' : 'general');
      setPanel('settings');
    } else if (target.kind === 'settings' && target.setting === 'bot.storyUiTheme') {
      setStoryUiThemeTarget({ botId: target.id, title: target.title });
      setSettingsTab('themes');
      setPanel('settings');
    } else if (target.kind === 'settings' && target.setting?.startsWith('chat.')) {
      if (s.selected !== target.id || s.destination !== 'story') s.select(target.id);
      setSettingsSection(
        target.setting === 'chat.illustrationProfiles' ||
          target.setting === 'chat.illustrationReferences' ||
          target.setting === 'chat.illustrationPreset'
          ? 'images'
          : target.setting === 'chat.variables'
            ? 'packages'
            : target.setting === 'chat.storyGuide'
              ? 'guide'
              : target.setting === 'chat.attachments'
                ? 'characters'
                : target.setting === 'chat.loreContext'
                  ? 'story'
                  : target.setting === 'chat.maxCalls' ||
                      target.setting === 'chat.storyUi' ||
                      target.setting === 'chat.storyUiStyle'
                    ? 'runtime'
                    : 'prompts'
      );
      setPanel('story');
    } else {
      setSettingsTab(
        target.kind === 'theme'
          ? 'themes'
          : target.kind === 'illustration-preset' ||
              target.setting === 'illustrationPreset.global' ||
              target.setting === 'bot.illustrationPreset'
            ? 'illustrations'
            : target.kind === 'prompt-workspace' ||
                target.setting === 'global.mainPromptPreset' ||
                target.setting === 'global.translationPromptPreset' ||
                target.setting?.startsWith('prompt.combination.')
              ? 'prompts'
              : target.setting === 'model.pricing' ||
                  target.setting === 'model.parameters' ||
                  target.setting === 'vertex.location'
                ? 'connections'
                : 'models'
      );
      setPanel('settings');
    }
    setHelperExpanded(false);
  }
  async function openHelperResult(target: HelperTaskResultTarget, anchor?: ResourceAnchor) {
    const navigation = ++helperResultNavigation.current;
    const editor = getActiveEditorContext();
    if (editor?.kind === target.kind && editor.targetId === target.id) {
      if (anchor) setResourceAnchor(anchor);
      setHelperExpanded(false);
      return;
    }
    const go = async () => {
      if (anchor) setResourceAnchor(anchor);
      try {
        await openResultDestination(navigation, target);
      } catch (error) {
        if (anchor) consumeResourceAnchor(anchor.epoch);
        throw error;
      }
    };
    if (
      libraryDirty &&
      s.destination === 'library' &&
      (target.kind === 'content' ||
        target.kind === 'prompt-preset' ||
        target.kind === 'illustration' ||
        target.kind === 'scene' ||
        target.kind === 'translation' ||
        target.kind === 'chat' ||
        (target.kind === 'settings' && target.setting?.startsWith('chat.')))
    )
      setPendingNavigation(() => () => void go().catch((error) => s.setError(error)));
    else await go();
  }
  async function openHelperChange(change: HelperChange) {
    const anchor = change.anchor;
    if (!anchor) return;
    const base = { title: change.title, revision: 0 };
    if (anchor.domain === 'resource') {
      return openHelperResult(
        { ...base, kind: anchor.kind, id: anchor.id },
        { ...anchor, epoch: ++helperAnchorEpoch.current }
      );
    }
    if (anchor.domain === 'scene') {
      const go = () => {
        helperResultNavigation.current++;
        s.openTarget({
          chatId: anchor.chatId,
          sourceId: anchor.sourceId,
          representation: anchor.field === 'translation' ? 'translation' : 'original',
          changedParagraph: anchor.field === 'title' ? null : anchor.paragraph,
        });
        setPanel('');
        setHelperExpanded(false);
      };
      if (libraryDirty && s.destination === 'library') setPendingNavigation(() => go);
      else go();
      return;
    }
    if (anchor.domain === 'outline') {
      const go = () => {
        helperResultNavigation.current++;
        if (s.selected !== anchor.chatId || s.destination !== 'story') s.select(anchor.chatId);
        setHelperExpanded(false);
        openOutlineWorkspace(anchor.nodeId);
      };
      if (libraryDirty && s.destination === 'library') setPendingNavigation(() => go);
      else go();
      return;
    }
    if (anchor.domain === 'settings')
      return openHelperResult({
        ...base,
        kind: 'settings',
        id: anchor.id,
        setting: anchor.setting,
      });
    const go = () => {
      helperResultNavigation.current++;
      if (s.selected !== anchor.chatId || s.destination !== 'story') s.select(anchor.chatId);
      setSettingsSection(anchor.domain === 'notes' ? 'story' : 'packages');
      setPanel('story');
      setHelperExpanded(false);
    };
    if (libraryDirty && s.destination === 'library') setPendingNavigation(() => go);
    else go();
  }
  function inspect(id: string) {
    setInspectedRun(id);
    setPanel('tasks');
  }
  const toggleSidebar = () => {
    if (!helperWorkspaceOpen && !sidebarCollapsed && editorNeedsRoom) {
      setEditorSidebarExpanded(editorCollapsesSidebar);
      if (autoCollapseSidebar) setPanelSidebarExpanded(true);
    } else if (!helperWorkspaceOpen && autoCollapseSidebar && !sidebarCollapsed)
      setPanelSidebarExpanded(true);
    else {
      setSidebarCollapsed(!sidebarCollapsed);
      setPanelSidebarExpanded(false);
      setEditorSidebarExpanded(sidebarCollapsed && editorNeedsRoom);
    }
  };
  const selectChat = useStableHandler(select);
  const openSceneTarget = useStableHandler((target: ReaderTarget) => select(target.chatId, target));
  const chooseSource = useStableHandler(s.chooseSource);
  const chooseLatest = useStableHandler(s.chooseLatest);
  const searchWorkspace = useStableHandler(openWorkspaceSearch);
  const newHelperSession = useStableHandler(createHelperSession);
  const toggleNavigation = useStableHandler(toggleSidebar);
  const startNewStory = useStableHandler(newStory);
  const configureNew = useStableHandler(configureNewStory);
  const importChat = useStableHandler((bot: Content) => {
    setPanel('');
    setImportBot(bot);
  });
  const openLibrary = useStableHandler(showLibrary);
  const copyChat = useStableHandler(s.copyChat);
  const copyingChats = useMemo(() => s.forking.map((key) => key.split(':')[0]), [s.forking]);
  const openAppSettings = useCallback(() => {
    setSettingsTab(undefined);
    setPanel('settings');
  }, []);
  const openTasks = useStableHandler(() => inspect(''));
  const openHelperTask = useStableHandler(openRecentHelper);
  const showHelperActivity = useCallback(() => helperNavigationActions.current?.activity(), []);
  const openChatWorkspace = useStableHandler(() => {
    const go = () => {
      setHelperExpanded(false);
      setWorkspacePanel(null);
      setPanel('');
      if (s.destination !== 'story') s.select(s.selected);
    };
    if (s.destination === 'library' && libraryDirty) setPendingNavigation(() => go);
    else go();
  });
  const openHelperWorkspace = useStableHandler(() => {
    if (panel === 'navigation') setPanel('');
    helperReturnToSidecar.current = false;
    setHelperExpanded(true);
    setWorkspacePanel('helper');
  });
  const closeNavigationDrawer = useStableHandler(() => {
    if (panel === 'navigation') setPanel('');
  });
  const toggleHelperExpanded = useStableHandler(() => {
    if (!helperExpanded) helperReturnToSidecar.current = true;
    setHelperExpanded((value) => !value);
  });
  const openHelperTarget = useStableHandler(openHelperResult);
  const openHelperChangeTarget = useStableHandler(openHelperChange);
  const helperChatScope = s.destination === 'story' && !!s.selected && !!s.detail;
  const helperPanelScope = useMemo<HelperScope>(
    () =>
      helperScope ??
      (helperChatScope
        ? { kind: 'chat', chatId: s.selected }
        : { kind: 'library', workId: `library:${libraryTab}` }),
    [helperScope, helperChatScope, s.selected, libraryTab]
  );
  const closeHelper = useCallback(() => {
    helperResultNavigation.current++;
    setHelperExpanded(false);
    setWorkspacePanel((value) => (value === 'helper' ? null : value));
  }, []);
  const askEditorHelper = useStableHandler((focus: EditorFocus) => {
    const scope = helperPanelScope;
    let snapshot: ReturnType<typeof captureActiveEditorContext>;
    try {
      snapshot = captureActiveEditorContext();
    } catch (cause) {
      s.setError(toUiMessage(cause, 'helpers.m015'));
      return;
    }
    if (!snapshot) return;
    setHelperResource(null);
    setHelperHandoff({
      snapshot,
      kind: 'editor',
      epoch: ++helperHandoffEpoch.current,
      key: crypto.randomUUID(),
      scope,
      conversationId: selectedHelperSession(scope) ?? undefined,
      focus,
    });
    setWorkspacePanel('helper');
  });
  const outlineReturnToSidecar = useRef(false);
  const [outlineChat, setOutlineChat] = useState<string | null>(null);
  const shownOutlineChat =
    panel === 'outline' || outlineSidecarVisible ? (s.detail?.chat.id ?? null) : null;
  useEffect(() => {
    if (shownOutlineChat) setOutlineChat(shownOutlineChat);
  }, [shownOutlineChat]);
  const outlineWorkspaceWasOpen = useRef(false);
  useEffect(() => {
    const left = outlineWorkspaceWasOpen.current && panel !== 'outline';
    outlineWorkspaceWasOpen.current = panel === 'outline';
    if (left && !outlineSidecarVisible) setOutlineChat(null);
  }, [panel, outlineSidecarVisible]);
  const openOutlineWorkspace = (nodeId?: string) => {
    if (nodeId) setOutlineTarget({ nodeId, epoch: Date.now() });
    outlineReturnToSidecar.current = workspacePanel === 'outline';
    if (workspacePanel === 'outline') setWorkspacePanel(null);
    setPanel('outline');
  };
  const closeOutlineWorkspace = () => {
    setPanel('');
    if (outlineReturnToSidecar.current && outlineSidecarAvailable) setWorkspacePanel('outline');
    outlineReturnToSidecar.current = false;
  };
  const sidePanelTabs: SidePanelTab[] | null =
    !compact && storyPanels && !helperExpanded && panel !== 'outline'
      ? [
          'helper',
          ...(s.detail && outlineSidecarAvailable ? (['outline'] as const) : []),
          ...(hasCreativeOptions || optionsOpen ? (['options'] as const) : []),
          ...(boardOffered ? (['board'] as const) : []),
        ]
      : null;
  const sidePanelTabsShown = !!sidePanelTabs && sidePanelTabs.length > 1;
  const availableSidePanelTab = (tab: SidePanelTab): SidePanelTab =>
    tab === 'helper' || (sidePanelTabsShown && sidePanelTabs?.includes(tab)) ? tab : 'helper';
  const showSidePanel = (tab: SidePanelTab) => {
    setWorkspacePanel(tab);
    requestAnimationFrame(() => focusSidePanelTab(tab));
  };
  useEffect(() => {
    if (workspacePanel !== 'outline' || outlineSidecarAvailable) return;
    setWorkspacePanel(null);
    if (panel === '' && storyPanels && s.detail) {
      outlineReturnToSidecar.current = false;
      setPanel('outline');
    }
  }, [workspacePanel, outlineSidecarAvailable, panel, storyPanels, s.detail]);
  const renderSidePanelTabs = (closeLabel: string) =>
    sidePanelTabsShown && sidePanelTabs && workspacePanel
      ? (close: () => void) => (
          <SidePanelTabs
            tabs={sidePanelTabs}
            active={workspacePanel}
            closeLabel={closeLabel}
            onSelect={showSidePanel}
            onClose={close}
          />
        )
      : undefined;
  useShortcut('navigation.toggle', () => {
    if (!compact) toggleSidebar();
    else setPanel('navigation');
  });
  useShortcut('rightPanel.toggle', () => {
    if (helperOpen) closeHelper();
    else if (optionsVisible || outlineSidecarVisible || boardVisible) setWorkspacePanel(null);
    else showSidePanel(availableSidePanelTab(lastSidePanelTab.current));
  });
  useShortcut('settings.open', openAppSettings);
  useShortcut('search.open', () => searchFromKeyboard());
  useShortcut('editor.save', () => true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const contextToolsMounted = useOpenedOnce(
    currentChatTool === 'lore' || currentChatTool === 'compact'
  );
  const exportMounted = useOpenedOnce(currentChatTool === 'export');
  const composerFocusChat = useRef<string | null>(null);
  const openedChat = s.destination === 'story' ? s.detail?.chat.id : undefined;
  useEffect(() => {
    if (!openedChat || composerFocusChat.current !== openedChat) return;
    composerFocusChat.current = null;
    s.input.current?.focus({ preventScroll: true });
  }, [openedChat, s.input]);
  useShortcut('palette.open', () => setPaletteOpen(true), { active: !compact });
  const sessionRequired = useContext(SessionRequiredContext);
  function paletteEntries(): PaletteEntry[] {
    const library = s.library;
    const story = s.destination === 'story' && !!s.selected && !helperWorkspaceOpen;
    const commands: PaletteEntry[] = [
      {
        id: 'new-chat',
        group: 'commands',
        label: t('main.m004'),
        icon: NewChatIcon,
        run: () => newStory(),
      },
      {
        id: 'library',
        group: 'commands',
        label: t('library.library'),
        icon: LibraryIcon,
        run: () => showLibrary(),
      },
      ...(helperOpen
        ? []
        : [
            {
              id: 'helper',
              group: 'commands' as const,
              label: t('main.m027'),
              icon: HelperIcon,
              run: () => setWorkspacePanel('helper'),
            },
          ]),
      ...(story && s.detail
        ? [
            {
              id: 'outline',
              group: 'commands' as const,
              label: t('palette.openOutline'),
              icon: ListTree,
              run: () => openOutlineWorkspace(),
            },
          ]
        : []),
      ...(story
        ? [
            {
              id: 'focus',
              group: 'commands' as const,
              label: focus ? t('main.m060') : t('main.m071'),
              icon: focus ? Minimize : Maximize,
              run: () => setFocus(!focus),
            },
          ]
        : []),
    ];
    const chats = s.chats
      .toSorted((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''))
      .map<PaletteEntry>((chat) => ({
        id: `chat:${chat.id}`,
        group: 'chats',
        label: chat.title,
        detail: library?.contents.find((item) => item.id === chat.botId)?.title,
        run: () => {
          composerFocusChat.current = chat.id;
          select(chat.id);
        },
      }));
    const openResource = (target: HelperTaskResultTarget) => () =>
      void openHelperResult(target).catch((error) => s.setError(error));
    const resourceKinds = {
      bot: { label: t('library.bot'), icon: BotIcon },
      persona: { label: t('library.persona'), icon: PersonaIcon },
      module: { label: t('library.module'), icon: ModuleIcon },
    };
    const resources: PaletteEntry[] = [
      ...(library?.contents ?? []).map<PaletteEntry>((content) => {
        const kind = resourceKinds[libraryCategory(library!, content)];
        return {
          id: `content:${content.id}`,
          group: 'resources',
          label: content.title,
          detail: kind.label,
          icon: kind.icon,
          run: openResource({
            kind: 'content',
            id: content.id,
            title: content.title,
            revision: content.revision,
          }),
        };
      }),
      ...(library?.promptPresets ?? []).map<PaletteEntry>((preset) => ({
        id: `prompt:${preset.id}`,
        group: 'resources',
        label: preset.title,
        detail: t('library.prompts'),
        icon: PromptIcon,
        run: openResource({
          kind: 'prompt-preset',
          id: preset.id,
          title: preset.title,
          revision: preset.revision,
        }),
      })),
    ];
    const settings = getSettingsCategories(sessionRequired).map<PaletteEntry>((category) => ({
      id: `settings:${category.key}`,
      group: 'settings',
      label: category.label,
      icon: category.icon,
      terms: [category.terms, ...(category.destinations ?? []).map((item) => item.label)].join(' '),
      run: () => {
        setSettingsTab(category.key);
        setPanel('settings');
      },
    }));
    return [...commands, ...chats, ...resources, ...settings];
  }
  const stopShortcutLabel = useShortcutLabel('run.stop');
  useShortcut('run.stop', () => void s.cancelActive(), {
    ready: () =>
      s.destination === 'story' &&
      !helperWorkspaceOpen &&
      !!s.active &&
      !s.hasPendingRequest &&
      !s.cancelling,
    confirmNotice: uiMessage('shortcuts.cancelGenerationAgain', {
      key: stopShortcutLabel,
    }),
  });
  const openModelSettings = useCallback(() => {
    setSettingsTab('models');
    setPanel('settings');
  }, []);
  const navigation = (quickActions: boolean, collapsed = false) => (
    <BotNavigation
      libraryError={s.libraryError}
      quickActions={quickActions}
      onSearch={searchWorkspace}
      onNewChat={startNewStory}
      onNewHelper={newHelperSession}
      collapsed={collapsed}
      onToggleCollapse={toggleNavigation}
      library={s.library}
      chats={s.chats}
      selected={s.selected}
      destination={s.destination}
      libraryTab={libraryTab}
      onSelect={selectChat}
      onNew={startNewStory}
      onConfigureNew={configureNew}
      onImportChat={importChat}
      onLibrary={openLibrary}
      onChatsChanged={s.loadChats}
      onCopyChat={copyChat}
      copyingChats={copyingChats}
      onLibraryChanged={s.retryLibrary}
      onError={s.setError}
      onSettings={openAppSettings}
      onTasks={openTasks}
      onOpenHelperTask={openHelperTask}
      helperOpen={helperOpen}
      helperExpanded={helperWorkspaceOpen}
      onHelperActivity={showHelperActivity}
      helperNavigationRef={
        (quickActions ? !compact && panel !== 'navigation' : panel === 'navigation')
          ? setHelperNavigationHost
          : undefined
      }
      onChatWorkspace={openChatWorkspace}
      onToggleHelper={openHelperWorkspace}
      tasks={s.tasks}
    />
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: The label follows the active locale.
  const navigationControls = useMemo(
    () => (
      <IconButton
        ref={navigationOpener}
        className="mobile-menu"
        data-navigation-menu
        label={t('main.m026')}
        icon={Menu}
        onClick={() => setPanel('navigation')}
      />
    ),
    [locale]
  );
  const destinationHelperControl = s.destination !== 'story' && !helperOpen && (
    <IconButton
      className="destination-helper"
      label={t('main.m027')}
      icon={HelperIcon}
      aria-expanded={helperOpen}
      aria-controls="helper-panel"
      onClick={() => {
        setWorkspacePanel((value) => (value === 'helper' ? null : 'helper'));
      }}
    />
  );
  function renderReadingSettings(onStartFocus?: () => void) {
    const registeredReaderFont = fonts.catalog?.fonts.find(
      (item) => item.id === fonts.catalog?.preferences.readerFontId
    );
    return (
      <ReadingSettingsSearch searchable={!!onStartFocus}>
        <section className="settings-group reading-settings-group" aria-label={t('main.m028')}>
          <header className="settings-group-heading">
            <h4>{t('main.m028')}</h4>
          </header>
          <div className="settings-group-body reading-settings-rows">
            <label>
              {t('main.m029')}
              <select
                aria-label={t('main.m029')}
                data-reading-setting="font"
                value={font}
                onChange={(event) => reading.changeLayout(() => setFont(event.target.value))}
              >
                <option value="sans">{t('main.m030')}</option>
                <option value="serif">{t('main.m031')}</option>
              </select>
              {registeredReaderFont && (
                <small className="muted">
                  {t('main.registeredReaderFont', { name: registeredReaderFont.title })}
                </small>
              )}
            </label>
            <label>
              {t('main.m032')}
              <span className="reading-range-control">
                <input
                  aria-label={t('main.m032')}
                  data-reading-setting="size"
                  type="range"
                  min={9}
                  max={28}
                  step={1}
                  value={fontSize}
                  onChange={(event) =>
                    reading.changeLayout(() => setFontSize(Number(event.target.value)))
                  }
                />
                <output>{fontSize}px</output>
              </span>
            </label>
            <label>
              {t('main.m033')}
              <select
                aria-label={t('main.m033')}
                data-reading-setting="width"
                value={readingWidth}
                onChange={(event) =>
                  reading.changeLayout(() => setReadingWidth(Number(event.target.value)))
                }
              >
                <option value={760}>{t('main.m034')}</option>
                <option value={880}>{t('main.m035')}</option>
                <option value={1040}>{t('main.m036')}</option>
              </select>
            </label>
            <label className="settings-row settings-row-toggle">
              <span>{t('main.m037')}</span>
              <span className="settings-row-control">
                <Switch
                  aria-label={t('main.m039')}
                  data-reading-setting="navigator"
                  checked={sceneNavigatorEnabled}
                  onChange={(event) => setSceneNavigatorEnabled(event.target.checked)}
                />
              </span>
            </label>
          </div>
        </section>

        <section className="settings-group reading-settings-group" aria-label={t('main.m041')}>
          <header className="settings-group-heading">
            <h4>{t('main.m041')}</h4>
          </header>
          <div className="settings-group-body reading-settings-rows">
            <label>
              {t('main.m042')}
              <select
                aria-label={t('main.m042')}
                data-reading-setting="response"
                value={responseDisplay}
                onChange={(event) => setResponseDisplay(event.target.value as ResponseDisplayMode)}
              >
                <option value="stream">{t('main.m044')}</option>
                <option value="complete">{t('main.m045')}</option>
              </select>
            </label>
            <label>
              {t('main.m047')}
              <select
                aria-label={t('main.m047')}
                data-reading-setting="language"
                value={readingLanguage}
                onChange={(event) => setReadingLanguage(event.target.value)}
              >
                <option value="translation">{t('main.m049')}</option>
                <option value="original">{t('main.m050')}</option>
              </select>
            </label>
            <label>
              {t('main.m052')}
              <select
                aria-label={t('main.m052')}
                data-reading-setting="illustrations"
                value={String(illustrationsCollapsed)}
                onChange={(event) => setIllustrationsCollapsed(event.target.value === 'true')}
              >
                <option value="false">{t('main.m054')}</option>
                <option value="true">{t('main.m055')}</option>
              </select>
            </label>
          </div>
        </section>
        <ReadabilitySettings value={reading.settings} onChange={reading.update} />
        {onStartFocus && (
          <button className="secondary reading-focus-start" onClick={onStartFocus}>
            {t('main.m056')}
          </button>
        )}
      </ReadingSettingsSearch>
    );
  }
  const workspace = (
    <div
      className={`app-shell ${panel === 'outline' ? 'outline-active' : ''} ${focus && !helperWorkspaceOpen ? 'focus-reading' : ''} ${sidebarHidden ? 'sidebar-collapsed' : ''} ${optionsVisible ? 'options-open' : ''} ${helperOpen ? 'helper-open' : ''} ${helperWorkspaceOpen ? 'helper-expanded' : ''} ${workspacePanelOpen ? (panelModal ? 'panel-overlay' : 'panel-docked') : ''}`}
      style={{ '--panel-w': `${shownPanelWidth}px` } as CSSProperties}
    >
      {importBot && (
        <BotChatImportDialog
          bot={importBot}
          onClose={() => setImportBot(null)}
          onImported={s.loadChats}
          onOpenBackups={() => {
            setImportBot(null);
            setSettingsTab('data');
            setPanel('settings');
          }}
        />
      )}
      <aside id="workspace-sidebar" className="sidebar" aria-label={t('main.m057')}>
        {!compact && panel !== 'navigation' && navigation(true, sidebarHidden)}
      </aside>
      <main className="story-workspace" hidden={helperWorkspaceOpen}>
        {s.destination === 'story' && (
          <header className="workspace-header">
            {navigationControls}
            <div className="header-title">
              <h1>
                {s.detail?.chat.title || 'Uimori'}
                {compact && !focus && sceneCount > 0 && (
                  <ChevronDown size={14} aria-hidden="true" className="header-title-caret" />
                )}
              </h1>
              {(chatContext || (compact && !focus && scenePosition?.scope === s.viewKey)) && (
                <small className="header-reading-context">
                  {compact && !focus && scenePosition?.scope === s.viewKey && (
                    <span className="header-scene-position">{scenePosition.label}</span>
                  )}
                  {chatContext && <span className="header-chat-context">{chatContext}</span>}
                </small>
              )}
              {compact && !focus && s.selected && sceneCount > 0 && (
                <button
                  type="button"
                  ref={sceneListOpener}
                  className="header-title-hit"
                  aria-label={t('main.m058')}
                  title={t('main.m059')}
                  onClick={() => setSceneList(true)}
                />
              )}
            </div>
            <div className="header-actions">
              {s.selected && s.destination === 'story' && (
                <>
                  {mainModelChip}
                  {!compact && (
                    <IconButton
                      label={t('main.m062')}
                      icon={HelperIcon}
                      aria-pressed={helperOpen}
                      aria-controls="helper-panel"
                      onClick={() => (helperOpen ? closeHelper() : showSidePanel('helper'))}
                    />
                  )}
                  {!compact && s.detail && (
                    <IconButton
                      label={t('main.m007')}
                      icon={ListTree}
                      aria-pressed={outlineSidecarVisible}
                      aria-controls="outline-panel"
                      onClick={() =>
                        outlineSidecarVisible
                          ? setWorkspacePanel(null)
                          : outlineSidecarAvailable
                            ? showSidePanel('outline')
                            : openOutlineWorkspace()
                      }
                    />
                  )}
                  {focus && (
                    <IconButton
                      label={t('main.m060')}
                      icon={Minimize}
                      size={19}
                      onClick={() => setFocus(false)}
                    />
                  )}
                  {!compact && (
                    <IconButton
                      label={t('main.m003')}
                      icon={SlidersHorizontal}
                      onClick={() => openChatSettings()}
                    />
                  )}
                  <ActionMenu label={t('main.m061')} className="chat-menu" viewport>
                    <div
                      className="action-menu-group"
                      role="group"
                      aria-label={t('chatmanage.reading')}
                    >
                      <span className="action-menu-heading">{t('chatmanage.reading')}</span>
                      <button
                        type="button"
                        className="secondary"
                        onClick={(event) => {
                          fromChatMenu(event);
                          setPanel('reading');
                        }}
                      >
                        <Type size={18} aria-hidden="true" />
                        {t('main.m070')}
                      </button>
                      {!focus && (
                        <button type="button" className="secondary" onClick={() => setFocus(true)}>
                          <Maximize size={18} aria-hidden="true" />
                          {t('main.m071')}
                        </button>
                      )}
                    </div>
                    <div
                      className="action-menu-group"
                      role="group"
                      aria-label={t('chatmanage.tools')}
                    >
                      <span className="action-menu-heading">{t('chatmanage.tools')}</span>
                      {compact && (
                        <>
                          <button
                            type="button"
                            className="secondary"
                            aria-label={t('main.m003')}
                            onClick={(event) => {
                              fromChatMenu(event);
                              openChatSettings();
                            }}
                          >
                            <SlidersHorizontal size={18} aria-hidden="true" />
                            {t('main.m003')}
                          </button>
                          <button
                            type="button"
                            className="secondary"
                            aria-label={t('main.m027')}
                            aria-expanded={helperOpen}
                            aria-controls="helper-panel"
                            onClick={() => {
                              setWorkspacePanel('helper');
                            }}
                          >
                            <HelperIcon size={18} aria-hidden="true" />
                            {t('main.m062')}
                          </button>
                        </>
                      )}
                      {s.detail && (
                        <button
                          type="button"
                          className="secondary"
                          onClick={(event) => {
                            fromChatMenu(event);
                            openOutlineWorkspace();
                          }}
                        >
                          <ListTree size={18} aria-hidden="true" />
                          {t('main.m007')}
                        </button>
                      )}
                      <button
                        type="button"
                        className="secondary"
                        onClick={(event) => {
                          fromChatMenu(event);
                          openChatSettings('guide');
                        }}
                      >
                        <BookOpen size={18} aria-hidden="true" />
                        {t('main.m063')}
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={(event) => {
                          fromChatMenu(event);
                          inspect('');
                        }}
                      >
                        <Activity size={18} aria-hidden="true" />
                        {t('main.m006')}
                      </button>
                    </div>
                    <div
                      className="action-menu-group"
                      role="group"
                      aria-label={t('chatmanage.copyExport')}
                    >
                      <span className="action-menu-heading">{t('chatmanage.copyExport')}</span>
                      <button
                        type="button"
                        className="secondary"
                        aria-label={t('main.m067')}
                        disabled={
                          !s.sources.length ||
                          s.forking.some((key) => key.startsWith(`${s.selected}:`))
                        }
                        onClick={() => {
                          const source = s.sources.at(-1);
                          if (source) void s.fork(source.id);
                        }}
                      >
                        <GitFork size={18} aria-hidden="true" />
                        {t('main.m067')}
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={!sceneCount}
                        onClick={() => setChatTool({ scope: s.viewKey, kind: 'export' })}
                      >
                        <BookOpenText size={18} aria-hidden="true" />
                        {t('main.m064')}
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        aria-label={t('main.m065')}
                        title={t('main.m066')}
                        onClick={() => {
                          const chatId = s.selected;
                          const title = s.chats.find((chat) => chat.id === chatId)?.title ?? 'chat';
                          void downloadArchive(
                            `/chats/${chatId}/backup-archive`,
                            `${title.replace(/[\\/:*?"<>|]/g, '_')}.chat.uimori`
                          ).catch((error: Error) => s.setError(error));
                        }}
                      >
                        <DatabaseBackup size={18} aria-hidden="true" />
                        {t('main.m065')}
                      </button>
                    </div>
                    <div
                      className="action-menu-group"
                      role="group"
                      aria-label={t('chatmanage.management')}
                    >
                      {s.detail && (
                        <DeleteButton
                          path={`/chats/${encodeURIComponent(s.selected)}`}
                          preparePath={`/chats/${encodeURIComponent(s.selected)}/deletion-impact`}
                          title={s.detail.chat.title}
                          label={uiMessage('main.m072')}
                          confirmLabel={uiMessage('shared.deletePermanently')}
                          description={uiMessage('main.m073')}
                          disabled={!!s.active}
                          onError={s.setError}
                          onDeleted={() => {
                            forgetChatStorage(s.selected!);
                            return s.loadChats();
                          }}
                        />
                      )}
                    </div>
                  </ActionMenu>
                </>
              )}
            </div>
          </header>
        )}
        {pendingNotification && (
          <NoticeBanner
            label={uiMessage('main.m074')}
            actions={
              <>
                <button
                  type="button"
                  disabled={notificationBlocked}
                  onClick={() => {
                    select(pendingNotification.chatId, pendingNotification.target);
                    setPendingNotification(null);
                  }}
                >
                  {t('main.m075')}
                </button>
                <button type="button" onClick={() => setPendingNotification(null)}>
                  {t('main.m076')}
                </button>
              </>
            }
          >
            {t('main.m077')}
          </NoticeBanner>
        )}
        {s.destination === 'library' ? (
          <div className="destination-scroll">
            {libraryTab === 'prompts' ? (
              s.library ? (
                <PromptLibrary
                  listRequest={libraryListRequest}
                  initialPresetId={promptToEdit}
                  onInitialPresetHandled={() => setPromptToEdit(null)}
                  onEditorOpened={clearHelperResource}
                  onAskHelper={(preset) => {
                    setHelperResource({
                      kind: 'prompt-preset',
                      id: preset.id,
                      revision: preset.revision,
                      title: preset.title,
                    });
                    setWorkspacePanel('helper');
                  }}
                  onOpenCurrentPrompts={() => {
                    setSettingsTab('prompts');
                    setPanel('settings');
                  }}
                  headerLeading={navigationControls}
                  headerTrailing={destinationHelperControl}
                  library={s.library}
                  reload={s.loadLibrary}
                  onError={s.setError}
                  onDirtyChange={setLibraryDirty}
                  onEditingChange={setLibraryEditorOpen}
                />
              ) : (
                workspaceFallback(
                  uiMessage('main.m002'),
                  navigationControls,
                  <LoadingState
                    presentation="region"
                    loading={!s.libraryError}
                    error={s.libraryError}
                    label={uiMessage('main.m078')}
                    errorLabel={uiMessage('main.m079')}
                    onRetry={() => void s.retryLibrary().catch(() => {})}
                  />
                )
              )
            ) : (
              <LibraryPanel
                headerLeading={navigationControls}
                headerTrailing={destinationHelperControl}
                library={s.library}
                reload={s.retryLibrary}
                libraryError={s.libraryError}
                onError={s.setError}
                onStartStory={newStory}
                onConfigureStartStory={configureNewStory}
                onUseContent={useContent}
                recentChatByContent={recentChatByContent}
                onContinueChat={select}
                initialTab={libraryTab}
                listRequest={libraryListRequest}
                initialContentId={contentToOpen}
                onInitialContentHandled={(id) =>
                  setContentToOpen((current) => (current === id ? null : current))
                }
                onTabChange={setLibraryTab}
                onDirtyChange={setLibraryDirty}
                onEditingChange={setLibraryEditorOpen}
              />
            )}
            <DismissibleError
              error={!s.library && sameUiMessage(s.error, s.libraryError) ? null : s.error}
              onDismiss={() => s.setError(null)}
            />
          </div>
        ) : (
          <>
            {s.readingSync.other && (
              <NoticeBanner
                label={uiMessage('main.m080')}
                actions={
                  <>
                    <button
                      type="button"
                      aria-label={s.readingSync.resumeLabel}
                      onClick={s.readingSync.resumeOther}
                    >
                      {t('main.m081')}
                    </button>
                    <IconButton
                      label={t('main.m082')}
                      icon={CloseIcon}
                      className="secondary"
                      onClick={s.readingSync.dismiss}
                    />
                  </>
                }
              >
                {s.readingSync.resumeOrigin === 'other-device' ? t('main.m083') : t('main.m084')}
              </NoticeBanner>
            )}
            <div
              className={`reader-stage ${!compact && showSceneNavigator && s.detail?.reader.navigation.length ? 'has-scenes' : ''}`}
            >
              <ThemeBackground />
              {s.detail?.chat.id === s.selected && s.attachmentsReady && s.bot && (
                <ReaderGallery key={`gallery:${s.viewKey}`} bot={s.bot} persona={s.persona} />
              )}
              <div
                ref={s.reader}
                className="reader-scrollport"
                data-reader-scrollport
                onScroll={readerFollow.onScroll}
              >
                <section
                  ref={readerContent}
                  className={`reader${s.selected && !s.detail ? ' reader-awaiting' : ''}`}
                  aria-label={t('main.m085')}
                  aria-busy={!!s.selected && !s.detail && s.readerLoading}
                >
                  {!s.selected ? (
                    <div className="empty-state">
                      <BookOpen size={32} />
                      <h2>{t('main.m086')}</h2>
                      <button onClick={() => newStory()}>{t('main.m004')}</button>
                      <button className="secondary" onClick={() => showLibrary()}>
                        {t('main.m088')}
                      </button>
                    </div>
                  ) : !s.detail ? (
                    <ReaderLoadingState
                      key={s.viewKey}
                      loading={s.readerLoading}
                      error={s.readerLoadError}
                      onRetry={() => void s.refresh(s.selected).catch(() => {})}
                    />
                  ) : (
                    <>
                      {(s.profileAsset ||
                        (s.sources.length > 0 &&
                          s.attachmentsReady &&
                          s.bot &&
                          contentPortraitUrl(s.bot))) && (
                        <div
                          className="story-context"
                          data-fallback={s.profileAsset ? undefined : true}
                        >
                          <ReaderPortraitButton
                            url={s.profileAsset?.url ?? contentPortraitUrl(s.bot)}
                            title={s.bot?.title ?? s.profileAsset?.title ?? t('main.m089')}
                          >
                            {s.profileAsset ? (
                              <img
                                className="profile-asset"
                                data-testid="profile-asset"
                                src={s.profileAsset.url}
                                alt={s.profileAsset.description || s.profileAsset.title}
                              />
                            ) : (
                              <ContentAvatar content={s.bot} fullSize />
                            )}
                          </ReaderPortraitButton>
                          {s.bot && <strong className="reader-bot-name">{s.bot.title}</strong>}
                        </div>
                      )}
                      {!s.connected &&
                        !s.detail?.reader.activity?.some((item) =>
                          ['queued', 'running'].includes(item.status)
                        ) && (
                          <p className="connection-note" role="status">
                            {t('main.m090')}
                          </p>
                        )}
                      {!s.sources.length && !s.visibleRuns.length && !s.active && (
                        <div className="first-scene">
                          {s.bot && contentPortraitUrl(s.bot) && (
                            <ContentAvatar
                              content={s.bot}
                              className="first-scene-avatar"
                              fullSize
                            />
                          )}
                          <h2>{t('main.m091')}</h2>
                        </div>
                      )}
                      <ReaderPages
                        detail={s.detail}
                        head={s.detail?.chat.headRevision ?? null}
                        onSelect={s.chooseSource}
                      />
                      {s.conversation.map((entry) => {
                        if (entry.kind === 'source') {
                          const { source, index } = entry;
                          return (
                            <SourceReader
                              storyUiStyle={s.detail!.chat.settings.storyUiStyle}
                              portrait={
                                s.attachmentsReady && s.bot ? (
                                  <ReaderGallery scene bot={s.bot} persona={s.persona} />
                                ) : undefined
                              }
                              requestPersona={
                                s.attachmentsReady && s.bot && s.persona ? (
                                  <ReaderGallery requestPersona bot={s.bot} persona={s.persona} />
                                ) : undefined
                              }
                              latest={source.id === s.sources.at(-1)?.id}
                              onModelSettings={() => {
                                setSettingsTab('models');
                                setPanel('settings');
                              }}
                              contextSummary={
                                s.detail!.runs.find((run) => run.id === source.runId)
                                  ?.contextSummary
                              }
                              packageStart={
                                s.detail!.runs.find((run) => run.id === source.runId)?.packageStart
                              }
                              startSelection={
                                s.detail!.reader.canChangePackageStart &&
                                source.id === s.detail!.chat.headRevision &&
                                s.detail!.profile &&
                                s.detail!.runs.find((run) => run.id === source.runId)?.packageStart
                                  ? {
                                      ...s.detail!.runs.find((run) => run.id === source.runId)!
                                        .packageStart!,
                                      expectedSettingsRevision: s.detail!.chat.settingsRevision,
                                      expectedProfileRevision: s.detail!.profile.revision,
                                      userName: s.persona?.title,
                                    }
                                  : undefined
                              }
                              onStartChanged={() => s.setNotice(uiMessage('main.m093'))}
                              hasPackages={
                                !!s.detail!.runs.find((run) => run.id === source.runId)?.hasPackages
                              }
                              presentationRefreshKey={
                                s.detail!.reader.presentationRevisions[source.id]
                              }
                              nativeInteractionRevision={s.nativeInteractionRevision}
                              key={source.id}
                              source={source}
                              readerTarget={
                                s.readerTarget?.sourceId === source.id ? s.readerTarget : undefined
                              }
                              index={index + (s.detail?.reader?.start ?? 0)}
                              sceneNumber={
                                s.detail?.reader.navigation.find((item) => item.id === source.id)
                                  ?.number
                              }
                              request={
                                s.detail!.runs.find((run) => run.id === source.runId)?.request
                              }
                              requestImages={
                                s.detail!.runs.find((run) => run.id === source.runId)?.snapshot
                                  .requestImages
                              }
                              jobs={s.detail!.jobs.filter(
                                (job) => job.sourceRevision === source.id
                              )}
                              illustrationsCollapsed={illustrationsCollapsed}
                              illustrations={(s.detail!.illustrations ?? []).filter(
                                (item) => item.sourceRevision === source.id
                              )}
                              assets={s.detail!.assets ?? []}
                              imageOwner={s.detail!.profile?.image === true}
                              refresh={() => s.refresh(s.selected)}
                              beginStoryUiAdmission={s.beginStoryUiAdmission}
                              onError={s.setError}
                              onFork={s.fork}
                              deletionDisabled={
                                !!s.active ||
                                sourceEditing ||
                                sceneDeletion?.chatId === source.chatId
                              }
                              onDeleteScene={openSceneDeletion}
                              onNativeNotice={(messages) =>
                                setNativeNotices((previous) => [...previous, ...messages])
                              }
                              onRetry={
                                s.canReuseRun(source.runId)
                                  ? (mode, text) => generate(source.runId, text, false, mode)
                                  : undefined
                              }
                              retryCanReplace={source.id === s.detail!.chat.headRevision}
                              onCheckRequest={
                                s.pendingEditedRunId === source.runId
                                  ? () => submitRequest(true)
                                  : undefined
                              }
                              onAskHelper={(sourceId, text) => {
                                setWorkspacePanel('helper');
                                if (s.selected)
                                  setHelperHandoff({
                                    kind: 'selection',
                                    epoch: ++helperHandoffEpoch.current,
                                    key: crypto.randomUUID(),
                                    sourceId,
                                    sourceHash: source.hash,
                                    text,
                                    conversationId:
                                      selectedHelperSession({
                                        kind: 'chat',
                                        chatId: s.selected,
                                      }) ?? undefined,
                                    scope: {
                                      kind: 'chat',
                                      chatId: s.selected,
                                    },
                                  });
                              }}
                              retryDisabled={s.reuseBlocked || optionsBusy}
                              onEditingChange={onSourceEditing}
                              activity={(slots) => {
                                const run = s.detail!.runs.find((item) => item.id === source.runId);
                                return (
                                  run && (
                                    <TurnActivity
                                      leading={slots.leading}
                                      badges={slots.badges}
                                      run={run}
                                      source={source}
                                      jobs={s.detail!.jobs}
                                      illustrations={s.detail!.illustrations}
                                      activities={s.detail!.reader.responseActivity ?? []}
                                      connected={s.connected}
                                      revision={s.detail!.reader.cursor}
                                      refresh={() => s.refresh(s.selected)}
                                      onError={s.setError}
                                      onInspect={inspect}
                                    />
                                  )
                                );
                              }}
                            />
                          );
                        }
                        const { run } = entry;
                        if (canDismissReaderRun(run))
                          return (
                            <CancelledRun
                              key={run.id}
                              run={run}
                              disabled={s.reuseBlocked || optionsBusy}
                              onRetry={
                                s.canReuseRun(run.id) ? () => void generate(run.id) : undefined
                              }
                              onSubmit={
                                s.canReuseRun(run.id) ? (text) => generate(run.id, text) : undefined
                              }
                              onConfirm={
                                s.pendingEditedRunId === run.id
                                  ? () => submitRequest(true)
                                  : undefined
                              }
                              onDismiss={() => s.dismissCancelledRun(run.id)}
                              onHistory={() => inspect(run.id)}
                            />
                          );
                        return (
                          <article
                            className="pending-turn"
                            key={run.id}
                            data-testid="pending-run"
                            data-run-id={run.id}
                            ref={(node) => {
                              if (node && runFailed(run.status)) {
                                const observer = pendingObserver.current;
                                observer?.observe(node);
                                return () => observer?.unobserve(node);
                              }
                            }}
                          >
                            <RequestMessage
                              runId={run.id}
                              request={run.request}
                              images={run.snapshot.requestImages}
                              disabled={s.reuseBlocked || optionsBusy}
                              editHint={t('main.m094')}
                              onSubmit={
                                s.canReuseRun(run.id) ? (text) => generate(run.id, text) : undefined
                              }
                              onConfirm={
                                s.pendingEditedRunId === run.id
                                  ? () => submitRequest(true)
                                  : undefined
                              }
                            />
                            <div className="run-outcome">
                              <TurnActivity
                                run={run}
                                jobs={[]}
                                activities={s.detail!.reader.activity ?? []}
                                connected={s.connected}
                                revision={s.detail!.reader.cursor}
                                refresh={() => s.refresh(s.selected)}
                                onError={s.setError}
                                onInspect={inspect}
                              />
                              <ResponseDisplay
                                storyUiStyle={s.detail!.chat.settings.storyUiStyle}
                                mode={responseDisplay}
                                taskKind="main"
                                taskId={run.id}
                                taskStatus={run.status}
                              />
                              {runFailed(run.status) && (
                                <RetryFailure
                                  onRejudge={
                                    run.canRejudge && s.canReuseRun(run.id)
                                      ? () => {
                                          void generate(run.id, undefined, true);
                                        }
                                      : undefined
                                  }
                                  status={run.status}
                                  error={run.error}
                                  disabled={s.reuseBlocked || optionsBusy}
                                  onRetry={
                                    s.canReuseRun(run.id)
                                      ? () => {
                                          void generate(run.id);
                                        }
                                      : undefined
                                  }
                                  onSettings={() => {
                                    if (run.error?.includes('PROMPT_')) showLibrary('prompts');
                                    else {
                                      setSettingsTab('models');
                                      setPanel('settings');
                                    }
                                  }}
                                  onDetails={() => inspect(run.id)}
                                  onHistory={() => inspect('')}
                                />
                              )}
                            </div>
                          </article>
                        );
                      })}
                      <ReaderPages
                        detail={s.detail}
                        head={s.detail?.chat.headRevision ?? null}
                        onSelect={s.chooseSource}
                        end
                      />
                    </>
                  )}
                </section>
              </div>
              {s.detail && !focus && (compact || showSceneNavigator) && (
                <SceneNavigator
                  key={s.viewKey}
                  detail={s.detail}
                  reader={s.reader}
                  target={s.readSource}
                  onTarget={openSceneTarget}
                  onSelect={chooseSource}
                  onLatest={chooseLatest}
                  compact={compact}
                  onLatestVisibilityChange={compact ? updateLatestPosition : undefined}
                  listOpen={sceneList}
                  onListOpenChange={setSceneList}
                  onCurrentLabel={updateScenePosition}
                  compactListOpener={sceneListOpener}
                />
              )}
            </div>
            {s.selected && (
              <div className="composer-dock">
                {pendingScenes.map((sourceId) => (
                  <NoticeBanner key={sourceId} tone="error">
                    {t('chatmanage.unknown')}{' '}
                    <button
                      type="button"
                      className="secondary"
                      disabled={sceneDeletion?.chatId === s.selected}
                      onClick={() => openSceneDeletion(s.selected, sourceId)}
                    >
                      {t('chatmanage.confirmOutcome')}
                    </button>
                  </NoticeBanner>
                ))}
                {s.pendingProfile && (
                  <NoticeBanner tone="error">
                    {t('main.m095')}
                    <button
                      className="secondary"
                      onClick={() => {
                        setProfileSaveError(null);
                        setProfileConflict(null);
                        setRequestDecision({ scope: s.viewKey, kind: 'profile' });
                      }}
                    >
                      {t('main.m096')}
                    </button>
                  </NoticeBanner>
                )}
                <DismissibleError error={s.error} onDismiss={() => s.setError(null)} />
                {/^MODEL_(?:REQUIRED|UNAVAILABLE)(?::|$)/u.test(s.errorCode ?? '') && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setSettingsTab('models');
                      setPanel('settings');
                    }}
                  >
                    {t('main.m097')}
                  </button>
                )}
                {s.forkOrigin && s.forkOrigin.forkId === s.selected && (
                  <p className="composer-status fork-notice" role="status">
                    <span>
                      {t('main.forkNotice', { title: s.forkOrigin.title ?? t('main.story26') })}
                    </span>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => {
                        const origin = s.forkOrigin!.id;
                        s.dismissForkOrigin();
                        select(origin);
                      }}
                    >
                      {t('main.m098')}
                    </button>
                    <IconButton
                      label={t('main.m099')}
                      icon={X}
                      size={14}
                      className="fork-notice-close"
                      onClick={s.dismissForkOrigin}
                    />
                  </p>
                )}
                <div className="composer-context">
                  <NextRequestStatus
                    key={`next-request:${s.selected}`}
                    chatId={s.selected}
                    refreshKey={
                      s.detail
                        ? `${s.detail.chat.headRevision}:${s.detail.chat.settingsRevision}:${s.detail.reader.cursor}`
                        : null
                    }
                    compact={compact}
                    onOpenOutline={(nodeId) => openOutlineWorkspace(nodeId)}
                    onOpenOptions={() => showSidePanel('options')}
                    onOpenStoryGuide={() => openChatSettings('guide')}
                  />
                  <ActivityStatus
                    key={s.viewKey}
                    chatId={s.selected}
                    scope={s.viewKey}
                    activities={s.detail?.reader.activity ?? []}
                    request={s.requestActivity}
                    connected={s.connected}
                    onDetails={() => inspect('')}
                    recoveryRequestId={
                      s.hasPendingRequest && s.requestActivity?.status === 'uncertain'
                        ? s.requestActivity.id
                        : undefined
                    }
                    recoveryBusy={s.submitting.includes(s.viewKey)}
                    recoveryError={s.error}
                    onRecoverRequest={(requestId) => {
                      if (
                        s.hasPendingRequest &&
                        s.requestActivity?.status === 'uncertain' &&
                        s.requestActivity.id === requestId &&
                        !s.submitting.includes(s.viewKey)
                      )
                        void generate();
                    }}
                    seenRunIds={seenRuns}
                  />
                </div>
                {!sourceEditing &&
                  !s.hasPendingRequest &&
                  !!s.detail &&
                  !!s.library &&
                  !s.promptWorkspace &&
                  s.promptWorkspaceError && (
                    <p className="muted" role="alert">
                      {t('main.m100')}{' '}
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => void s.refreshPromptWorkspace()}
                      >
                        {t('main.m101')}
                      </button>
                    </p>
                  )}
                {!sourceEditing &&
                  !s.hasPendingRequest &&
                  modelCheckReady &&
                  ((!testMode && !mainAvailable) || !promptAvailable) && (
                    <p className="muted" role="status">
                      {!promptAvailable
                        ? t('main.m102')
                        : pinned?.mainModel
                          ? t('main.m103')
                          : t('main.m104')}{' '}
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          if (pinned?.mainModel || !promptAvailable) {
                            setSettingsSection(!promptAvailable ? 'prompts' : 'models');
                            setPanel('story');
                          } else {
                            setSettingsTab('models');
                            setPanel('settings');
                          }
                        }}
                      >
                        {pinned?.mainModel || !promptAvailable ? t('main.m003') : t('main.m097')}
                      </button>
                    </p>
                  )}
                {s.draftRecovery && !sourceEditing && (
                  <div className="notice" role="alert">
                    <p>{t('main.m105')}</p>
                    <details>
                      <summary>{t('main.m106')}</summary>
                      <p>{s.draftRecovery.text}</p>
                    </details>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => s.resolveDraftRecovery(true)}
                    >
                      {t('main.m107')}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => s.resolveDraftRecovery(false)}
                    >
                      {t('main.m108')}
                    </button>
                  </div>
                )}
                {s.queueNotice && !sourceEditing && (
                  <p className="composer-status fork-notice queue-notice" role="status">
                    <span>{t(s.queueNotice)}</span>
                    <IconButton
                      label={t('main.m099')}
                      icon={X}
                      size={14}
                      className="fork-notice-close"
                      onClick={s.dismissQueueNotice}
                    />
                  </p>
                )}
                {s.queuedRequest && !sourceEditing && (
                  <div className="queued-request" role="group" aria-label={t('main.queuedTitle')}>
                    <ListEnd size={14} aria-hidden="true" />
                    <span className="queued-request-label">{t('main.queuedTitle')}</span>
                    <span className="queued-request-text">{s.queuedRequest.text}</span>
                    <IconButton
                      label={t('main.queuedCancel')}
                      icon={X}
                      size={14}
                      className="fork-notice-close"
                      onClick={s.cancelQueuedRequest}
                    />
                  </div>
                )}
                <ChatComposer
                  hidden={sourceEditing}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitRequest();
                  }}
                  onDragOver={(event) => {
                    if (event.dataTransfer.types.includes('Files')) event.preventDefault();
                  }}
                  onDrop={(event) => {
                    if (!event.dataTransfer.files.length) return;
                    event.preventDefault();
                    void s.addDraftImages(Array.from(event.dataTransfer.files));
                  }}
                >
                  <input
                    ref={requestImageInput}
                    type="file"
                    className="sr-only"
                    aria-label={t('main.m109')}
                    accept="image/png,image/jpeg,image/webp"
                    multiple
                    disabled={
                      !s.draftReady ||
                      !!s.draftRecovery ||
                      s.imagesDecoding ||
                      s.submitting.includes(s.viewKey)
                    }
                    onChange={(event) => {
                      void s.addDraftImages(Array.from(event.target.files ?? []));
                      event.target.value = '';
                    }}
                  />
                  <DraftRequestImages
                    images={s.draftImages}
                    remove={s.removeDraftImage}
                    disabled={!s.draftReady || s.submitting.includes(s.viewKey)}
                  />
                  <LoreResetChip
                    selected={s.loreContextReset}
                    disabled={
                      s.hasPendingRequest ||
                      s.submitting.includes(s.viewKey) ||
                      !!s.active ||
                      !s.detail ||
                      s.pendingProfile
                    }
                    onChange={s.editLoreContextReset}
                  />
                  <label className="sr-only" htmlFor="request">
                    {t('main.m110')}
                  </label>
                  <DraftComposerInput
                    draft={s.composerDraft}
                    inputRef={s.input}
                    disabled={!s.draftReady}
                    onPaste={(event) => {
                      const files = Array.from(event.clipboardData.files);
                      if (files.length) {
                        event.preventDefault();
                        void s.addDraftImages(files);
                      }
                    }}
                    id="request"
                    data-uimori-part="composer-input"
                    maxLength={REQUEST_TEXT_MAX_CHARS}
                    enterSend={enterSend}
                    onSelect={s.rememberCursor}
                    onChange={(event) => s.editDraft(event.target.value)}
                    onSend={() => {
                      void submitRequest();
                    }}
                    placeholder={
                      compact
                        ? t('main.m111')
                        : t('main.composerPlaceholder', { key: sendKeyLabel(enterSend) })
                    }
                  />
                  <div className="quick-controls">
                    <ComposerMore
                      key={s.viewKey}
                      selected={s.loreContextReset}
                      disabled={
                        s.hasPendingRequest ||
                        s.submitting.includes(s.viewKey) ||
                        !!s.active ||
                        !s.detail ||
                        s.pendingProfile
                      }
                      onChange={s.editLoreContextReset}
                    >
                      <button
                        type="button"
                        className="secondary"
                        data-closes-composer-menu
                        disabled={
                          !s.draftReady || s.imagesDecoding || s.submitting.includes(s.viewKey)
                        }
                        onClick={() => requestImageInput.current?.click()}
                      >
                        <ImagePlus size={18} aria-hidden="true" />
                        {t('main.m112')}
                      </button>

                      {(creativePresets.length > 0 || !!s.library || hasCreativeOptions) && (
                        <div
                          className="composer-menu-group"
                          role="group"
                          aria-label={t('main.m113')}
                        >
                          {creativePresets.length > 0 && (
                            <label className="composer-menu-choice">
                              <span>{t('main.m114')}</span>
                              <select
                                aria-label={t('main.m115')}
                                aria-describedby={
                                  optionsDirty ? 'composer-options-review' : undefined
                                }
                                value=""
                                disabled={
                                  s.quickBusy ||
                                  optionsBusy ||
                                  optionsDirty ||
                                  s.profileDirty ||
                                  !s.detail
                                }
                                onChange={(event) => {
                                  void s.quickChange('combination', event.target.value);
                                }}
                              >
                                <option value="">{t('main.m116')}</option>
                                {creativePresets.map((item) => (
                                  <option value={refValue(item)} key={refValue(item)}>
                                    {item.title}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                          {s.library && (
                            <div className="composer-menu-persona">
                              <span aria-hidden="true">{t('main.m117')}</span>
                              <ContentPicker
                                library={s.library}
                                role="persona"
                                label={t('main.m118')}
                                describedBy={optionsDirty ? 'composer-options-review' : undefined}
                                value={s.persona ? refValue(s.persona) : ''}
                                selectedContent={s.persona}
                                allowNone
                                noneLabel={s.attachmentsReady ? t('main.m119') : t('main.m120')}
                                disabled={
                                  s.quickBusy ||
                                  optionsBusy ||
                                  optionsDirty ||
                                  s.profileDirty ||
                                  !s.detail ||
                                  !s.attachmentsReady
                                }
                                onChange={(value) => {
                                  void s.quickChange('persona', value);
                                }}
                              />
                            </div>
                          )}
                          {hasCreativeOptions && (
                            <button
                              ref={optionsButton}
                              id="composer-options-review"
                              type="button"
                              className="secondary creative-options-button"
                              aria-label={t('main.m121')}
                              aria-expanded={optionsOpen}
                              aria-controls="chat-prompt-options"
                              disabled={!s.detail}
                              onClick={() =>
                                optionsOpen ? setWorkspacePanel(null) : showSidePanel('options')
                              }
                            >
                              <SlidersHorizontal size={18} aria-hidden="true" />
                              {t('main.writingOptions', { dirty: String(optionsDirty) })}
                            </button>
                          )}
                        </div>
                      )}
                      <div className="composer-menu-group" role="group" aria-label={t('main.m122')}>
                        <button
                          type="button"
                          className="secondary"
                          disabled={
                            optionsBusy ||
                            optionsDirty ||
                            s.profileDirty ||
                            s.quickBusy ||
                            (draftEmpty && s.requestImagePreviews.length === 0)
                          }
                          onClick={() => setChatTool({ scope: s.viewKey, kind: 'preview' })}
                        >
                          <Eye size={18} aria-hidden="true" />
                          {t('main.m123')}
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          disabled={!s.detail?.chat.headRevision}
                          onClick={() => setChatTool({ scope: s.viewKey, kind: 'lore' })}
                        >
                          <BookOpen size={18} aria-hidden="true" />
                          {t('main.m124')}
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          disabled={optionsBusy || optionsDirty || s.profileDirty || s.quickBusy}
                          onClick={() => setChatTool({ scope: s.viewKey, kind: 'compact' })}
                        >
                          <Minimize size={18} aria-hidden="true" />
                          {t('main.m125')}
                        </button>
                      </div>
                      {compact && !s.inputTranslation.busy && (
                        <InputTranslationControls
                          translation={s.inputTranslation}
                          disabled={inputTranslationDisabled}
                          empty={draftEmpty}
                          inMenu
                        />
                      )}
                    </ComposerMore>
                    {(!compact || s.inputTranslation.busy) && (
                      <InputTranslationControls
                        translation={s.inputTranslation}
                        disabled={inputTranslationDisabled}
                        empty={draftEmpty}
                      />
                    )}
                    {compact &&
                      sceneNavigatorEnabled &&
                      !focus &&
                      !sourceEditing &&
                      latestPosition?.scope === s.viewKey &&
                      latestPosition.visible && (
                        <IconButton
                          label={t('main.m126')}
                          icon={DownIcon}
                          size={18}
                          className="scene-latest-inline"
                          onClick={s.chooseLatest}
                        />
                      )}
                  </div>
                  {s.active && !s.hasPendingRequest ? (
                    <div className="send-actions">
                      {!draftEmpty && !s.queuedRequest && (
                        <button
                          key="queue"
                          className="send-button queue-button"
                          aria-label={t('main.queueButton')}
                          title={t('main.queueButton')}
                          disabled={
                            optionsBusy ||
                            s.submitting.includes(s.viewKey) ||
                            !s.draftReady ||
                            s.imagesDecoding
                          }
                        >
                          <ListEnd size={18} />
                        </button>
                      )}
                      <button
                        key="cancel"
                        type="button"
                        className="send-button"
                        aria-label={s.cancelling ? t('main.m127') : t('main.m128')}
                        title={s.cancelling ? t('main.m021') : t('main.m129')}
                        disabled={s.cancelling}
                        aria-busy={s.cancelling}
                        onClick={() => void s.cancelActive()}
                      >
                        <Square size={18} />
                      </button>
                    </div>
                  ) : (
                    <button
                      key="send"
                      className="send-button"
                      aria-label={s.hasPendingRequest ? t('main.m130') : t('main.m131')}
                      title={
                        s.hasPendingRequest
                          ? t('main.m132')
                          : t('main.sendShortcut', { key: sendKeyLabel(enterSend) })
                      }
                      disabled={
                        optionsBusy ||
                        s.submitting.includes(s.viewKey) ||
                        !s.draftReady ||
                        s.imagesDecoding ||
                        (!!s.draftImages.length &&
                          !testMode &&
                          imageSupport === false &&
                          !s.hasPendingRequest) ||
                        (draftEmpty && !s.draftImages.length && !s.hasPendingRequest) ||
                        !s.detail ||
                        (((!testMode && !mainAvailable) || !promptAvailable) &&
                          !s.hasPendingRequest &&
                          !s.pendingProfile)
                      }
                    >
                      {s.hasPendingRequest ? <RefreshCw size={21} /> : <ArrowUp size={21} />}
                    </button>
                  )}
                </ChatComposer>
                {!sourceEditing && (
                  <InputTranslationFeedback
                    translation={s.inputTranslation}
                    disabled={inputTranslationDisabled}
                  />
                )}
                {sourceEditing && s.active && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={s.cancelling}
                    aria-busy={s.cancelling}
                    onClick={() => void s.cancelActive()}
                  >
                    {s.cancelling ? t('main.m021') : t('main.m128')}
                  </button>
                )}
                <p className="composer-status" role="status" hidden={sourceEditing}>
                  {composerStatus}
                </p>
              </div>
            )}
          </>
        )}
      </main>
      {s.detail && s.destination === 'story' && (
        <>
          {currentChatTool === 'preview' && (
            <DraftRequestPreviewDialog
              key={`request-preview:${s.selected}`}
              open
              chatId={s.detail.chat.id}
              draft={s.composerDraft}
              requestImages={s.requestImagePreviews}
              loreContextReset={s.loreContextReset}
              refreshKey={`${s.detail.chat.headRevision}:${s.detail.chat.settingsRevision}:${s.detail.profile?.revision}:${s.detail.reader.cursor}:${s.promptWorkspace?.revision}:${s.pinnedPromptRevision}:${s.nativeInteractionRevision}`}
              unavailable={
                !!s.active ||
                s.hasPendingRequest ||
                s.pendingProfile ||
                optionsBusy ||
                optionsDirty ||
                s.profileDirty ||
                s.quickBusy
              }
              onClose={() => {
                setChatTool(null);
                requestAnimationFrame(() =>
                  document.querySelector<HTMLButtonElement>('button[data-composer-more]')?.focus()
                );
              }}
            />
          )}
          {contextToolsMounted && (
            <ChatContextDialog
              key={`context-tools:${s.selected}`}
              mode={
                currentChatTool === 'lore' || currentChatTool === 'compact' ? currentChatTool : null
              }
              chatId={s.detail.chat.id}
              headRevision={s.detail.chat.headRevision}
              refreshKey={s.detail.reader.cursor}
              onClose={() => {
                setChatTool(null);
                requestAnimationFrame(() =>
                  document.querySelector<HTMLButtonElement>('button[data-composer-more]')?.focus()
                );
              }}
              onRefresh={() => s.refresh(s.selected)}
              onError={s.setError}
            />
          )}
          {exportMounted && (
            <ManuscriptExportDialog
              key={`manuscript-export:${s.selected}`}
              open={currentChatTool === 'export'}
              chatId={s.detail.chat.id}
              onClose={() => {
                setChatTool(null);
                requestAnimationFrame(() =>
                  document.querySelector<HTMLElement>('.chat-menu summary')?.focus()
                );
              }}
            />
          )}
        </>
      )}
      <ChatPromptOptions
        modal={panelModal}
        chatId={s.selected || undefined}
        open={optionsVisible}
        tabs={renderSidePanelTabs(t('chatsettings.m156'))}
        workspace={s.promptWorkspace}
        promptRevision={`${s.detail?.profile?.revision ?? 0}:${s.pinnedPromptRevision ?? 0}`}
        disabled={
          optionsBusy ||
          s.profileDirty ||
          s.quickBusy ||
          s.submitting.includes(s.viewKey) ||
          s.hasPendingRequest ||
          s.pendingProfile
        }
        onClose={() => {
          setWorkspacePanel((value) => (value === 'options' ? null : value));
          requestAnimationFrame(() => {
            const target = optionsButton.current;
            if (target?.checkVisibility()) target.focus();
            else document.querySelector<HTMLButtonElement>('button[data-composer-more]')?.focus();
          });
        }}
        onDirtyChange={setOptionsDirty}
        onBusyChange={setOptionsBusy}
      />
      <StoryBoardPanel
        open={boardVisible}
        modal={panelModal}
        tabs={renderSidePanelTabs(t('shared.close', { title: t('storyUi.boardLabel') }))}
        onClose={() => setWorkspacePanel(null)}
        board={storyBoard}
        style={s.detail?.chat.settings.storyUiStyle}
        translated={readingLanguage === 'translation'}
      />
      {helperMounted && (
        <HelperPanel
          navigationActions={helperNavigationActions}
          searchRequest={helperSearchRequest}
          onSelectConversation={closeNavigationDrawer}
          navigationHost={
            helperWorkspaceOpen && (panel === 'navigation' || !sidebarHidden)
              ? helperNavigationHost
              : null
          }
          ready={helperWorkspaceOpen || s.destination !== 'story' || !s.selected || !!s.detail}
          expanded={helperWorkspaceOpen}
          returnToSidecar={helperReturnToSidecar.current}
          onToggleExpanded={toggleHelperExpanded}
          navigationLeading={navigationControls}
          onScopeChange={rememberHelperScope}
          returnLabel={
            s.destination === 'story'
              ? s.detail?.chat.title
              : t(libraryTab === 'prompts' ? 'transfer.m286' : 'transfer.m285')
          }
          onOpenTarget={openHelperTarget}
          onOpenChange={openHelperChangeTarget}
          modal={panelModal}
          enterSend={enterSend}
          responseDisplay={responseDisplay}
          modelDescription={helperDescription}
          modelTitle={
            helperModel?.title ??
            (s.promptWorkspace?.helperModel ? helperDescription : t('main.m015'))
          }
          modelRevision={s.promptWorkspace?.revision ?? 0}
          library={s.library}
          currentChat={s.detail?.chat}
          open={helperOpen}
          navigation={helperNavigation}
          handoff={helperHandoff}
          handoffEpoch={helperHandoffEpoch}
          resource={s.destination === 'library' && libraryTab === 'prompts' ? helperResource : null}
          onClearResource={clearHelperResource}
          outlineWorkspace={panel === 'outline'}
          tabs={helperExpanded ? undefined : renderSidePanelTabs(t('helpers.m045'))}
          scope={helperPanelScope}
          onClose={closeHelper}
          onModelSettings={openModelSettings}
        />
      )}
      {workspacePanelOpen && !panelModal && (
        <SidePanelResizer
          width={shownPanelWidth}
          minimum={panelMinimum}
          maximum={panelMaximum}
          controls={
            helperOpen
              ? 'helper-panel'
              : optionsVisible
                ? 'chat-prompt-options'
                : boardVisible
                  ? 'story-board-panel'
                  : 'outline-panel'
          }
          onResize={setPanelWidth}
        />
      )}
      <CodexContentWarningDialog gate={s.codexWarning} />
      <CodexContentWarningDialog gate={s.inputTranslation.codexWarning} />
      <Dialog
        open={!!currentRequestDecision}
        title={currentRequestDecision === 'profile' ? t('main.m133') : t('main.m134')}
        variant="confirmation"
        onClose={() => {
          if (!profileSaving) setRequestDecision(null);
        }}
      >
        {currentRequestDecision === 'profile' ? (
          <>
            <p>{t('main.m135')}</p>
            {profileSaveError && <NoticeBanner tone="error">{profileSaveError}</NoticeBanner>}
            <div className="form-actions">
              <button
                className="secondary"
                disabled={profileSaving}
                onClick={() => setRequestDecision(null)}
              >
                {t('main.m136')}
              </button>
              {profileConflict?.chatId === s.selected && (
                <button
                  type="button"
                  className="secondary"
                  disabled={profileSaving}
                  onClick={() => {
                    try {
                      acceptSavedStoryProfile(profileConflict.chatId, profileConflict.savedIntent);
                      setProfileConflict(null);
                      setRequestDecision(null);
                      void s.refresh(profileConflict.chatId).catch(s.setError);
                    } catch (error) {
                      setProfileSaveError(toUiMessage(error));
                    }
                  }}
                >
                  {t('main.pendingProfileUseSaved')}
                </button>
              )}
              <button
                disabled={profileSaving}
                onClick={() => {
                  const chatId = s.selected;
                  setProfileSaving(true);
                  setProfileSaveError(null);
                  setProfileConflict(null);
                  void (async () => {
                    try {
                      await completePendingStoryProfile(chatId);
                      await s.refresh(chatId);
                      setRequestDecision(null);
                    } catch (error) {
                      setProfileSaveError(toUiMessage(error));
                      if (error instanceof PendingStoryProfileConflict)
                        setProfileConflict({ chatId, savedIntent: error.savedIntent });
                    } finally {
                      setProfileSaving(false);
                    }
                  })();
                }}
              >
                {profileSaving ? t('main.m137') : t('main.m096')}
              </button>
            </div>
          </>
        ) : (
          <>
            <p>{t('main.m138')}</p>
            {s.requestActivity?.confirmationBlocked && <p>{t('main.pendingRequestUnconfirmed')}</p>}
            {s.error && <NoticeBanner tone="error">{s.error}</NoticeBanner>}
            <div className="form-actions">
              <button className="secondary" onClick={() => setRequestDecision(null)}>
                {t('main.m136')}
              </button>
              {s.requestActivity?.confirmationBlocked && (
                <button
                  className="secondary"
                  onClick={() => {
                    if (s.forgetPendingRequest(s.requestActivity!.id)) setRequestDecision(null);
                  }}
                >
                  {t('main.pendingRequestForget')}
                </button>
              )}
              <button
                onClick={() => {
                  setRequestDecision(null);
                  void generate();
                }}
              >
                {t('main.m139')}
              </button>
            </div>
          </>
        )}
      </Dialog>
      <Dialog
        open={!!pendingNavigation}
        title={t('main.m140')}
        variant="confirmation"
        onClose={() => {
          if (!discardingNavigation) setPendingNavigation(null);
        }}
      >
        <p>{t('main.m141')}</p>
        <ResourceEditorLeaveWarning />
        {navigationDiscardError && (
          <p role="alert" className="error">
            {formatUiMessage(navigationDiscardError)}
          </p>
        )}
        <DraftDiscardActions
          open={!!pendingNavigation}
          disabled={discardingNavigation}
          onContinue={() => setPendingNavigation(null)}
          onSave={async () => {
            const go = pendingNavigation;
            if (!go) return false;
            setDiscardingNavigation(true);
            try {
              if (!(await saveActiveEditor())) return false;
              setPendingNavigation(null);
              setLibraryDirty(false);
              go();
              return true;
            } finally {
              setDiscardingNavigation(false);
            }
          }}
          onDiscard={async () => {
            setDiscardingNavigation(true);
            setNavigationDiscardError(null);
            try {
              await discardActiveEditor();
              const go = pendingNavigation;
              setPendingNavigation(null);
              setLibraryDirty(false);
              go?.();
            } catch (error) {
              setNavigationDiscardError(toUiMessage(error));
            } finally {
              setDiscardingNavigation(false);
            }
          }}
          discardLabel={t('main.m142')}
        />
      </Dialog>
      <CommandPalette
        open={paletteOpen}
        entries={paletteOpen ? paletteEntries() : []}
        onClose={() => setPaletteOpen(false)}
        onSearch={searchFromKeyboard}
      />
      <Dialog
        open={searchingChats}
        title={t('main.m143')}
        onClose={() => setSearchingChats(false)}
        onAfterClose={() => {
          const opener = searchOpener.current;
          searchOpener.current = null;
          if (opener?.isConnected && opener.checkVisibility()) {
            opener.focus();
            return;
          }
          const target = [
            ...document.querySelectorAll<HTMLButtonElement>(
              'button[data-global-search], button[data-navigation-menu]'
            ),
          ].find((button) => button.checkVisibility());
          target?.focus();
        }}
        className="manuscript-search-dialog"
      >
        {searchingChats && (
          <ManuscriptSearchPanel
            data-global-search
            label={t('main.m143')}
            initialQuery={keyboardSearch?.query}
            autoFocus={!!keyboardSearch}
            chats={s.chats}
            library={s.library}
            onChat={(id) => {
              setSearchingChats(false);
              select(id);
            }}
            onNavigate={(target) => {
              setSearchingChats(false);
              select(target.chatId, target);
            }}
          />
        )}
      </Dialog>
      <Dialog
        open={panel === 'navigation'}
        title={t('main.m057')}
        onClose={() => {
          navigationReturnFocus.current = navigationOpener.current;
          setPanel('');
        }}
        onAfterClose={() => {
          const target = navigationReturnFocus.current;
          navigationReturnFocus.current = null;
          if (panel === '' && target === navigationOpener.current && target?.isConnected)
            target.focus();
        }}
        className="navigation-dialog"
        headerLeading={
          panel === 'navigation' ? (
            <NavigationQuickActions
              onSearch={openWorkspaceSearch}
              onNewChat={startNewStory}
              helperWorkspace={helperWorkspaceOpen}
              onNewHelper={createHelperSession}
            />
          ) : undefined
        }
      >
        {panel === 'navigation' && navigation(false)}
      </Dialog>
      <Dialog
        open={panel === 'new'}
        title={t('main.m004')}
        onClose={() => setPanel('')}
        className="new-story-dialog"
      >
        {s.library && (
          <NewStory
            key={newKey}
            library={s.library}
            initialBot={initialBot}
            initialFolder={initialFolder}
            initialPersona={initialPersona}
            initialModules={initialModules}
            quickStart={quickStartNew && panel === 'new'}
            onModelSettings={() => {
              setQuickStartNew(false);
              settingsReturnToNew.current = true;
              setSettingsTab('models');
              setPanel('settings');
            }}
            onCreated={async (chat) => {
              await s.loadChats();
              if (newStoryView.current.key === newKey && newStoryView.current.active)
                select(chat.id);
            }}
          />
        )}
      </Dialog>
      <Dialog
        open={!!moduleToUse}
        title={t('main.m144')}
        onClose={() => !s.quickBusy && setModuleToUse(null)}
      >
        {moduleToUse && (
          <>
            <ContentAvatar content={moduleToUse} />
            <p>{t('main.moduleChat', { title: moduleToUse.title })}</p>
            {s.detail && (
              <button
                type="button"
                disabled={s.quickBusy || s.profileDirty || optionsDirty || optionsBusy}
                onClick={() => {
                  const chatId = s.detail!.chat.id;
                  void s.quickChange('module', refValue(moduleToUse)).then((saved) => {
                    if (saved) {
                      setModuleToUse(null);
                      select(chatId);
                    }
                  });
                }}
              >
                {t('main.addModule', { title: s.detail.chat.title })}
              </button>
            )}
            <button
              type="button"
              className="secondary"
              disabled={s.quickBusy}
              onClick={() => {
                const module = moduleToUse;
                setModuleToUse(null);
                newStory(undefined, undefined, undefined, [module]);
              }}
            >
              {t('main.m145')}
            </button>
            <DismissibleError error={s.error} onDismiss={() => s.setError(null)} />
          </>
        )}
      </Dialog>
      {panel === 'story' && (
        <ChatSettingsPanel
          key={s.selected}
          state={s}
          onClose={() => setPanel('')}
          onOpenHelper={() => setWorkspacePanel('helper')}
          onAskHelper={(text) => {
            const scope: HelperScope = { kind: 'chat', chatId: s.selected };
            setHelperHandoff({
              kind: 'draft',
              epoch: ++helperHandoffEpoch.current,
              key: crypto.randomUUID(),
              text,
              scope,
              conversationId: selectedHelperSession(scope) ?? undefined,
            });
            setWorkspacePanel('helper');
          }}
          initialSection={settingsSection}
          onGlobalSettings={(section) => {
            setSettingsTab(section);
            setPanel('settings');
          }}
        />
      )}
      {panel === 'model' && s.library && s.detail?.profile && (
        <ChatModelPicker
          key={s.viewKey}
          open
          scopeKey={s.viewKey}
          library={s.library}
          selectedModelId={pinned?.mainModel?.id}
          defaultModelId={s.promptWorkspace?.modelRoutes.main?.id}
          disabled={
            s.profileDirty || optionsDirty || optionsBusy || s.pendingProfile || s.hasPendingRequest
          }
          pending={s.quickBusy}
          error={s.error}
          onSelect={(modelId) => {
            const scope = s.viewKey;
            void s.quickChange('model', modelId ?? '').then((saved) => {
              if (saved && modelPickerScope.current === scope) setPanel('');
            });
          }}
          onClose={() => setPanel('')}
          onManage={() => {
            setSettingsTab('connections');
            setPanel('settings');
          }}
        />
      )}
      {s.detail &&
        (panel === 'outline' || outlineSidecarVisible || outlineChat === s.detail.chat.id) && (
          <div
            id="outline-panel"
            className={panel === 'outline' ? 'outline-workspace-shell' : 'outline-sidecar'}
            hidden={panel === 'outline' ? helperOpen && panelModal : !outlineSidecarVisible}
            onKeyDown={(event) => {
              if (
                event.key === 'Escape' &&
                !(event.target as Element).closest('details[open],dialog[open]')
              ) {
                event.preventDefault();
                if (panel === 'outline') closeOutlineWorkspace();
                else setWorkspacePanel(null);
              }
            }}
          >
            {panel !== 'outline' &&
              renderSidePanelTabs(t('prompts.uiCloseHierarchicalOutline'))?.(() =>
                setWorkspacePanel(null)
              )}
            <OutlinePanel
              key={s.detail.chat.id}
              state={s}
              target={outlineTarget}
              layout={panel === 'outline' ? 'workspace' : 'sidecar'}
              visible={panel === 'outline' || outlineSidecarVisible}
              onClose={closeOutlineWorkspace}
              onExpand={() => openOutlineWorkspace()}
              helperVisible={panel === 'outline' && helperOpen}
              onToggleHelper={() => {
                setWorkspacePanel((value) => (value === 'helper' ? null : 'helper'));
              }}
              onHelp={(request) => {
                setHelperHandoff({
                  ...request,
                  kind: 'outline',
                  epoch: ++helperHandoffEpoch.current,
                });
                setWorkspacePanel('helper');
              }}
            />
          </div>
        )}

      <Dialog
        scopeKey={s.selected}
        open={panel === 'tasks'}
        title={t('main.m006')}
        onClose={() => setPanel('')}
        wide
      >
        {panel === 'tasks' && (
          <TasksPanel
            state={s}
            inspectedRun={inspectedRun}
            onInspect={setInspectedRun}
            onClose={() => setPanel('')}
            onAskHelper={(kind, id) => {
              const scope: HelperScope = { kind: 'chat', chatId: s.selected };
              setHelperScope(scope);
              setHelperHandoff({
                kind: 'draft',
                epoch: ++helperHandoffEpoch.current,
                key: crypto.randomUUID(),
                text: t('helpers.analyzeTaskRequest', { kind, id }),
                scope,
              });
              setPanel('');
              setWorkspacePanel('helper');
            }}
          />
        )}
      </Dialog>
      <Dialog
        open={panel === 'reading'}
        title={t('main.m070')}
        onClose={() => setPanel('')}
        className="reading-settings-dialog"
      >
        {renderReadingSettings(() => {
          setFocus(true);
          setPanel('');
        })}
      </Dialog>
      {panel === 'settings' && (
        <AppSettingsPanel
          onEditPrompt={(presetId) => {
            settingsReturnToNew.current = false;
            const go = () => {
              setPromptToEdit(presetId ?? null);
              setLibraryTab('prompts');
              s.showLibrary();
              setPanel('');
            };
            if (libraryDirty && s.destination === 'library') {
              setPanel('');
              setPendingNavigation(() => go);
            } else go();
          }}
          onClose={() => {
            setPanel(settingsReturnToNew.current ? 'new' : '');
            settingsReturnToNew.current = false;
          }}
          initialTab={settingsTab}
          storyUiThemeTarget={storyUiThemeTarget}
          state={s}
          theme={theme}
          setTheme={setTheme}
          enterSend={enterSend}
          setEnterSend={setEnterSend}
          sidebarWidth={sidebarWidth}
          setSidebarWidth={setSidebarWidth}
          readingSettings={renderReadingSettings()}
        />
      )}
    </div>
  );
  return (
    <ReadingPreferencesContext value={reading.settings}>
      <TransientNotice content={s.notice} />
      <ReaderEditingContext value={onSourceEditing}>
        <ResourceAnchorContext value={resourceAnchorRequest}>
          <EditorHelperContext value={askEditorHelper}>{workspace}</EditorHelperContext>
        </ResourceAnchorContext>
      </ReaderEditingContext>
      {sceneDeletion && (
        <SceneDeleteDialog
          key={`${sceneDeletion.chatId}:${sceneDeletion.sourceId}`}
          chatId={sceneDeletion.chatId}
          sourceId={sceneDeletion.sourceId}
          visible={
            sceneDeletion.chatId === s.selected && s.destination === 'story' && !helperWorkspaceOpen
          }
          onClose={() =>
            setSceneDeletion((current) => (current === sceneDeletion ? null : current))
          }
          onError={(error) => {
            if (sceneDeletion.chatId === s.selected && s.destination === 'story') s.setError(error);
          }}
          onPendingChange={() => setSceneDeletionVersion((version) => version + 1)}
          onDeleted={sceneDeletion.onDeleted}
        />
      )}
      <Dialog
        open={nativeNotices.length > 0}
        title={t('main.m146')}
        onClose={() => setNativeNotices((notices) => notices.slice(1))}
      >
        <p style={{ whiteSpace: 'pre-wrap' }}>{nativeNotices[0]}</p>
        <button onClick={() => setNativeNotices((notices) => notices.slice(1))}>
          {t('main.m147')}
        </button>
      </Dialog>
    </ReadingPreferencesContext>
  );
}
sweepUnregisteredStorage();
startPwa();
void loadInitialLocale().then(() =>
  createRoot(document.getElementById('root')!).render(
    <SessionGate>
      <MaintenanceBanner />
      <ThemeProvider>
        <FontProvider>
          <TransientNoticeProvider>
            <ShortcutKeys />
            <App />
          </TransientNoticeProvider>
        </FontProvider>
      </ThemeProvider>
    </SessionGate>
  )
);
