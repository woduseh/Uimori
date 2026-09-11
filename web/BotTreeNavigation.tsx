import { useEffect, useMemo, useRef, useState } from 'react';
import { PanelLeftClose, PanelLeftOpen, Sprout } from 'lucide-react';
import type { Content, Library } from '../core/product.js';
import type { Chat } from '../core/types.js';
import {
  libraryCategory,
  libraryFolderOf,
  type LibraryFolder,
} from '../core/library-organization.js';
import { BotBranch, type Props } from './BotNavigation.js';
import { ActionMenu } from './ActionMenu.js';
import { Dialog } from './Dialog.js';
import { IconButton } from './IconButton.js';
import {
  AddIcon,
  DownIcon,
  ExpandIcon,
  FolderAddIcon,
  FolderIcon,
  LibraryIcon,
  PromptIcon,
  RunningIcon,
  SearchIcon,
  SettingsIcon,
  UpIcon,
  EditIcon,
} from './ui-icons.js';
import { api } from './api.js';
import { useChatActivities } from './useChatActivities.js';
import './bot-tree-navigation.css';

export type { ChatFolder } from '../core/product.js';
type View = { open: Record<string, boolean>; sort: 'manual' | 'recent'; order: string[] };
const storageKey = 'uimori.bot-tree.v1';
function readView(): View {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    return {
      open: value?.open && typeof value.open === 'object' ? value.open : {},
      sort: value?.sort === 'manual' ? 'manual' : 'recent',
      order: Array.isArray(value?.order)
        ? value.order.filter((id: unknown) => typeof id === 'string')
        : [],
    };
  } catch {
    return { open: {}, sort: 'recent', order: [] };
  }
}
/** First row of the sidebar and the drawer: start a chat (from the library's bot tab, where bots
 *  without chats live) or find a chat across every bot. */
