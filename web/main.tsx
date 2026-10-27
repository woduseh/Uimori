import { t, message as uiMessage, useI18n, translateMessage } from './i18n.js';
import { imageInputSupported } from '../core/provider-image-reference.js';
import { DraftRequestImages } from './RequestImages.js';
import type { OutlineHelperRequest } from './outline-helper.js';
import { downloadArchive } from './archive-download.js';
import { ReaderEditingContext } from './Bookmarks.js';
import type { NotificationIntent } from '../core/push.js';
import { startPwa, subscribeNotificationNavigation } from './pwa.js';
import type { ReaderTarget } from '../core/reader-target.js';
import { ThemeProvider, useThemes } from './ThemeContext.js';
import { FontProvider, useFonts } from './FontContext.js';
import { REQUEST_TEXT_MAX_CHARS } from '../core/content-limits.js';
import { promptControls } from '../core/risu-prompt.js';
import { DraftDiscardActions } from './DraftDiscardActions.js';
import { BotChatImportDialog } from './BotChatImportDialog.js';
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
import { ReaderLoadingState } from './ReaderLoadingState.js';
import { ChatComposer, ComposerInput } from './ChatComposer.js';
import { InputTranslationControls, InputTranslationFeedback } from './InputTranslation.js';
import { ComposerMore, LoreResetChip } from './ComposerMore.js';
import { ChatContextDialog } from './ChatContextDialog.js';
import { ChatModelPicker } from './ChatModelPicker.js';
import { RequestPreviewDialog } from './RequestPreviewDialog.js';
import { ManuscriptExportDialog } from './ManuscriptExportDialog.js';
import { ManuscriptSearchPanel } from './ManuscriptSearch.js';
import { IconButton } from './IconButton.js';
import { PinIcon, CloseIcon, DownIcon } from './ui-icons.js';
import { ActionMenu } from './ActionMenu.js';
import { useCompactLayout } from './useCompactLayout.js';
import { subscribeAppHistory } from './app-history.js';
import { ChatPromptOptions } from './ChatPromptOptions.js';
import { HelperPanel } from './HelperPanel.js';
import { api } from './api.js';
import { selectedHelperSession } from './useHelperSessions.js';
import type { HelperRecentTask } from '../core/activity-feed.js';
import type { HelperScope, HelperResourceRef, HelperTaskResultTarget } from '../core/helper.js';
import { ResponseDisplay } from './StreamingResponse.js';
import { CancelledRun } from './CancelledRun.js';
import { canDismissReaderRun } from '../core/reader-conversation.js';
import {
  readPresentationChoice,
  readFontSize,
  writePresentationSetting,
  type ResponseDisplayMode,
} from './presentation-settings.js';
import {
  discardActiveEditor,
  getActiveEditorContext,
  saveActiveEditor,
  ResourceEditorLeaveWarning,
} from './resource-editor.js';
import type { Section as ChatSettingsSection } from './ChatSettingsPanel.js';
import { ReaderPages } from './ReaderPages.js';
import { SceneNavigator } from './SceneNavigator.js';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowUp,
  BookOpen,
  ChevronDown,
  Download,
  Eye,
  GitFork,
  ImagePlus,
  ListTree,
  Maximize,
  Menu,
  MessageCircle,
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
import { TurnActivity } from './TurnActivity.js';
import { SessionGate } from './SessionGate.js';
import { MaintenanceBanner } from './MaintenanceBanner.js';
import { Dialog } from './Dialog.js';
import { CodexContentWarningDialog } from './CodexContentWarningDialog.js';
import { DeleteButton } from './DeleteButton.js';
import { BotNavigation, NavigationQuickActions, type ChatFolder } from './BotTreeNavigation.js';
import { completePendingStoryProfile } from './pendingStory.js';
import { useStory } from './useStory.js';
import { useTestMode } from './useTestMode.js';
import { ActivityStatus } from './ActivityStatus.js';
import { modelLabel } from './storyLabels.js';
import './style.css';
import './product.css';
import './sidebar.css';

function workspaceFallback(title: string, navigation: ReactNode, content: ReactNode) {
  return (
    <>
      <header className="workspace-header">
        {navigation}
        <div className="header-title">
          <h1>{translateMessage(title)}</h1>
        </div>
      </header>
      <div className="workspace-fallback-body">{content}</div>
    </>
  );
}
const LibraryPanel = deferredPanel(
  '서재',
  async () => ({
    default: (await import('./LibraryPanel.js')).LibraryPanel,
  }),
  (content, props) => workspaceFallback('서재', props.headerLeading, content)
);
const PromptLibrary = deferredPanel(
  '프롬프트',
  async () => ({
    default: (await import('./PromptLibrary.js')).PromptLibrary,
  }),
  (content, props) => workspaceFallback('프롬프트', props.headerLeading, content)
);
const ChatSettingsPanel = deferredPanel(
  '채팅 설정',
  async () => ({
    default: (await import('./ChatSettingsPanel.js')).ChatSettingsPanel,
  }),
  (content, props) => (
    <Dialog open title="채팅 설정" onClose={props.onClose} wide className="settings-dialog">
      {content}
    </Dialog>
  )
);
const NewStory = deferredPanel('새 채팅', async () => ({
  default: (await import('./NewStory.js')).NewStory,
}));
const AppSettingsPanel = deferredPanel(
  '설정',
  async () => ({
    default: (await import('./WorkspacePanels.js')).AppSettingsPanel,
  }),
  (content, props) => (
    <Dialog open title="설정" onClose={props.onClose} wide className="settings-dialog">
      {content}
    </Dialog>
  )
);

