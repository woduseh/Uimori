import { DraftDiscardActions } from './DraftDiscardActions.js';
import { RequestMessage } from './RequestMessage.js';
import { RetryFailure } from './RetryFailure.js';
import { isModelSelectable } from './model-selection.js';
import { combinationOwner, matchesPromptCombination } from '../core/prompt-combinations.js';
import { DismissibleError } from './DismissibleError.js';
import { ChatComposer, ComposerInput } from './ChatComposer.js';
import { ComposerMore, LoreResetChip } from './ComposerMore.js';
import { IconButton } from './IconButton.js';
import { PinIcon } from './ui-icons.js';
import { ActionMenu } from './ActionMenu.js';
import { useCompactLayout } from './useCompactLayout.js';
import { subscribeAppHistory } from './app-history.js';
import { ChatPromptOptions } from './ChatPromptOptions.js';
import { HelperPanel } from './HelperPanel.js';
import type { HelperScope } from '../core/helper.js';
import { StreamingResponse } from './StreamingResponse.js';
import { discardActiveEditor } from './editor-workspace-context.js';
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
  GitFork,
  History,
  ListTree,
  Maximize,
  Menu,
  MessageCircle,
  Minimize,
  PanelLeftClose,
  PanelLeftOpen,
  SlidersHorizontal,
  Square,
  Type,
  X,
} from 'lucide-react';
import type { Content } from '../core/product.js';
import { reconcilePromptValues } from '../core/prompt-program.js';
import { api, saveDownload } from './api.js';
import { refValue } from './content-ref.js';
import { deferredPanel } from './deferredPanel.js';
import { ContentPicker } from './ContentPicker.js';
import { ContentAvatar } from './ContentAvatar.js';
import type { PackageRole } from '../core/content-package.js';
import { SourceReader } from './SourceReader.js';
import { TurnActivity } from './TurnActivity.js';
import { PackageBehaviorPanel } from './PackageBehaviorPanel.js';
import { SessionGate } from './SessionGate.js';
import { Dialog } from './Dialog.js';
import { DeleteButton } from './DeleteButton.js';
import { BotNavigation, NavigationQuickActions, type ChatFolder } from './BotTreeNavigation.js';
import { completePendingStoryProfile } from './pendingStory.js';
import { useStory } from './useStory.js';
import { useTestMode } from './useTestMode.js';
import { usePanelDeepLink } from './usePanelDeepLink.js';
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
          <h1>{title}</h1>
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
    <Dialog open title="채팅 설정" onClose={props.onClose} wide>
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
    <Dialog open title="설정" onClose={props.onClose} wide>
      {content}
    </Dialog>
  )
);
const BranchesPanel = deferredPanel('보관된 전개', async () => ({
  default: (await import('./WorkspacePanels.js')).BranchesPanel,
}));
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
  | 'branches'
  | 'tasks'
  | 'settings'
  | 'reading'
  | 'outline';
const runActive = (status: string) => ['queued', 'running', 'waiting_for_state'].includes(status);
const runFailed = (status: string) =>
  ['failed', 'cancelled', 'interrupted', 'refused', 'partial'].includes(status);