export function NavigationQuickActions({
  chats,
  library,
  onSelect,
  onLibrary,
  compact = false,
}: {
  chats: Chat[];
  library: Library | null;
  onSelect: (id: string) => void;
  onLibrary: (tab: 'bot') => void;
  /** The collapsed rail shows the same two actions as icons. */
  compact?: boolean;
}) {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const botTitle = (chat: Chat) =>
    library?.contents.find((bot) => bot.id === chat.botId)?.title ?? '';
  const needle = query.trim().toLocaleLowerCase();
  const matches = chats
    .filter(
      (chat) =>
        !needle ||
        chat.title.toLocaleLowerCase().includes(needle) ||
        botTitle(chat).toLocaleLowerCase().includes(needle)
    )
    .sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
  const openSearch = () => {
    setQuery('');
    setSearching(true);
  };
  return (
    <div className={`navigation-quick-actions${compact ? ' compact' : ''}`}>
      {compact ? (
        <>
          <IconButton label="새 채팅" icon={AddIcon} onClick={() => onLibrary('bot')} />
          <IconButton label="전체 채팅 검색" icon={SearchIcon} onClick={openSearch} />
        </>
      ) : (
        <>
          <button
            type="button"
            className="nav-button"
            aria-label="새 채팅"
            onClick={() => onLibrary('bot')}
          >
            <AddIcon size={20} aria-hidden="true" />
            <span>새 채팅</span>
          </button>
          <button
            type="button"
            className="nav-button"
            aria-label="전체 채팅 검색"
            onClick={openSearch}
          >
            <SearchIcon size={20} aria-hidden="true" />
            <span>채팅 검색</span>
          </button>
        </>
      )}
      <Dialog
        open={searching}
        title="전체 채팅 검색"
        onClose={() => setSearching(false)}
        className="bot-organize-dialog"
      >
        <label className="story-search">
          <SearchIcon size={16} />
          <input
            aria-label="전체 채팅 검색"
            placeholder="채팅 또는 봇 이름"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <nav className="bot-search-results" aria-label="채팅 검색 결과">
          {matches.map((chat) => (
            <button
              key={chat.id}
              type="button"
              data-chat-id={chat.id}
              onClick={() => {
                setSearching(false);
                onSelect(chat.id);
              }}
            >
              <strong>{chat.title}</strong>
              <small>{botTitle(chat)}</small>
            </button>
          ))}
          {!matches.length && <p>검색 결과가 없어요.</p>}
        </nav>
      </Dialog>
    </div>
  );
}
export function BotNavigation(
  props: Props & {
    onLibraryChanged: () => Promise<void>;
    quickActions?: boolean;
    libraryTab?: 'bot' | 'persona' | 'module' | 'prompts';
    /** Collapsed navigation renders an icon rail instead of the full tree. */
    collapsed?: boolean;
    onToggleCollapse?: () => void;
  }
) {
  const {
    library,
    chats,
    selected,
    destination,
    onLibrary,
    onSettings,
    onTasks,
    onError,
    onLibraryChanged,
    onSelect,
    quickActions = true,
  } = props;
  const [view, setView] = useState(readView);
  const activities = useChatActivities();
  const [runningPicker, setRunningPicker] = useState(false);
  const running = Object.entries(activities).filter(([, item]) => item.count > 0);
  const runningTotal = running.reduce((total, [, item]) => total + item.count, 0);
  const chatTitle = (id: string) => chats.find((chat) => chat.id === id)?.title ?? '이름 없는 채팅';
  const openRunning = () => {
    const only = running.length === 1 ? running[0] : undefined;
    if (only) {
      if (only[0] !== selected) onSelect(only[0]);
      onTasks();
    } else setRunningPicker(true);
  };
  const runningDialog = (
    <Dialog
      open={runningPicker}
      title="진행 중인 작업"
      onClose={() => setRunningPicker(false)}
      className="bot-organize-dialog"
    >
      <p className="muted">작업 현황은 채팅별로 열려요. 확인할 채팅을 골라 주세요.</p>
      <nav className="bot-search-results" aria-label="진행 중인 채팅">
        {running.map(([id, item]) => (
          <button
            key={id}
            type="button"
            onClick={() => {
              setRunningPicker(false);
              if (id !== selected) onSelect(id);
              onTasks();
            }}
          >
            <strong>{chatTitle(id)}</strong>
            <small>{item.label}</small>
          </button>
        ))}
        {!running.length && <p>진행 중인 작업이 끝났어요.</p>}
      </nav>
    </Dialog>
  );
  const [editing, setEditing] = useState<LibraryFolder | 'new' | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const latest = useMemo(() => {
    const result = new Map<string, string>();
    for (const chat of chats)
      result.set(
        chat.botId,
        (chat.lastActivityAt ?? '') > (result.get(chat.botId) ?? '')
          ? chat.lastActivityAt!
          : (result.get(chat.botId) ?? '')
      );
    return result;
  }, [chats]);
  const bots = library?.contents.filter((bot) => latest.has(bot.id)) ?? [];
  const folders =
    library?.organization?.folders.filter((folder) => folder.category === 'bot') ?? [];
  const folderOf = (bot: Content) => {
    const id = library ? libraryFolderOf(library, { kind: 'content', id: bot.id }) : null;
    return folders.some((folder) => folder.id === id) ? id : null;
  };
  const owner =
    destination === 'story' ? chats.find((chat) => chat.id === selected)?.botId : undefined;
  const ownerBot = bots.find((bot) => bot.id === owner);
  const ownerFolder = ownerBot ? folderOf(ownerBot) : null;
  useEffect(() => {
    if (selected && owner)
      setView((current) => ({
        ...current,
        open: {
          ...current.open,
          section: true,
          [`bot:${owner}`]: true,
          ...(ownerFolder ? { [`folder:${ownerFolder}`]: true } : {}),
        },
      }));
  }, [selected, owner, ownerFolder]);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(view));
    } catch {
      /* Navigation remains usable without browser storage. */
    }
  }, [view]);
  const toggle = (key: string) =>
    setView((current) => ({ ...current, open: { ...current.open, [key]: !current.open[key] } }));
  const recent = (bot: Content) => latest.get(bot.id) ?? '';
  type Entry = { key: string; title: string; at: string; bot?: Content; folder?: LibraryFolder };
  const sort = (entries: Entry[]) =>
    entries.sort((a, b) =>
      view.sort === 'recent'
        ? b.at.localeCompare(a.at) || a.title.localeCompare(b.title)
        : (view.order.indexOf(a.key) < 0 ? Number.MAX_SAFE_INTEGER : view.order.indexOf(a.key)) -
            (view.order.indexOf(b.key) < 0 ? Number.MAX_SAFE_INTEGER : view.order.indexOf(b.key)) ||
          (a.folder && b.folder ? a.folder.sortPosition - b.folder.sortPosition : 0) ||
          a.title.localeCompare(b.title)
    );
  const botEntries = (folderId: string | null): Entry[] =>
    sort(
      bots
        .filter(
          (bot) =>
            (folders.some((folder) => folder.id === folderOf(bot)) ? folderOf(bot) : null) ===
            folderId
        )
        .map((bot) => ({ key: `bot:${bot.id}`, title: bot.title, at: recent(bot), bot }))
    );
  const roots = sort([
    ...botEntries(null),
    ...folders
      .filter((folder) => bots.some((bot) => folderOf(bot) === folder.id))
      .map((folder) => ({
        key: `folder:${folder.id}`,
        title: folder.title,
        at: bots
          .filter((bot) => folderOf(bot) === folder.id)
          .reduce((latest, bot) => (recent(bot) > latest ? recent(bot) : latest), ''),
        folder,
      })),
  ]);
  function ordering(entry: Entry, siblings: Entry[]) {
    const index = siblings.findIndex((item) => item.key === entry.key);
    function move(offset: number) {
      const ordered = siblings.map((item) => item.key);
      [ordered[index], ordered[index + offset]] = [ordered[index + offset], ordered[index]];
      setView((current) => ({
        ...current,
        order: [...current.order.filter((key) => !ordered.includes(key)), ...ordered],
      }));
    }
    return (
      view.sort === 'manual' && (
        <div className="bot-tree-order">
          <IconButton
            label={`${entry.title} 위로 이동`}
            icon={UpIcon}
            disabled={index === 0}
            onClick={() => move(-1)}
          />
          <IconButton
            label={`${entry.title} 아래로 이동`}
            icon={DownIcon}
            disabled={index === siblings.length - 1}
            onClick={() => move(1)}
          />
        </div>
      )
    );
  }
  async function mutate(path: string, body: object, method = 'POST') {
    if (lock.current || !library?.organization) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await api(path, { expectedRevision: library.organization.revision, ...body }, method);
      await onLibraryChanged();
      setEditing(null);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '폴더를 저장하지 못했어요.';
      setError(message);
      onError(message);
      await onLibraryChanged().catch(() => {});
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function renderBot(entry: Entry, siblings: Entry[]) {
    const bot = entry.bot!;
    return (
      <BotBranch
        key={entry.key}
        {...props}
        activities={activities}
        botId={bot.id}
        expanded={!!view.open[entry.key]}
        onToggle={() => toggle(entry.key)}
        managementActions={
          <>
            {library && libraryCategory(library, bot) === 'bot' ? (
              <label className="bot-tree-move">
                봇 폴더로 이동
                <select
                  aria-label={`${bot.title} 봇 폴더 이동`}
                  value={folderOf(bot) ?? ''}
                  disabled={busy}
                  onChange={(event) =>
                    void mutate('/library/organization/move', {
                      items: [{ kind: 'content', id: bot.id }],
                      category: 'bot',
                      folderId: event.target.value || null,
                    })
                  }
                >
                  <option value="">미분류</option>
                  {folders.map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {folder.title}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <small>서재에서 봇으로 분류하면 폴더로 정리할 수 있어요.</small>
            )}
            <small>서재와 공유하는 폴더예요.</small>
            {ordering(entry, siblings)}
          </>
        }
      />
    );
  }
  const onLibraryTab = props.libraryTab;
  const inLibrary = destination === 'library';
  if (props.collapsed)
    return (
      <div className="bot-navigation bot-tree-navigation sidebar-rail" data-testid="bot-navigation">
        <div className="sidebar-rail-head">
          <IconButton
            className="sidebar-toggle"
            label="좌측 패널 펼치기"
            icon={PanelLeftOpen}
            aria-expanded={false}
            aria-controls="workspace-sidebar"
            onClick={props.onToggleCollapse}
          />
        </div>
        <NavigationQuickActions
          compact
          chats={chats}
          library={library}
          onSelect={onSelect}
          onLibrary={onLibrary}
        />
        <nav className="sidebar-rail-destinations" aria-label="작업 공간">
          <IconButton
            label="서재"
            icon={LibraryIcon}
            aria-current={inLibrary && onLibraryTab !== 'prompts' ? 'page' : undefined}
            className={inLibrary && onLibraryTab !== 'prompts' ? 'selected' : ''}
            onClick={() => onLibrary('bot')}
          />
          <IconButton
            label="프롬프트"
            icon={PromptIcon}
            aria-current={inLibrary && onLibraryTab === 'prompts' ? 'page' : undefined}
            className={inLibrary && onLibraryTab === 'prompts' ? 'selected' : ''}
            onClick={() => onLibrary('prompts')}
          />
        </nav>
        <div className="sidebar-rail-spacer" />
        <nav className="sidebar-app-actions" aria-label="앱 탐색">
          {runningTotal > 0 && (
            <IconButton
              className="nav-progress"
              label={`작업 현황 · 전체 채팅에서 진행 중 ${runningTotal}개`}
              icon={RunningIcon}
              onClick={openRunning}
            />
          )}
          <IconButton label="설정" icon={SettingsIcon} onClick={onSettings} />
        </nav>
        {runningDialog}
      </div>
    );
  return (
    <div className="bot-navigation bot-tree-navigation" data-testid="bot-navigation">
      <div className="brand">
        <span className="brand-name">
          <Sprout size={26} aria-hidden="true" />
          Uimori
        </span>
        {props.onToggleCollapse && (
          <IconButton
            className="sidebar-toggle"
            label="좌측 패널 접기"
            icon={PanelLeftClose}
            aria-expanded
            aria-controls="workspace-sidebar"
            onClick={props.onToggleCollapse}
          />
        )}
      </div>
      {quickActions && (
        <div className="sidebar-quick-actions">
          <NavigationQuickActions
            chats={chats}
            library={library}
            onSelect={onSelect}
            onLibrary={onLibrary}
          />
        </div>
      )}
      <nav className="sidebar-destinations" aria-label="작업 공간">
        <button
          type="button"
          className={`nav-button${props.destination === 'library' && props.libraryTab !== 'prompts' ? ' selected' : ''}`}
          aria-current={
            props.destination === 'library' && props.libraryTab !== 'prompts' ? 'page' : undefined
          }
          onClick={() => onLibrary('bot')}
        >
          <LibraryIcon size={20} aria-hidden="true" />
          서재
        </button>
        <button
          type="button"
          className={`nav-button${props.destination === 'library' && props.libraryTab === 'prompts' ? ' selected' : ''}`}
          aria-current={
            props.destination === 'library' && props.libraryTab === 'prompts' ? 'page' : undefined
          }
          onClick={() => onLibrary('prompts')}
        >
          <PromptIcon size={20} aria-hidden="true" />
          프롬프트
        </button>
      </nav>
      <div className="bot-tree-section-heading">
        <button
          className="bot-folder-toggle"
          aria-label="봇"
          aria-expanded={!!view.open.section}
          onClick={() => toggle('section')}
        >
          봇<ExpandIcon size={14} className={view.open.section ? 'expanded' : ''} />
        </button>
        <ActionMenu label="봇 목록 메뉴" viewport>
          <label>
            봇 정렬 기준
            <select
              aria-label="봇 정렬 기준"
              value={view.sort}
              onChange={(event) =>
                setView((current) => ({
                  ...current,
                  sort: event.target.value === 'manual' ? 'manual' : 'recent',
                }))
              }
            >
              <option value="recent">최근 채팅 활동순</option>
              <option value="manual">수동 정렬</option>
            </select>
          </label>
          <button
            onClick={() => {
              setTitle('');
              setEditing('new');
            }}
          >
            <FolderAddIcon size={16} />새 봇 폴더
          </button>
          <button onClick={() => onLibrary('bot')}>
            <LibraryIcon size={16} />
            서재에서 관리
          </button>
        </ActionMenu>
      </div>
      <div className="bot-navigation-scroll">
        {view.open.section && (
          <nav aria-label="봇별 채팅">
            {roots.map((entry) =>
              entry.bot ? (
                renderBot(entry, roots)
              ) : (
                <section
                  className="bot-tree-folder"
                  key={entry.key}
                  data-bot-folder-id={entry.folder!.id}
                >
                  <div className="bot-tree-folder-heading">
                    <button
                      className="bot-folder-toggle"
                      aria-label={`${entry.title} 봇 폴더`}
                      aria-expanded={!!view.open[entry.key]}
                      onClick={() => toggle(entry.key)}
                    >
                      <ExpandIcon size={12} className={view.open[entry.key] ? 'expanded' : ''} />
                      <FolderIcon size={16} />
                      <span>{entry.title}</span>
                    </button>
                    <ActionMenu label={`${entry.title} 봇 폴더 메뉴`} viewport>
                      <button
                        onClick={() => {
                          setEditing(entry.folder!);
                          setTitle(entry.title);
                        }}
                      >
                        <EditIcon size={18} aria-hidden="true" />
                        폴더 이름 변경
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void mutate(`/library/folders/${entry.folder!.id}`, {}, 'DELETE')
                        }
                      >
                        폴더 해제 · 봇 유지
                      </button>
                      {ordering(entry, roots)}
                    </ActionMenu>
                  </div>
                  {view.open[entry.key] && (
                    <div className="bot-tree-folder-contents">
                      {botEntries(entry.folder!.id).map((botEntry, _index, siblings) =>
                        renderBot(botEntry, siblings)
                      )}
                    </div>
                  )}
                </section>
              )
            )}
            {!bots.length && (
              <p className="bot-navigation-empty">
                {library ? '서재에서 새 채팅을 시작해 보세요.' : '봇을 불러오는 중이에요…'}
              </p>
            )}
          </nav>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
      <Dialog
        open={editing !== null}
        title={editing === 'new' ? '봇 폴더 만들기' : '봇 폴더 이름 변경'}
        onClose={() => !busy && setEditing(null)}
      >
        <form
          className="bot-folder-create"
          onSubmit={(event) => {
            event.preventDefault();
            if (title.trim())
              void mutate(
                editing === 'new' ? '/library/folders' : `/library/folders/${editing?.id}`,
                editing === 'new'
                  ? { category: 'bot', title: title.trim() }
                  : { title: title.trim() },
                editing === 'new' ? 'POST' : 'PATCH'
              );
          }}
        >
          <label>
            봇 폴더 이름
            <input
              aria-label="봇 폴더 이름"
              required
              maxLength={200}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <small>서재에도 반영돼요. 채팅이 있는 봇을 넣으면 사이드바에 표시돼요.</small>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button disabled={busy || !title.trim()}>저장</button>
        </form>
      </Dialog>
      {runningDialog}
      <div className="nav-bottom">
        {runningTotal > 0 && (
          <button
            className="nav-button nav-progress"
            aria-label={`작업 현황 · 전체 채팅에서 진행 중 ${runningTotal}개`}
            onClick={openRunning}
          >
            <RunningIcon size={17} />
            진행 중 {runningTotal}
          </button>
        )}
        <nav className="sidebar-app-actions" aria-label="앱 탐색">
          <button type="button" className="nav-button" onClick={onSettings}>
            <SettingsIcon size={18} />
            설정
          </button>
        </nav>
      </div>
    </div>
  );
}