const TasksPanel = deferredPanel('작업 현황', async () => ({
  default: (await import('./WorkspacePanels.js')).TasksPanel,
}));
const OutlinePanel = deferredPanel('계층형 구성', async () => ({
  default: (await import('./OutlinePanel.js')).OutlinePanel,
}));

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
/* Device layout preferences share the same optional browser storage. */
const READING_WIDTHS = [760, 880, 1040];
const PANEL_WIDTHS = [360, 384, 480, 560];
const SIDEBAR_WIDTH = 248;
const SIDEBAR_WIDTHS = [SIDEBAR_WIDTH, 320, 400];
const RAIL_WIDTH = 56;
/* Below this the centre column stops being comfortable to read or edit in. */
const MIN_CENTER_WIDTH = 768;
const runFailed = (status: string) =>
  ['failed', 'cancelled', 'interrupted', 'refused', 'partial'].includes(status);
function App() {
  useI18n();
  const s = useStory();
  const { setScope: setThemeScope } = useThemes();
  const themeChatId = s.destination === 'story' ? s.selected : undefined;
  const themeBotId = themeChatId
    ? s.chats.find((chat) => chat.id === themeChatId)?.botId
    : undefined;
  useEffect(() => {
    setThemeScope({ chatId: themeChatId || undefined, botId: themeBotId });
  }, [themeChatId, themeBotId, setThemeScope]);
  const [nativeNotices, setNativeNotices] = useState<string[]>([]);
  const testMode = useTestMode();
  const compact = useCompactLayout();

  // Compact widths open the scene list from the header title; the rail owns it otherwise.
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
  // Chat settings may open on a specific section (the failure card's 모델 설정).
  const [settingsSection, setSettingsSection] = useState<ChatSettingsSection | undefined>();
  const openChatSettings = (section?: ChatSettingsSection) => {
    setSettingsSection(section);
    setPanel('story');
  };
  // Pending turns the reader has scrolled into view: their failure card replaces the composer notice.
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
  // A dialog opened from the chat ⋯ menu returns focus to the menu button, because the
  // menu item that opened it is hidden again by the time the dialog closes.
  const menuReturn = useRef<HTMLElement | null>(null);
  const fromChatMenu = (event: { currentTarget: HTMLElement }) => {
    menuReturn.current =
      event.currentTarget.closest('.chat-menu')?.querySelector<HTMLElement>('summary') ?? null;
  };
  const [settingsTab, setSettingsTab] = useState<string | undefined>();
  const [promptToEdit, setPromptToEdit] = useState<string | null>(null);
  const [helperResource, setHelperResource] = useState<HelperResourceRef | null>(null);
  const clearHelperResource = useCallback(() => setHelperResource(null), []);
  const [workspacePanel, setWorkspacePanel] = useState<'options' | 'helper' | null>(null);
  const [helperExpanded, setHelperExpanded] = useState(false);
  const [helperScope, setHelperScope] = useState<HelperScope | null>(null);
  const rememberHelperScope = useCallback((next: HelperScope) => {
    setHelperScope((previous) =>
      JSON.stringify(previous) === JSON.stringify(next) ? previous : next
    );
  }, []);
  const helperReturnToSidecar = useRef(false);
  const [helperSidebarExpanded, setHelperSidebarExpanded] = useState(false);
  const [contentToOpen, setContentToOpen] = useState<string | null>(null);
  const helperResultNavigation = useRef(0);
  const [helperNavigation, setHelperNavigation] = useState<{
    conversationId: string;
    taskId: string;
    sequence: number;
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
    !!s.pendingRequest ||
    s.submitting.includes(s.viewKey);
  const [outlineHelperRequest, setOutlineHelperRequest] = useState<OutlineHelperRequest>();
  const [helperDraftRequest, setHelperDraftRequest] = useState<{
    key: string;
    text: string;
    scope: HelperScope;
    conversationId?: string;
  }>();
  const [helperSelection, setHelperSelection] = useState<{
    key: string;
    sourceId: string;
    sourceHash: string;
    text: string;
    conversationId?: string;
    scope: HelperScope;
  }>();
  const [editingSources, setEditingSources] = useState<string[]>([]);
  const onSourceEditing = useCallback((sourceId: string, editing: boolean) => {
    setEditingSources((current) =>
      editing ? [...new Set([...current, sourceId])] : current.filter((id) => id !== sourceId)
    );
  }, []);
  const sourceEditing = editingSources.length > 0;
  const [requestDecision, setRequestDecision] = useState<{
    scope: string;
    kind: 'profile' | 'admission';
  } | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileSaveError, setProfileSaveError] = useState('');
  const currentRequestDecision =
    requestDecision?.scope === s.viewKey &&
    (requestDecision.kind === 'profile' ? s.pendingProfile : !!s.pendingRequest)
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
    if (s.pendingProfile || s.pendingRequest) {
      setProfileSaveError('');
      setRequestDecision({ scope: s.viewKey, kind: s.pendingProfile ? 'profile' : 'admission' });
      return false;
    }
    return s.generate();
  };
  const optionsButton = useRef<HTMLButtonElement>(null);
  const requestImageInput = useRef<HTMLInputElement>(null);
  const [panel, setPanel] = useState<Panel>('');
  const [searchingChats, setSearchingChats] = useState(false);
  const searchOpener = useRef<HTMLElement | null>(null);
  const openChatSearch = () => {
    searchOpener.current = document.activeElement as HTMLElement | null;
    setSearchingChats(true);
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
      s.setError('');
    }
  }, [errorScope, s.setError]);
  const [newKey, setNewKey] = useState(0);
  const newStoryView = useRef({ key: newKey, active: panel === 'new' });
  newStoryView.current = { key: newKey, active: panel === 'new' };
  const modelPickerScope = useRef<string | null>(null);
  modelPickerScope.current = panel === 'model' ? s.viewKey : null;
  const settingsReturnToNew = useRef(false);
  const [focus, setFocus] = useState(false);
  const [sceneNavigatorEnabled, setSceneNavigatorEnabled] = useState(
    () => readPresentationChoice('uimori:scene-navigator', ['true', 'false'], 'true') === 'true'
  );
  const showSceneNavigator = sceneNavigatorEnabled && !focus;
  // Hiding visual navigation must not disable the title's scene-list shortcut.
  useEffect(() => {
    if (focus) setSceneList(false);
  }, [focus]);
  useEffect(() => {
    writePresentationSetting('uimori:scene-navigator', String(sceneNavigatorEnabled));
  }, [sceneNavigatorEnabled]);
  const [inspectedRun, setInspectedRun] = useState('');
  const [chatTool, setChatTool] = useState<{
    scope: string;
    kind: 'lore' | 'compact' | 'export' | 'preview';
  } | null>(null);
  const currentChatTool = chatTool?.scope === s.viewKey ? chatTool.kind : null;
  const navigationOpener = useRef<HTMLButtonElement>(null);
  const navigationReturnFocus = useRef<HTMLButtonElement>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => readPresentationChoice('uimori:sidebar-collapsed', ['true', 'false'], 'false') === 'true'
  );
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [panelSidebarExpanded, setPanelSidebarExpanded] = useState(false);
  const [readingWidth, setReadingWidth] = useState(() =>
    readPresentationChoice('uimori:reading-width', READING_WIDTHS, 880)
  );
  const [panelWidth, setPanelWidth] = useState(() =>
    readPresentationChoice('uimori:panel-width', PANEL_WIDTHS, 384)
  );
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    readPresentationChoice('uimori:sidebar-width', SIDEBAR_WIDTHS, SIDEBAR_WIDTH)
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
  const workspacePanelOpen =
    (helperOpen && !helperExpanded) || (optionsOpen && s.destination === 'story' && !!s.selected);
  /* Dock only while the centre column keeps its minimum readable width. Collapsing
     navigation frees the sidebar down to the icon rail, not to nothing. */
  const dockBesideSidebar = desktopSidebarWidth + panelWidth + MIN_CENTER_WIDTH;
  const dockBesideRail = RAIL_WIDTH + panelWidth + MIN_CENTER_WIDTH;
  const autoCollapseSidebar =
    workspacePanelOpen &&
    viewportWidth >= dockBesideRail &&
    viewportWidth < dockBesideSidebar &&
    !panelSidebarExpanded;
  const sidebarHidden = helperWorkspaceOpen
    ? !helperSidebarExpanded
    : sidebarCollapsed || autoCollapseSidebar;
  const panelModal =
    viewportWidth < dockBesideRail || (!sidebarHidden && viewportWidth < dockBesideSidebar);
  useEffect(() => {
    if (!workspacePanelOpen) setPanelSidebarExpanded(false);
  }, [workspacePanelOpen]);
  useEffect(() => {
    writePresentationSetting('uimori:sidebar-collapsed', String(sidebarCollapsed));
  }, [sidebarCollapsed]);
  const [theme, setTheme] = useState(() =>
    readPresentationChoice('uimori:theme', ['system', 'dark', 'light'] as const, 'system')
  );
  const [font, setFont] = useState<string>(() =>
    readPresentationChoice('uimori:font', ['sans', 'serif'], 'sans')
  );
  const [fontSize, setFontSize] = useState(readFontSize);
  const [enterSend, setEnterSend] = useState(
    () => readPresentationChoice('uimori:enter-send', ['true', 'false'], 'false') === 'true'
  );
  const [readingLanguage, setReadingLanguage] = useState<string>(() =>
    readPresentationChoice('uimori:reading-language', ['translation', 'original'], 'translation')
  );
  const [illustrationsCollapsed, setIllustrationsCollapsed] = useState(
    () =>
      readPresentationChoice('uimori:illustrations-collapsed', ['true', 'false'], 'false') ===
      'true'
  );
  useEffect(() => {
    writePresentationSetting('uimori:illustrations-collapsed', String(illustrationsCollapsed));
  }, [illustrationsCollapsed]);
  const [responseDisplay, setResponseDisplay] = useState<ResponseDisplayMode>(() =>
    readPresentationChoice('uimori:response-display', ['stream', 'complete'] as const, 'stream')
  );
  const fonts = useFonts();
  const reading = useReadingPreferences(font, fontSize, readingWidth, fonts);

  const [libraryDirty, setLibraryDirty] = useState(false);
  const [importBot, setImportBot] = useState<Content | null>(null);
  const [pendingNavigation, setPendingNavigation] = useState<null | (() => void)>(null);
  const [discardingNavigation, setDiscardingNavigation] = useState(false);
  const [navigationDiscardError, setNavigationDiscardError] = useState('');
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
  // Both the reader and model routes must settle before an absent model is actionable.
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
  // The model is a header chip at every width; narrow widths shorten the empty states so the
  // chip leaves room for the title. The accessible name keeps the full description.
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
        !!s.pendingRequest
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
        s.setError('');
        setPanel('model');
      }}
    >
      {(pinned?.mainModel || pinned?.mainPromptPresetId) && (
        <PinIcon size={12} aria-hidden="true" />
      )}
      <span>
        {t('main.modelChip', {
          model: compact ? mainShortDescription : mainDescription,
          pinned: String(!!(pinned?.mainModel || pinned?.mainPromptPresetId)),
          prompt: String(promptAvailable),
        })}
      </span>
    </button>
  );
  const composerStatus = [
    s.pendingRequest && !s.submitting.includes(s.viewKey) ? t('main.m020') : '',
    s.cancelling ? t('main.m021') : '',
    s.imagesDecoding ? t('main.m022') : '',
    s.draftImages.length && !testMode && imageSupport === false ? t('main.m023') : '',
    s.draftImages.length && !testMode && imageSupport === null ? t('main.m024') : '',
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
    writePresentationSetting('uimori:theme', theme);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => {
    writePresentationSetting('uimori:enter-send', String(enterSend));
  }, [enterSend]);
  useEffect(() => {
    writePresentationSetting('uimori:reading-language', readingLanguage);
  }, [readingLanguage]);
  useEffect(() => {
    writePresentationSetting('uimori:response-display', responseDisplay);
  }, [responseDisplay]);
  useEffect(() => {
    document.documentElement.style.setProperty('--sidebar-w', `${desktopSidebarWidth}px`);
  }, [desktopSidebarWidth]);
  useEffect(() => {
    writePresentationSetting('uimori:sidebar-width', String(sidebarWidth));
  }, [sidebarWidth]);
  useEffect(() => {
    document.documentElement.style.setProperty('--panel-w', `${panelWidth}px`);
    writePresentationSetting('uimori:panel-width', String(panelWidth));
  }, [panelWidth]);
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
    setPanel('');
    setHelperExpanded(true);
    setWorkspacePanel('helper');
    setHelperNavigation((previous) => ({
      conversationId: task.conversationId,
      taskId: task.id,
      sequence: (previous?.sequence ?? 0) + 1,
    }));
  }
  function showLibrary(tab: 'bot' | 'persona' | 'module' | 'prompts' = 'bot') {
    helperResultNavigation.current++;
    const go = () => {
      if (helperWorkspaceOpen) setWorkspacePanel(null);
      setHelperExpanded(false);
      setLibraryTab(tab);
      // Choosing the navigation entry for the section you are in returns to that section's list,
      // even when the tab does not change. The panel keeps its own unsaved-draft protection.
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
  async function openHelperResult(target: HelperTaskResultTarget) {
    const navigation = ++helperResultNavigation.current;
    const editor = getActiveEditorContext();
    if (editor?.kind === target.kind && editor.targetId === target.id) {
      setHelperExpanded(false);
      return;
    }
    const go = async () => {
      if (target.kind === 'content') {
        const content = await api<Content>(`/content/${encodeURIComponent(target.id)}`);
        await s.loadLibrary();
        if (navigation !== helperResultNavigation.current) return;
        setLibraryTab(
          content.kind === 'persona' || content.kind === 'module' ? content.kind : 'bot'
        );
        setContentToOpen(content.id);
        s.showLibrary();
      } else if (target.kind === 'prompt-preset') {
        await s.loadLibrary();
        if (navigation !== helperResultNavigation.current) return;
        setLibraryTab('prompts');
        setPromptToEdit(target.id);
        s.showLibrary();
      } else if (target.kind === 'settings' && target.setting?.startsWith('chat.')) {
        if (s.selected !== target.id || s.destination !== 'story') s.select(target.id);
        setSettingsSection(target.setting === 'chat.maxCalls' ? 'runtime' : 'prompts');
        setPanel('story');
      } else {
        setSettingsTab(
          target.kind === 'theme'
            ? 'themes'
            : target.kind === 'illustration-preset'
              ? 'illustrations'
              : target.kind === 'prompt-workspace'
                ? 'prompts'
                : target.setting === 'model.pricing'
                  ? 'connections'
                  : 'models'
        );
        setPanel('settings');
      }
      setHelperExpanded(false);
    };
    if (
      libraryDirty &&
      s.destination === 'library' &&
      (target.kind === 'content' ||
        target.kind === 'prompt-preset' ||
        (target.kind === 'settings' && target.setting?.startsWith('chat.')))
    )
      setPendingNavigation(() => () => void go().catch((error) => s.setError(error.message)));
    else await go();
  }
  function inspect(id: string) {
    setInspectedRun(id);
    setPanel('tasks');
  }
  // The drawer shows the quick actions in its header row instead of the brand row.
  const toggleSidebar = () => {
    if (helperWorkspaceOpen) setHelperSidebarExpanded((value) => !value);
    else if (autoCollapseSidebar && !sidebarCollapsed) setPanelSidebarExpanded(true);
    else {
      setSidebarCollapsed(!sidebarCollapsed);
      setPanelSidebarExpanded(false);
    }
  };
  const navigation = (quickActions: boolean, collapsed = false) => (
    <BotNavigation
      libraryError={s.libraryError}
      quickActions={quickActions}
      onSearch={openChatSearch}
      collapsed={collapsed}
      onToggleCollapse={toggleSidebar}
      library={s.library}
      chats={s.chats}
      selected={s.selected}
      destination={s.destination}
      libraryTab={libraryTab}
      onSelect={select}
      onNew={newStory}
      onConfigureNew={configureNewStory}
      onImportChat={(bot) => {
        setPanel('');
        setImportBot(bot);
      }}
      onLibrary={showLibrary}
      onChatsChanged={s.loadChats}
      onCopyChat={s.copyChat}
      copyingChats={s.forking.map((key) => key.split(':')[0])}
      onLibraryChanged={s.retryLibrary}
      onError={s.setError}
      onSettings={() => {
        setSettingsTab(undefined);
        setPanel('settings');
      }}
      onTasks={() => inspect('')}
      onOpenHelperTask={openRecentHelper}
      helperOpen={helperOpen}
      helperExpanded={helperWorkspaceOpen}
      onToggleHelper={() => {
        if (panel === 'navigation') setPanel('');
        helperReturnToSidecar.current = false;
        setHelperExpanded(true);
        setWorkspacePanel('helper');
      }}
      tasks={s.tasks}
    />
  );
  const navigationControls = (
    <>
      <IconButton
        ref={navigationOpener}
        className="mobile-menu"
        data-navigation-menu
        label={t('main.m026')}
        icon={Menu}
        onClick={() => setPanel('navigation')}
      />
    </>
  );
  const destinationHelperControl = s.destination !== 'story' && !helperOpen && (
    <IconButton
      className="destination-helper"
      label={t('main.m027')}
      icon={MessageCircle}
      aria-expanded={helperOpen}
      aria-controls="helper-panel"
      onClick={() => {
        setWorkspacePanel((value) => (value === 'helper' ? null : 'helper'));
      }}
    />
  );
  function renderReadingSettings(onStartFocus?: () => void) {
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
            <div className="reading-option-toggle">
              <div>
                <strong>{t('main.m037')}</strong>
                <small>{t('main.m038')}</small>
              </div>
              <label className="check">
                <Switch
                  aria-label={t('main.m039')}
                  data-reading-setting="navigator"
                  checked={sceneNavigatorEnabled}
                  onChange={(event) => setSceneNavigatorEnabled(event.target.checked)}
                />
              </label>
            </div>
          </div>
        </section>

        <section className="settings-group" aria-label={t('main.m041')}>
          <div className="settings-group-body">
            <label className="settings-row">
              <span className="settings-row-copy">
                <strong>{t('main.m042')}</strong>
                <small>{t('main.m043')}</small>
              </span>
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
          </div>
        </section>

        <section className="settings-group" aria-label={t('main.m046')}>
          <header className="settings-group-heading">
            <h4>{t('main.m046')}</h4>
          </header>
          <div className="settings-group-body">
            <label className="settings-row">
              <span className="settings-row-copy">
                <strong>{t('main.m047')}</strong>
                <small>{t('main.m048')}</small>
              </span>
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
          </div>
        </section>

        <section className="settings-group" aria-label={t('main.m051')}>
          <div className="settings-group-body">
            <label className="settings-row">
              <span className="settings-row-copy">
                <strong>{t('main.m052')}</strong>
                <small>{t('main.m053')}</small>
              </span>
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
      className={`app-shell ${panel === 'outline' ? 'outline-active' : ''} ${focus && !helperWorkspaceOpen ? 'focus-reading' : ''} ${sidebarHidden ? 'sidebar-collapsed' : ''} ${optionsOpen && s.destination === 'story' && s.selected ? 'options-open' : ''} ${helperOpen ? 'helper-open' : ''} ${helperWorkspaceOpen ? 'helper-expanded' : ''} ${workspacePanelOpen ? (panelModal ? 'panel-overlay' : 'panel-docked') : ''}`}
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
              {(s.bot?.title || (compact && !focus && scenePosition?.scope === s.viewKey)) && (
                <small className="header-reading-context">
                  {compact && !focus && scenePosition?.scope === s.viewKey && (
                    <span className="header-scene-position">{scenePosition.label}</span>
                  )}
                  {s.bot?.title && (
                    <span className="header-chat-context">
                      {t('main.botPersona', {
                        bot: s.bot.title,
                        persona: s.persona?.title ?? '',
                        hasPersona: String(!!s.persona),
                      })}
                    </span>
                  )}
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
                  {!compact && !helperOpen && (
                    <IconButton
                      label={t('main.m027')}
                      icon={MessageCircle}
                      aria-expanded={false}
                      aria-controls="helper-panel"
                      onClick={() => {
                        setWorkspacePanel('helper');
                      }}
                    />
                  )}
                  {focus && (
                    <button
                      className="icon-button"
                      aria-label={t('main.m060')}
                      title={t('main.m060')}
                      onClick={() => setFocus(false)}
                    >
                      <Minimize size={19} />
                    </button>
                  )}
                  {!compact && (
                    <button
                      className="icon-button"
                      aria-label={t('main.m003')}
                      title={t('main.m003')}
                      onClick={() => openChatSettings()}
                    >
                      <SlidersHorizontal size={20} />
                    </button>
                  )}
                  <ActionMenu label={t('main.m061')} className="chat-menu">
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
                            <MessageCircle size={18} aria-hidden="true" />
                            {t('main.m062')}
                          </button>
                        </>
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
                      {s.detail && (
                        <button
                          type="button"
                          className="secondary"
                          onClick={(event) => {
                            fromChatMenu(event);
                            setPanel('outline');
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
                        title={t('main.m068')}
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
                        {t('main.m069')}
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={!sceneCount}
                        onClick={() => setChatTool({ scope: s.viewKey, kind: 'export' })}
                      >
                        <Download size={18} aria-hidden="true" />
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
                          ).catch((error: Error) => s.setError(error.message));
                        }}
                      >
                        <Download size={18} aria-hidden="true" />
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
                          label={t('main.m072')}
                          description={t('main.m073')}
                          disabled={!!s.active}
                          onError={s.setError}
                          onDeleted={() => s.loadChats()}
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
            label={t('main.m074')}
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
                />
              ) : (
                workspaceFallback(
                  t('main.m002'),
                  navigationControls,
                  <LoadingState
                    presentation="region"
                    loading={!s.libraryError}
                    error={s.libraryError}
                    label={t('main.m078')}
                    errorLabel={t('main.m079')}
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
              />
            )}
            <DismissibleError
              message={!s.library && s.error === s.libraryError ? '' : s.error}
              onDismiss={() => s.setError('')}
            />
          </div>
        ) : (
          <>
            {s.readingSync.other && (
              <NoticeBanner
                label={t('main.m080')}
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
                onScroll={s.savePosition}
              >
                <section
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
                      onRetry={() =>
                        void s.refresh(s.selected).catch(() => {
                          // The selected reader owns its load failure and recovery action.
                        })
                      }
                    />
                  ) : (
                    <>
                      {(s.profileAsset ||
                        (s.sources.length > 0 && s.attachmentsReady && s.bot)) && (
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
                              <ContentAvatar content={s.bot} />
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
                          {s.bot && (
                            <ContentAvatar content={s.bot} className="first-scene-avatar" />
                          )}
                          <h2>{t('main.m091')}</h2>
                          <p className="muted">{t('main.firstSceneRequestIdeas')}</p>
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
                              estimatedCost={
                                s.detail!.runs.find((run) => run.id === source.runId)?.estimatedCost
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
                              onError={s.setError}
                              onFork={s.fork}
                              deletionDisabled={!!s.active || sourceEditing}
                              onDeleted={async (result) => {
                                try {
                                  if (result.chatId === s.selected)
                                    s.chooseSource(result.headRevision ?? '', true);
                                  await s.loadChats();
                                } catch (cause) {
                                  s.setError((cause as Error).message);
                                }
                              }}
                              onNativeNotice={(messages) =>
                                setNativeNotices((previous) => [...previous, ...messages])
                              }
                              onRetry={
                                s.canReuseRun(source.runId)
                                  ? (mode, text) => s.generate(source.runId, text, false, mode)
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
                                  setHelperSelection({
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
                                s.canReuseRun(run.id) ? () => void s.generate(run.id) : undefined
                              }
                              onSubmit={
                                s.canReuseRun(run.id)
                                  ? (text) => s.generate(run.id, text)
                                  : undefined
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
                                s.canReuseRun(run.id)
                                  ? (text) => s.generate(run.id, text)
                                  : undefined
                              }
                              onConfirm={
                                s.pendingEditedRunId === run.id
                                  ? () => submitRequest(true)
                                  : undefined
                              }
                            />
                            <div className="run-outcome">
                              {/* Every turn, settled or not, carries the same status row as the
                                  helper conversation; the failure card adds the recovery actions. */}
                              <TurnActivity
                                run={run}
                                jobs={[]}
                                activities={s.detail!.reader.activity ?? []}
                                connected={s.connected}
                                revision={s.detail!.reader.cursor}
                                refresh={() => s.refresh(s.selected)}
                                onError={s.setError}
                              />
                              <ResponseDisplay
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
                                          void s.generate(run.id, undefined, true);
                                        }
                                      : undefined
                                  }
                                  status={run.status}
                                  error={run.error}
                                  disabled={s.reuseBlocked || optionsBusy}
                                  onRetry={
                                    s.canReuseRun(run.id)
                                      ? () => {
                                          void s.generate(run.id);
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
                                  onHistory={() => setPanel('tasks')}
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
                  onTarget={(target) => select(target.chatId, target)}
                  onSelect={s.chooseSource}
                  onLatest={s.chooseLatest}
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
                {s.pendingProfile && (
                  <NoticeBanner tone="error">
                    {t('main.m095')}
                    <button
                      className="secondary"
                      onClick={() => {
                        setProfileSaveError('');
                        setRequestDecision({ scope: s.viewKey, kind: 'profile' });
                      }}
                    >
                      {t('main.m096')}
                    </button>
                  </NoticeBanner>
                )}
                <DismissibleError message={s.error} onDismiss={() => s.setError('')} />
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
                    <span>{t('main.forkNotice', { title: s.forkOrigin.title })}</span>
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
                <ActivityStatus
                  key={s.viewKey}
                  chatId={s.selected}
                  scope={s.viewKey}
                  activities={s.detail?.reader.activity ?? []}
                  request={s.requestActivity}
                  connected={s.connected}
                  onDetails={() => inspect('')}
                  recoveryRequestId={
                    s.pendingRequest && s.requestActivity?.status === 'uncertain'
                      ? s.requestActivity.id
                      : undefined
                  }
                  recoveryBusy={s.submitting.includes(s.viewKey)}
                  recoveryError={s.error}
                  onRecoverRequest={(requestId) => {
                    if (
                      s.pendingRequest &&
                      s.requestActivity?.status === 'uncertain' &&
                      s.requestActivity.id === requestId &&
                      !s.submitting.includes(s.viewKey)
                    )
                      void s.generate();
                  }}
                  seenRunIds={seenRuns}
                />
                {!sourceEditing &&
                  !s.pendingRequest &&
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
                  !s.pendingRequest &&
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
                      !!s.pendingRequest ||
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
                  <ComposerInput
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
                    value={s.draft}
                    enterSend={enterSend}
                    onSelect={s.rememberCursor}
                    onChange={(event) => s.editDraft(event.target.value)}
                    onSend={() => {
                      if (!s.active || s.pendingRequest) void submitRequest();
                    }}
                    placeholder={
                      // A wrapping placeholder would grow the one-row composer on narrow screens.
                      compact
                        ? t('main.m111')
                        : t('main.composerPlaceholder', { key: enterSend ? 'Enter' : 'Ctrl+Enter' })
                    }
                  />
                  <div className="quick-controls">
                    <ComposerMore
                      key={s.viewKey}
                      selected={s.loreContextReset}
                      disabled={
                        !!s.pendingRequest ||
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
                              onClick={() => {
                                setWorkspacePanel((value) =>
                                  value === 'options' ? null : 'options'
                                );
                              }}
                            >
                              <SlidersHorizontal size={18} aria-hidden="true" />
                              {t('main.writingOptions', { dirty: String(optionsDirty) })}
                            </button>
                          )}
                        </div>
                      )}
                      <div className="composer-menu-group" role="group" aria-label={t('main.m122')}>
                        <div className="composer-menu-heading">{t('main.m122')}</div>
                        <button
                          type="button"
                          className="secondary"
                          disabled={
                            optionsBusy ||
                            optionsDirty ||
                            s.profileDirty ||
                            s.quickBusy ||
                            (!s.draft.trim() && s.requestImagePreviews.length === 0)
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
                    </ComposerMore>
                    <InputTranslationControls
                      translation={s.inputTranslation}
                      disabled={inputTranslationDisabled}
                      empty={!s.draft.trim()}
                    />
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
                  {s.active && !s.pendingRequest ? (
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
                  ) : (
                    <button
                      key="send"
                      className="send-button"
                      aria-label={s.pendingRequest ? t('main.m130') : t('main.m131')}
                      title={
                        s.pendingRequest
                          ? t('main.m132')
                          : t('main.sendShortcut', { key: enterSend ? 'Enter' : 'Ctrl+Enter' })
                      }
                      disabled={
                        optionsBusy ||
                        s.submitting.includes(s.viewKey) ||
                        !s.draftReady ||
                        s.imagesDecoding ||
                        (!!s.draftImages.length &&
                          !testMode &&
                          imageSupport === false &&
                          !s.pendingRequest) ||
                        (!s.draft.trim() && !s.draftImages.length && !s.pendingRequest) ||
                        !s.detail ||
                        (((!testMode && !mainAvailable) || !promptAvailable) &&
                          !s.pendingRequest &&
                          !s.pendingProfile)
                      }
                    >
                      {s.pendingRequest ? <RefreshCw size={21} /> : <ArrowUp size={21} />}
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
          <RequestPreviewDialog
            key={`request-preview:${s.selected}`}
            open={currentChatTool === 'preview'}
            chatId={s.detail.chat.id}
            request={s.draft}
            requestImages={s.requestImagePreviews}
            loreContextReset={s.loreContextReset}
            refreshKey={`${s.detail.chat.headRevision}:${s.detail.chat.settingsRevision}:${s.detail.profile?.revision}:${s.detail.reader.cursor}:${s.promptWorkspace?.revision}:${s.pinnedPromptRevision}:${s.nativeInteractionRevision}`}
            unavailable={
              !!s.active ||
              !!s.pendingRequest ||
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
        </>
      )}
      <ChatPromptOptions
        modal={panelModal}
        chatId={s.selected || undefined}
        open={optionsOpen && s.destination === 'story' && !!s.selected}
        workspace={s.promptWorkspace}
        promptRevision={`${s.detail?.profile?.revision ?? 0}:${s.pinnedPromptRevision ?? 0}`}
        disabled={
          optionsBusy ||
          s.profileDirty ||
          s.quickBusy ||
          s.submitting.includes(s.viewKey) ||
          !!s.pendingRequest ||
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
      <HelperPanel
        ready={helperWorkspaceOpen || s.destination !== 'story' || !s.selected || !!s.detail}
        expanded={helperWorkspaceOpen}
        returnToSidecar={helperReturnToSidecar.current}
        onToggleExpanded={() => {
          if (!helperExpanded) helperReturnToSidecar.current = true;
          setHelperExpanded((value) => !value);
        }}
        navigationLeading={navigationControls}
        onScopeChange={rememberHelperScope}
        returnLabel={
          s.destination === 'story'
            ? s.detail?.chat.title
            : t(libraryTab === 'prompts' ? 'transfer.m286' : 'transfer.m285')
        }
        onOpenTarget={openHelperResult}
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
        open={helperOpen}
        navigation={helperNavigation}
        selection={helperSelection}
        resource={s.destination === 'library' && libraryTab === 'prompts' ? helperResource : null}
        onClearResource={clearHelperResource}
        outlineRequest={outlineHelperRequest}
        draftRequest={helperDraftRequest}
        outlineWorkspace={panel === 'outline'}
        scope={
          helperScope ??
          (s.destination === 'story' && s.selected && s.detail
            ? { kind: 'chat', chatId: s.selected }
            : { kind: 'library', workId: `library:${libraryTab}` })
        }
        onClose={() => {
          helperResultNavigation.current++;
          setWorkspacePanel((value) => (value === 'helper' ? null : value));
        }}
        onModelSettings={() => {
          setSettingsTab('models');
          setPanel('settings');
        }}
      />
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
            {profileSaveError && (
              <NoticeBanner tone="error">{translateMessage(profileSaveError)}</NoticeBanner>
            )}
            <div className="form-actions">
              <button
                className="secondary"
                disabled={profileSaving}
                onClick={() => setRequestDecision(null)}
              >
                {t('main.m136')}
              </button>
              <button
                disabled={profileSaving}
                onClick={() => {
                  const chatId = s.selected;
                  setProfileSaving(true);
                  setProfileSaveError('');
                  void (async () => {
                    try {
                      await completePendingStoryProfile(chatId);
                      await s.refresh(chatId);
                      setRequestDecision(null);
                    } catch (error) {
                      setProfileSaveError((error as Error).message);
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
            <div className="form-actions">
              <button className="secondary" onClick={() => setRequestDecision(null)}>
                {t('main.m136')}
              </button>
              <button
                onClick={() => {
                  setRequestDecision(null);
                  void s.generate();
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
            {translateMessage(navigationDiscardError)}
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
            setNavigationDiscardError('');
            try {
              await discardActiveEditor();
              const go = pendingNavigation;
              setPendingNavigation(null);
              setLibraryDirty(false);
              go?.();
            } catch (error) {
              setNavigationDiscardError((error as Error).message);
            } finally {
              setDiscardingNavigation(false);
            }
          }}
          discardLabel={t('main.m142')}
        />
      </Dialog>
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
          // A width change may have removed the sidebar that opened this dialog.
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
          // Lazy destination loading may have replaced the native dialog's opener.
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
            <NavigationQuickActions onSearch={openChatSearch} onLibrary={showLibrary} />
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
              // Completing an admitted creation must not pull the user out of another task.
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
            <DismissibleError message={s.error} onDismiss={() => s.setError('')} />
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
            setHelperDraftRequest({
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
            s.profileDirty || optionsDirty || optionsBusy || s.pendingProfile || !!s.pendingRequest
          }
          pending={s.quickBusy}
          error={translateMessage(s.error)}
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
      {panel === 'outline' && (
        <div
          className="outline-workspace-shell"
          hidden={helperOpen && panelModal}
          onKeyDown={(event) => {
            if (
              event.key === 'Escape' &&
              !(event.target as Element).closest('details[open],dialog[open]')
            ) {
              event.preventDefault();
              setPanel('');
            }
          }}
        >
          <OutlinePanel
            key={s.detail?.chat.id}
            state={s}
            onClose={() => setPanel('')}
            helperVisible={helperOpen}
            onToggleHelper={() => {
              setWorkspacePanel((value) => (value === 'helper' ? null : 'helper'));
            }}
            onHelp={(request) => {
              setOutlineHelperRequest(request);
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
              setHelperDraftRequest({
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
          state={s}
          theme={theme}
          setTheme={setTheme}
          enterSend={enterSend}
          setEnterSend={setEnterSend}
          panelWidth={panelWidth}
          setPanelWidth={setPanelWidth}
          sidebarWidth={sidebarWidth}
          setSidebarWidth={setSidebarWidth}
          readingSettings={renderReadingSettings()}
        />
      )}
    </div>
  );
  return (
    <ReadingPreferencesContext value={reading.settings}>
      <TransientNotice message={s.notice} />
      <ReaderEditingContext value={onSourceEditing}>{workspace}</ReaderEditingContext>
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
startPwa();
createRoot(document.getElementById('root')!).render(
  <SessionGate>
    <MaintenanceBanner />
    <ThemeProvider>
      <FontProvider>
        <TransientNoticeProvider>
          <App />
        </TransientNoticeProvider>
      </FontProvider>
    </ThemeProvider>
  </SessionGate>
);