function App() {
  const s = useStory();
  const testMode = useTestMode();
  const compact = useCompactLayout();

  // Compact widths open the scene list from the header title; the rail owns it otherwise.
  const [sceneList, setSceneList] = useState(false);
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
  const [settingsTab, setSettingsTab] = useState('general');
  const [promptToEdit, setPromptToEdit] = useState<string | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false),
    [optionsDirty, setOptionsDirty] = useState(false),
    [optionsBusy, setOptionsBusy] = useState(false);
  const [helperOpen, setHelperOpen] = useState(false);
  const [helperSelection, setHelperSelection] = useState<{
    key: string;
    sourceId: string;
    sourceHash: string;
    text: string;
    scope: HelperScope;
  }>();
  const [editingSources, setEditingSources] = useState<string[]>([]);
  const onSourceEditing = useCallback((sourceId: string, editing: boolean) => {
    setEditingSources((current) =>
      editing ? [...new Set([...current, sourceId])] : current.filter((id) => id !== sourceId)
    );
  }, []);
  const sourceEditing = editingSources.length > 0;
  const optionsButton = useRef<HTMLButtonElement>(null);
  const [panel, setPanel] = useState<Panel>('');
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new chat or branch starts with the list closed and nothing seen yet.
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
  const [initialModules, setInitialModules] = useState<Content[]>([]);
  const [moduleToUse, setModuleToUse] = useState<Content | null>(null);
  const [libraryTab, setLibraryTab] = useState<'bot' | 'persona' | 'module' | 'prompts'>('bot');
  usePanelDeepLink(!s.selected || s.detail?.chat.id === s.selected, (link) => {
    if (link.destination === 'library') {
      if (['bot', 'persona', 'module', 'prompts'].includes(link.tab))
        setLibraryTab(link.tab as typeof libraryTab);
      s.showLibrary();
    }
    const chatSections: ChatSettingsSection[] = [
      'characters',
      'prompts',
      'models',
      'story',
      'images',
      'runtime',
    ];
    const appSections = [
      'general',
      'models',
      'prompts',
      'connections',
      'agents',
      'illustrations',
      'data',
      'security',
    ];
    const panels: Panel[] = ['navigation', 'new', 'branches', 'tasks', 'reading', 'outline'];
    if (link.panel === 'story')
      openChatSettings(chatSections.find((section) => section === link.section) ?? undefined);
    else if (link.panel === 'settings') {
      if (appSections.includes(link.section)) setSettingsTab(link.section);
      setPanel('settings');
    } else if ((panels as string[]).includes(link.panel)) setPanel(link.panel as Panel);
  });
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
  const [focus, setFocus] = useState(false);
  const [inspectedRun, setInspectedRun] = useState('');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem('uimori:sidebar-collapsed') === 'true';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('uimori:sidebar-collapsed', String(sidebarCollapsed));
    } catch {
      /* Navigation still works when storage is unavailable. */
    }
  }, [sidebarCollapsed]);
  const [theme, setTheme] = useState<'system' | 'dark' | 'light'>(() => {
    const value = localStorage.getItem('uimori:theme');
    return value === 'dark' || value === 'light' ? value : 'system';
  });
  const [font, setFont] = useState(() => localStorage.getItem('uimori:font') || 'sans');
  const [fontSize, setFontSize] = useState(() =>
    Math.max(16, Math.min(22, Number(localStorage.getItem('uimori:font-size') || 18)))
  );
  const [enterSend, setEnterSend] = useState(
    () => localStorage.getItem('uimori:enter-send') === 'true'
  );
  const [readingLanguage, setReadingLanguage] = useState(
    () => localStorage.getItem('uimori:reading-language') || 'translation'
  );

  const [libraryDirty, setLibraryDirty] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<null | (() => void)>(null);
  const [discardingNavigation, setDiscardingNavigation] = useState(false);
  const [navigationDiscardError, setNavigationDiscardError] = useState('');
  const currentPrompt = s.currentPrompt;
  const pinned = s.detail?.profile?.pinned;
  const promptAvailable = !pinned?.mainPromptPresetId || !!currentPrompt;
  const hasCreativeOptions = !!currentPrompt?.program.controls.length;
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
  const currentProgram = currentPrompt?.program;
  const currentCombination = creativePresets.find((c) => {
    // Chat-fixed values are edited through the chat options API, separate from preset defaults.
    if (pinned?.mainPromptPresetId) return false;
    if (!currentPrompt || !currentProgram || c.role !== 'main') return false;
    const currentValues = reconcilePromptValues(currentProgram, currentPrompt.values).values;
    const savedValues = reconcilePromptValues(currentProgram, c.values).values;
    return currentProgram.controls.every(
      (control) => currentValues[control.id] === savedValues[control.id]
    );
  });
  const mainModelRef = pinned?.mainModel ?? s.promptWorkspace?.modelRoutes.main;
  const mainModel = s.library?.models.find((item) => item.id === mainModelRef?.id);
  const mainAvailable =
    !!mainModel &&
    !!s.library &&
    isModelSelectable(mainModel, s.library.models, s.library.connections);
  const mainDescription = mainModel
    ? `${modelLabel(mainModel, s.library)}${mainAvailable ? '' : ' · 사용 불가'}`
    : mainModelRef
      ? '선택한 본문 모델 · 확인 필요'
      : '본문 모델을 선택해 주세요';
  const helperModel = s.library?.models.find(
    (item) => item.id === s.promptWorkspace?.helperModel?.id
  );
  const helperAvailable =
    !!helperModel &&
    !!s.library &&
    isModelSelectable(helperModel, s.library.models, s.library.connections);
  const helperDescription = helperModel
    ? `${modelLabel(helperModel, s.library)}${helperAvailable ? '' : ' · 사용 불가'}`
    : s.promptWorkspace?.helperModel
      ? '선택한 도우미 모델 · 확인 필요'
      : '도우미 모델을 선택해 주세요';
  // The model is a header chip at every width; narrow widths shorten the empty states so the
  // chip leaves room for the title. The accessible name keeps the full description.
  const mainShortDescription = mainModel
    ? `${mainModel.title}${mainAvailable ? '' : ' · 사용 불가'}`
    : mainModelRef
      ? '모델 확인 필요'
      : '모델 선택';
  const mainModelChip = (
    <button
      type="button"
      className="model-chip secondary"
      aria-label={`현재 본문 모델 · ${mainDescription}${pinned?.mainModel ? ' · 이 채팅 고정' : ''}${pinned?.mainPromptPresetId ? ` · 작문 프롬프트 ${promptAvailable ? '이 채팅 고정' : '사용 불가'}` : ''}`}
      title={
        pinned?.mainModel || pinned?.mainPromptPresetId
          ? `${mainDescription} · 이 채팅 고정 · ${pinned.mainModel ? '본문 모델' : ''}${pinned.mainModel && pinned.mainPromptPresetId ? ' · ' : ''}${pinned.mainPromptPresetId ? `작문 프롬프트: ${currentPrompt?.title ?? '사용 불가'}` : ''}`
          : '모든 채팅의 이후 요청에 적용되는 전역 모델 설정'
      }
      onClick={() => {
        if (pinned?.mainModel || pinned?.mainPromptPresetId) {
          setSettingsSection(pinned.mainModel ? 'models' : 'prompts');
          setPanel('story');
        } else {
          setSettingsTab('models');
          setPanel('settings');
        }
      }}
    >
      {(pinned?.mainModel || pinned?.mainPromptPresetId) && (
        <PinIcon size={12} aria-hidden="true" />
      )}
      <span>
        {compact ? mainShortDescription : mainDescription}
        {(pinned?.mainModel || pinned?.mainPromptPresetId) && ' · 고정'}
        {!promptAvailable && ' · 프롬프트 사용 불가'}
      </span>
    </button>
  );
  const composerStatus = [
    s.pendingRequest && !s.submitting.includes(s.viewKey)
      ? '이전 전송의 수락을 확인해 주세요. 새 초안은 보존돼요.'
      : s.notice,
    s.profileDirty ? '채팅 설정에 미저장 변경' : '',
  ]
    .filter(Boolean)
    .join(' · ');
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
    };
    apply();
    media.addEventListener('change', apply);
    localStorage.setItem('uimori:theme', theme);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => {
    document.documentElement.dataset.readingFont = font;
    document.documentElement.style.setProperty('--reading', `${fontSize}px`);
    localStorage.setItem('uimori:font', font);
    localStorage.setItem('uimori:font-size', String(fontSize));
  }, [font, fontSize]);
  useEffect(() => {
    localStorage.setItem('uimori:enter-send', String(enterSend));
  }, [enterSend]);
  useEffect(() => {
    localStorage.setItem('uimori:reading-language', readingLanguage);
  }, [readingLanguage]);
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
    const onPop = () => setPanel('');
    return subscribeAppHistory(onPop);
  }, []);
  function newStory(
    bot?: Content,
    folder?: ChatFolder,
    persona?: Content,
    modules: Content[] = []
  ) {
    setInitialBot(bot);
    setInitialFolder(folder);
    setInitialPersona(persona);
    setInitialModules(modules);
    setNewKey((old) => old + 1);
    setPanel('new');
  }
  function select(id: string) {
    const go = () => {
      s.select(id);
      setPanel('');
    };
    if (libraryDirty && s.destination === 'library') {
      setPanel('');
      setPendingNavigation(() => go);
    } else go();
  }
  function showLibrary(tab: 'bot' | 'persona' | 'module' | 'prompts' = 'bot') {
    const go = () => {
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
  function useContent(content: Content, role: PackageRole) {
    if (role === 'bot') newStory(content);
    else if (role === 'persona') newStory(undefined, undefined, content);
    else setModuleToUse(content);
  }
  function inspect(id: string) {
    setInspectedRun(id);
    setPanel('tasks');
  }
  // The drawer shows the quick actions in its header row instead of the brand row.
  const navigation = (quickActions: boolean) => (
    <BotNavigation
      quickActions={quickActions}
      library={s.library}
      chats={s.chats}
      selected={s.selected}
      destination={s.destination}
      onSelect={select}
      onNew={newStory}
      onLibrary={showLibrary}
      onChatsChanged={s.loadChats}
      onLibraryChanged={s.loadLibrary}
      onError={s.setError}
      onSettings={() => {
        setSettingsTab('general');
        setPanel('settings');
      }}
      onTasks={() => inspect('')}
      tasks={s.tasks}
    />
  );
  const navigationControls = (
    <>
      <IconButton
        className="sidebar-toggle"
        label={sidebarCollapsed ? '좌측 패널 펼치기' : '좌측 패널 접기'}
        icon={sidebarCollapsed ? PanelLeftOpen : PanelLeftClose}
        aria-expanded={!sidebarCollapsed}
        aria-controls="workspace-sidebar"
        onClick={() => setSidebarCollapsed((value) => !value)}
      />
      <IconButton
        className="mobile-menu"
        label="탐색 메뉴"
        icon={Menu}
        onClick={() => setPanel('navigation')}
      />
      {(!compact || s.destination !== 'story') && (
        <IconButton
          label="도우미 열기"
          icon={MessageCircle}
          aria-expanded={helperOpen}
          aria-controls="helper-panel"
          onClick={() => {
            setOptionsOpen(false);
            setHelperOpen((value) => !value);
          }}
        />
      )}
    </>
  );
  function renderReadingSettings(onStartFocus: () => void) {
    return (
      <div className="settings-stack">
        <label>
          새 원고의 기본 보기
          <select
            aria-label="새 원고의 기본 보기"
            value={readingLanguage}
            onChange={(event) => setReadingLanguage(event.target.value)}
          >
            <option value="translation">한국어 번역</option>
            <option value="original">원문</option>
          </select>
        </label>
        <small>
          번역이 없으면 원문을 먼저 보여 줘요. 번역 보기를 눌러 번역을 시작하고, 이미 저장된 번역은
          다시 호출하지 않아요.
        </small>
        <label>
          본문 글꼴
          <select
            aria-label="본문 글꼴"
            value={font}
            onChange={(event) => setFont(event.target.value)}
          >
            <option value="sans">기본 고딕</option>
            <option value="serif">명조</option>
          </select>
        </label>
        <label>
          본문 크기
          <input
            aria-label="본문 크기"
            type="range"
            min={16}
            max={22}
            step={1}
            value={fontSize}
            onChange={(event) => setFontSize(Number(event.target.value))}
          />
          <span>{fontSize}px</span>
        </label>
        <button className="secondary" onClick={onStartFocus}>
          집중 읽기 시작
        </button>
      </div>
    );
  }
  return (
    <div
      className={`app-shell ${focus ? 'focus-reading' : ''} ${sidebarCollapsed ? 'sidebar-collapsed' : ''} ${optionsOpen && s.destination === 'story' && s.selected ? 'options-open' : ''} ${helperOpen ? 'helper-open' : ''}`}
    >
      <aside id="workspace-sidebar" className="sidebar" aria-label="탐색">
        {!compact && panel !== 'navigation' && navigation(true)}
      </aside>
      <main className="story-workspace">
        {s.destination === 'story' && (
          <header className="workspace-header">
            {navigationControls}
            <div className="header-title">
              <h1>
                {s.detail?.chat.title || 'Uimori'}
                {compact && sceneCount > 0 && (
                  <ChevronDown size={14} aria-hidden="true" className="header-title-caret" />
                )}
              </h1>
              <small>
                {s.bot?.title
                  ? `${s.bot.title}${s.persona ? ` · 페르소나 ${s.persona.title}` : ''}`
                  : s.selected
                    ? '채팅을 이어가는 중'
                    : '나의 채팅'}
              </small>
              {compact && s.selected && sceneCount > 0 && (
                <button
                  type="button"
                  className="header-title-hit"
                  aria-label="장면 목록 열기"
                  title="장면 목록"
                  onClick={() => setSceneList(true)}
                />
              )}
            </div>
            <div className="header-actions">
              {s.selected && s.destination === 'story' && (
                <>
                  {mainModelChip}
                  {focus && (
                    <button
                      className="icon-button"
                      aria-label="집중 읽기 종료"
                      title="집중 읽기 종료"
                      onClick={() => setFocus(false)}
                    >
                      <Minimize size={19} />
                    </button>
                  )}
                  {!compact && (
                    <button
                      className="icon-button"
                      aria-label="채팅 설정"
                      title="채팅 설정"
                      onClick={() => openChatSettings()}
                    >
                      <SlidersHorizontal size={20} />
                    </button>
                  )}
                  <ActionMenu label="채팅 메뉴" className="chat-menu">
                    {compact && (
                      <>
                        <button
                          type="button"
                          className="secondary"
                          aria-label="채팅 설정"
                          onClick={(event) => {
                            fromChatMenu(event);
                            openChatSettings();
                          }}
                        >
                          <SlidersHorizontal size={18} aria-hidden="true" />
                          채팅 설정
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          aria-label="도우미 열기"
                          aria-expanded={helperOpen}
                          aria-controls="helper-panel"
                          onClick={() => {
                            setOptionsOpen(false);
                            setHelperOpen(true);
                          }}
                        >
                          <MessageCircle size={18} aria-hidden="true" />
                          도우미
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      className="secondary"
                      aria-label="채팅 백업 내보내기"
                      title="모든 분기·원문·자료·이미지·실행 기록을 새 채팅으로 복원할 수 있는 백업을 받아요"
                      onClick={() => {
                        const chatId = s.selected;
                        const title = s.chats.find((chat) => chat.id === chatId)?.title ?? 'chat';
                        void api<unknown>(`/chats/${chatId}/backup`).then(
                          (backup) =>
                            saveDownload(
                              `${title.replace(/[\\/:*?"<>|]/g, '_')}.uimori-chat.json`,
                              backup
                            ),
                          (error: Error) => s.setError(error.message)
                        );
                      }}
                    >
                      <Download size={18} aria-hidden="true" />
                      채팅 백업 내보내기
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      aria-label="채팅 포크"
                      title="현재 전개의 마지막 장면까지 복사해서 새 채팅으로 이어가요"
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
                      여기까지 새 채팅으로 복사
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={(event) => {
                        fromChatMenu(event);
                        setPanel('reading');
                      }}
                    >
                      <Type size={18} aria-hidden="true" />
                      읽기 설정
                    </button>
                    {!focus && (
                      <button type="button" className="secondary" onClick={() => setFocus(true)}>
                        <Maximize size={18} aria-hidden="true" />
                        집중 읽기
                      </button>
                    )}
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
                        계층형 구성
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
                      작업 현황
                    </button>
                    {(s.detail?.branches?.length ?? 0) > 1 && (
                      <button
                        type="button"
                        className="secondary"
                        onClick={(event) => {
                          fromChatMenu(event);
                          setPanel('branches');
                        }}
                      >
                        <History size={18} aria-hidden="true" />
                        보관된 전개
                      </button>
                    )}
                    {s.detail && (
                      <DeleteButton
                        path={`/chats/${encodeURIComponent(s.selected)}`}
                        preparePath={`/chats/${encodeURIComponent(s.selected)}/deletion-impact`}
                        title={s.detail.chat.title}
                        label="채팅 삭제"
                        description="이 채팅의 모든 분기, 원문, 번역, 이미지와 실행 기록을 영구 삭제해요. 실행 중인 작업은 먼저 취소하거나 완료해 주세요."
                        disabled={!!s.active}
                        onError={s.setError}
                        onDeleted={() => s.loadChats()}
                      />
                    )}
                  </ActionMenu>
                </>
              )}
            </div>
          </header>
        )}
        {s.destination === 'library' ? (
          <div className="destination-scroll">
            {libraryTab === 'prompts' ? (
              s.library ? (
                <PromptLibrary
                  listRequest={libraryListRequest}
                  initialPresetId={promptToEdit}
                  onInitialPresetHandled={() => setPromptToEdit(null)}
                  onOpenCurrentPrompts={() => {
                    setSettingsTab('prompts');
                    setPanel('settings');
                  }}
                  headerLeading={navigationControls}
                  library={s.library}
                  reload={s.loadLibrary}
                  onError={s.setError}
                  onDirtyChange={setLibraryDirty}
                />
              ) : (
                workspaceFallback(
                  '프롬프트',
                  navigationControls,
                  <p role="status">
                    {s.libraryError
                      ? '프롬프트 목록을 불러오지 못했어요.'
                      : '프롬프트를 불러오는 중이에요…'}
                  </p>
                )
              )
            ) : (
              <LibraryPanel
                headerLeading={navigationControls}
                library={s.library}
                reload={s.loadLibrary}
                onError={s.setError}
                onStartStory={newStory}
                onUseContent={useContent}
                recentChatByContent={recentChatByContent}
                onContinueChat={select}
                initialTab={libraryTab}
                listRequest={libraryListRequest}
                onTabChange={setLibraryTab}
                onDirtyChange={setLibraryDirty}
              />
            )}
            <DismissibleError message={s.error} onDismiss={() => s.setError('')} />
          </div>
        ) : (
          <>
            <div
              className={`reader-stage ${s.detail?.reader.navigation.length ? 'has-scenes' : ''}`}
            >
              <div
                ref={s.reader}
                className="reader-scrollport"
                data-reader-scrollport
                onScroll={s.savePosition}
              >
                <section className="reader" aria-label="원고">
                  {!s.selected ? (
                    <div className="empty-state">
                      <BookOpen size={32} />
                      <h2>어떤 채팅을 시작할까요?</h2>
                      <p className="muted">서재에서 봇을 고르거나, 원하는 장면으로 시작해요.</p>
                      <button onClick={() => newStory()}>새 채팅</button>
                      <button className="secondary" onClick={() => showLibrary()}>
                        서재 둘러보기
                      </button>
                    </div>
                  ) : !s.detail ? (
                    <p role="status">채팅을 불러오는 중이에요…</p>
                  ) : (
                    <>
                      {s.profileAsset && (
                        <div className="story-context">
                          <img
                            className="profile-asset"
                            data-testid="profile-asset"
                            src={s.profileAsset.url}
                            alt={s.profileAsset.description || s.profileAsset.title}
                          />
                        </div>
                      )}
                      {!s.connected && (
                        <p className="connection-note" role="status">
                          연결을 다시 확인하는 중이에요.
                        </p>
                      )}
                      {!s.sources.length && !s.visibleRuns.length && !s.active && (
                        <div className="first-scene">
                          {s.bot && (
                            <ContentAvatar content={s.bot} className="first-scene-avatar" />
                          )}
                          <h2>첫 장면을 들려주세요.</h2>
                          <p className="muted">
                            배경과 인물, 일어나길 바라는 일을 아래에 적어주세요.
                          </p>
                        </div>
                      )}
                      <ReaderPages
                        detail={s.detail}
                        head={s.branch?.headRevision ?? null}
                        onSelect={s.chooseSource}
                      />
                      {s.conversation.map((entry) => {
                        if (entry.kind === 'source') {
                          const { source, index } = entry;
                          return (
                            <SourceReader
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
                              hasPackages={
                                !!s.detail!.runs.find((run) => run.id === source.runId)?.hasPackages
                              }
                              presentationRefreshKey={s.detail!.reader.cursor}
                              sourceSegments={
                                s.detail!.runs.find((run) => run.id === source.runId)
                                  ?.sourceSegments
                              }
                              key={source.id}
                              source={source}
                              index={index + (s.detail?.reader?.start ?? 0)}
                              request={
                                s.detail!.runs.find((run) => run.id === source.runId)?.request
                              }
                              jobs={s.detail!.jobs.filter(
                                (job) => job.sourceRevision === source.id
                              )}
                              illustrations={(s.detail!.illustrations ?? []).filter(
                                (item) => item.sourceRevision === source.id
                              )}
                              assets={s.detail!.assets ?? []}
                              refresh={() => s.refresh(s.selected)}
                              onError={s.setError}
                              onFork={s.fork}
                              onRetry={
                                s.canReuseRun(source.runId)
                                  ? async () => {
                                      await s.generate(source.runId);
                                    }
                                  : undefined
                              }
                              onEditRequest={
                                s.canReuseRun(source.runId)
                                  ? (text) => s.generate(source.runId, text)
                                  : undefined
                              }
                              onCheckRequest={
                                s.pendingEditedRunId === source.runId
                                  ? () => s.generate()
                                  : undefined
                              }
                              onAskHelper={(sourceId, text) => {
                                setOptionsOpen(false);
                                setHelperOpen(true);
                                if (s.selected && s.branch)
                                  setHelperSelection({
                                    key: crypto.randomUUID(),
                                    sourceId,
                                    sourceHash: source.hash,
                                    text,
                                    scope: {
                                      kind: 'chat',
                                      chatId: s.selected,
                                      branchId: s.branch.id,
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
                                      activities={s.detail!.reader.responseActivity ?? []}
                                      connected={s.connected}
                                      branchId={s.branch?.id}
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
                              disabled={s.reuseBlocked || optionsBusy}
                              editHint="수정한 요청을 현재 설정으로 다시 실행해요."
                              onSubmit={
                                s.canReuseRun(run.id)
                                  ? (text) => s.generate(run.id, text)
                                  : undefined
                              }
                              onConfirm={
                                s.pendingEditedRunId === run.id ? () => s.generate() : undefined
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
                                branchId={s.branch?.id}
                                revision={s.detail!.reader.cursor}
                                refresh={() => s.refresh(s.selected)}
                                onError={s.setError}
                              />
                              {runActive(run.status) && (
                                <div className="turn-skeleton" aria-hidden="true">
                                  <span />
                                  <span />
                                  <span />
                                </div>
                              )}
                              <StreamingResponse
                                taskKind="main"
                                taskId={run.id}
                                taskStatus={run.status}
                              />
                              {runFailed(run.status) && (
                                <RetryFailure
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
                        head={s.branch?.headRevision ?? null}
                        onSelect={s.chooseSource}
                        end
                      />
                      {!!s.detail.profile?.packageAttachments?.length && (
                        <PackageBehaviorPanel
                          chatId={s.selected}
                          branchId={s.branch?.id}
                          refreshKey={s.detail.reader.cursor}
                          onRunRequest={(text, id) => {
                            s.editDraft(text, id);
                            s.input.current?.focus();
                          }}
                          onChange={() => {
                            void s.refresh(s.selected);
                          }}
                        />
                      )}
                    </>
                  )}
                </section>
              </div>
              {s.detail && (
                <SceneNavigator
                  key={s.viewKey}
                  detail={s.detail}
                  reader={s.reader}
                  target={s.readSource}
                  onSelect={s.chooseSource}
                  onLatest={s.chooseLatest}
                  compact={compact}
                  listOpen={sceneList}
                  onListOpenChange={setSceneList}
                />
              )}
            </div>
            {s.selected && (
              <div className="composer-dock">
                {s.pendingProfile && (
                  <div className="error" role="alert">
                    시작 설정 저장이 끝나지 않았어요.
                    <button
                      className="secondary"
                      onClick={() => {
                        void (async () => {
                          try {
                            const chatId = s.selected;
                            await completePendingStoryProfile(chatId);
                            await s.refresh(chatId);
                          } catch (err) {
                            s.setError((err as Error).message);
                          }
                        })();
                      }}
                    >
                      시작 설정 다시 저장
                    </button>
                  </div>
                )}
                <DismissibleError message={s.error} onDismiss={() => s.setError('')} />
                {s.error.includes('전역 모델 설정') && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setSettingsTab('models');
                      setPanel('settings');
                    }}
                  >
                    전역 모델 설정
                  </button>
                )}
                {s.forkOrigin && s.forkOrigin.forkId === s.selected && (
                  <p className="composer-status fork-notice" role="status">
                    <span>「{s.forkOrigin.title}」에서 복사한 새 채팅이에요.</span>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => {
                        const origin = s.forkOrigin!.id;
                        s.dismissForkOrigin();
                        select(origin);
                      }}
                    >
                      원본으로 돌아가기
                    </button>
                    <IconButton
                      label="알림 닫기"
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
                  branchId={s.branch?.id}
                  connected={s.connected}
                  onDetails={() => inspect('')}
                  seenRunIds={seenRuns}
                />
                {!sourceEditing &&
                  !s.pendingRequest &&
                  ((!testMode && !mainAvailable) || !promptAvailable) && (
                    <p className="muted" role="status">
                      {!promptAvailable
                        ? '고정한 작문 프리셋을 사용할 수 없어요. 다시 선택해 주세요.'
                        : pinned?.mainModel
                          ? '고정한 본문 모델을 사용할 수 없어요. 다시 선택해 주세요.'
                          : '사용 가능한 전역 본문 모델을 선택해 주세요.'}{' '}
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
                        {pinned?.mainModel || !promptAvailable ? '채팅 설정' : '전역 모델 설정'}
                      </button>
                    </p>
                  )}
                <ChatComposer
                  hidden={sourceEditing}
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!optionsBusy) void s.generate();
                  }}
                >
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
                    다음 장면 요청
                  </label>
                  <ComposerInput
                    inputRef={s.input}
                    id="request"
                    maxLength={4000}
                    value={s.draft}
                    enterSend={enterSend}
                    onSelect={s.rememberCursor}
                    onChange={(event) => s.editDraft(event.target.value)}
                    onSend={() => {
                      if (!s.active && !optionsBusy) void s.generate();
                    }}
                    placeholder={
                      // A wrapping placeholder would grow the one-row composer on narrow screens.
                      compact
                        ? '다음 장면을 부탁해 보세요…'
                        : `다음 장면을 부탁하거나, 채팅을 이어가세요… · ${enterSend ? 'Enter' : 'Ctrl+Enter'} 보내기`
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
                      {creativePresets.length > 0 && (
                        <label>
                          <span className="sr-only">빠른 옵션 조합</span>
                          <select
                            aria-label="빠른 옵션 조합"
                            value={currentCombination ? refValue(currentCombination) : ''}
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
                            <option value="">옵션 조합 · 현재 선택값</option>
                            {creativePresets.map((item) => (
                              <option value={refValue(item)} key={refValue(item)}>
                                {item.title}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      {hasCreativeOptions && (
                        <button
                          ref={optionsButton}
                          type="button"
                          className="creative-options-button"
                          aria-label="창작 옵션"
                          aria-expanded={optionsOpen}
                          aria-controls="chat-prompt-options"
                          disabled={!s.detail}
                          onClick={() => {
                            setHelperOpen(false);
                            setOptionsOpen((value) => !value);
                          }}
                        >
                          <SlidersHorizontal size={14} />
                          창작 옵션{optionsDirty && ' · 미적용'}
                        </button>
                      )}
                      {s.library && (
                        <ContentPicker
                          library={s.library}
                          role="persona"
                          label="빠른 페르소나"
                          value={s.persona ? refValue(s.persona) : ''}
                          selectedContent={s.persona}
                          allowNone
                          noneLabel={s.attachmentsReady ? '페르소나 없음' : '페르소나 확인 중…'}
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
                      )}
                    </ComposerMore>
                  </div>
                  {s.active ? (
                    <button
                      type="button"
                      className="send-button"
                      aria-label="원문 생성 취소"
                      title="원문 생성 중단"
                      onClick={() => {
                        void api(`/runs/${s.active!.id}/cancel`, {})
                          .then(() => s.refresh(s.selected))
                          .catch((e) => s.setError(e.message));
                      }}
                    >
                      <Square size={18} />
                    </button>
                  ) : (
                    <button
                      className="send-button"
                      aria-label={s.pendingRequest ? '이전 요청 확인' : '원문 생성'}
                      title={
                        s.pendingRequest
                          ? '이전 전송의 수락 확인'
                          : `보내기 · ${enterSend ? 'Enter' : 'Ctrl+Enter'}`
                      }
                      disabled={
                        optionsBusy ||
                        s.submitting.includes(s.viewKey) ||
                        (!s.draft.trim() && !s.pendingRequest) ||
                        !s.detail ||
                        s.pendingProfile ||
                        (((!testMode && !mainAvailable) || !promptAvailable) && !s.pendingRequest)
                      }
                    >
                      <ArrowUp size={21} />
                    </button>
                  )}
                </ChatComposer>
                {sourceEditing && s.active && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      void api(`/runs/${s.active!.id}/cancel`, {})
                        .then(() => s.refresh(s.selected))
                        .catch((e) => s.setError(e.message));
                    }}
                  >
                    원문 생성 취소
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
      <ChatPromptOptions
        chatId={s.selected || undefined}
        branchId={s.branch?.id}
        open={optionsOpen && s.destination === 'story' && !!s.selected}
        workspace={s.promptWorkspace}
        promptRevision={`${s.detail?.profile?.revision ?? 0}:${s.pinnedPromptRevision ?? 0}`}
        library={s.library}
        disabled={
          optionsBusy ||
          s.profileDirty ||
          s.quickBusy ||
          s.submitting.includes(s.viewKey) ||
          !!s.pendingRequest ||
          s.pendingProfile
        }
        onClose={() => {
          setOptionsOpen(false);
          requestAnimationFrame(() => {
            const target = optionsButton.current;
            if (target?.checkVisibility()) target.focus();
            else document.querySelector<HTMLButtonElement>('[aria-label="입력창 더보기"]')?.focus();
          });
        }}
        onDirtyChange={setOptionsDirty}
        onBusyChange={setOptionsBusy}
      />
      <HelperPanel
        enterSend={enterSend}
        modelDescription={helperDescription}
        open={helperOpen}
        selection={helperSelection}
        scope={
          s.destination === 'story' && s.selected && s.branch
            ? { kind: 'chat', chatId: s.selected, branchId: s.branch.id }
            : { kind: 'library', workId: `library:${libraryTab}` }
        }
        onClose={() => setHelperOpen(false)}
        onModelSettings={() => {
          setSettingsTab('models');
          setPanel('settings');
        }}
      />
      <Dialog
        open={!!pendingNavigation}
        title="편집 중인 자료"
        onClose={() => {
          if (!discardingNavigation) setPendingNavigation(null);
        }}
      >
        <p>이동하면 저장하지 않은 편집 내용이 사라져요.</p>
        {navigationDiscardError && (
          <p role="alert" className="error">
            {navigationDiscardError}
          </p>
        )}
        <DraftDiscardActions
          open={!!pendingNavigation}
          disabled={discardingNavigation}
          onContinue={() => setPendingNavigation(null)}
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
          discardLabel="초안 버리고 이동"
        />
      </Dialog>
      <Dialog
        open={panel === 'navigation'}
        title="탐색"
        onClose={() => setPanel('')}
        className="navigation-dialog"
        headerLeading={
          panel === 'navigation' ? (
            <NavigationQuickActions
              chats={s.chats}
              library={s.library}
              onSelect={select}
              onLibrary={showLibrary}
            />
          ) : undefined
        }
      >
        {panel === 'navigation' && navigation(false)}
      </Dialog>
      <Dialog open={panel === 'new'} title="새 채팅" onClose={() => setPanel('')}>
        {s.library && (
          <NewStory
            key={newKey}
            library={s.library}
            initialBot={initialBot}
            initialFolder={initialFolder}
            initialPersona={initialPersona}
            initialModules={initialModules}
            onModelSettings={() => {
              setSettingsTab('models');
              setPanel('settings');
            }}
            onCreated={async (chat) => {
              await s.loadChats();
              select(chat.id);
            }}
          />
        )}
      </Dialog>
      <Dialog
        open={!!moduleToUse}
        title="모듈 사용"
        onClose={() => !s.quickBusy && setModuleToUse(null)}
      >
        {moduleToUse && (
          <>
            <ContentAvatar content={moduleToUse} />
            <p>{moduleToUse.title}을 사용할 채팅을 선택해요.</p>
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
                현재 채팅에 추가 · {s.detail.chat.title}
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
              이 모듈로 새 채팅
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
          initialSection={settingsSection}
          onGlobalSettings={(section) => {
            setSettingsTab(section);
            setPanel('settings');
          }}
        />
      )}
      <Dialog
        scopeKey={`${s.selected}:${s.viewedBranch}`}
        open={panel === 'outline'}
        title="계층형 구성"
        onClose={() => setPanel('')}
        wide
      >
        {panel === 'outline' && (
          <OutlinePanel
            key={`${s.detail?.chat.id}:${s.branch?.id}`}
            state={s}
            onClose={() => setPanel('')}
          />
        )}
      </Dialog>
      <Dialog open={panel === 'branches'} title="보관된 전개" onClose={() => setPanel('')}>
        <BranchesPanel state={s} onClose={() => setPanel('')} />
      </Dialog>
      <Dialog
        scopeKey={s.selected}
        open={panel === 'tasks'}
        title="작업 현황"
        onClose={() => setPanel('')}
        wide
      >
        {panel === 'tasks' && (
          <TasksPanel
            state={s}
            inspectedRun={inspectedRun}
            onInspect={setInspectedRun}
            onClose={() => setPanel('')}
          />
        )}
      </Dialog>
      <Dialog open={panel === 'reading'} title="읽기 설정" onClose={() => setPanel('')}>
        {renderReadingSettings(() => {
          setFocus(true);
          setPanel('');
        })}
      </Dialog>
      {panel === 'settings' && (
        <AppSettingsPanel
          onEditPrompt={(presetId) => {
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
          onClose={() => setPanel('')}
          initialTab={settingsTab}
          state={s}
          theme={theme}
          setTheme={setTheme}
          enterSend={enterSend}
          setEnterSend={setEnterSend}
        />
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <SessionGate>
    <App />
  </SessionGate>
);
