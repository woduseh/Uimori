import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { PanelLeftClose, PanelLeftOpen, Sprout } from 'lucide-react';
import type { Content } from '../core/product.js';
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
  ExpandIcon,
  FolderAddIcon,
  FolderIcon,
  LibraryIcon,
  PromptIcon,
  RunningIcon,
  SearchIcon,
  SettingsIcon,
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
/** First row of the sidebar and the drawer: choose a bot in the library or find any chat. */
export function NavigationQuickActions({
  onSearch,
  onLibrary,
  compact = false,
}: {
  onSearch: () => void;
  onLibrary: (tab: 'bot') => void;
  /** The collapsed rail shows the same two actions as icons. */
  compact?: boolean;
}) {
  return (
    <div className={`navigation-quick-actions${compact ? ' compact' : ''}`}>
      {compact ? (
        <>
          <IconButton label="새 채팅" icon={AddIcon} onClick={() => onLibrary('bot')} />
          <IconButton label="전체 채팅 검색" icon={SearchIcon} onClick={onSearch} />
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
            onClick={onSearch}
          >
            <SearchIcon size={20} aria-hidden="true" />
            <span>채팅 검색</span>
          </button>
        </>
      )}
    </div>
  );
}
export function BotNavigation(
  props: Props & {
    onLibraryChanged: () => Promise<void>;
    onSearch: () => void;
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
  const dragEntry = useRef<{ entry: Entry; revision: number } | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);
  const [dropSide, setDropSide] = useState<'before' | 'after' | 'inside'>('inside');
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
  const bots =
    library?.contents.filter(
      (bot) => libraryCategory(library, bot) === 'bot' || latest.has(bot.id)
    ) ?? [];
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
    entries.sort((a, b) => {
      if (a.folder && b.folder) return a.folder.sortPosition - b.folder.sortPosition;
      if (a.folder || b.folder) return a.folder ? -1 : 1;
      return view.sort === 'recent'
        ? b.at.localeCompare(a.at) || a.title.localeCompare(b.title)
        : (view.order.indexOf(a.key) < 0 ? Number.MAX_SAFE_INTEGER : view.order.indexOf(a.key)) -
            (view.order.indexOf(b.key) < 0 ? Number.MAX_SAFE_INTEGER : view.order.indexOf(b.key)) ||
            a.title.localeCompare(b.title);
    });
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
    ...folders.map((folder) => ({
      key: `folder:${folder.id}`,
      title: folder.title,
      at: bots
        .filter((bot) => folderOf(bot) === folder.id)
        .reduce((latest, bot) => (recent(bot) > latest ? recent(bot) : latest), ''),
      folder,
    })),
  ]);
  async function mutate(
    path: string,
    body: object,
    method = 'POST',
    revision = library?.organization?.revision
  ) {
    if (lock.current || !library?.organization) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await api(path, { expectedRevision: revision, ...body }, method);
      await onLibraryChanged();
      setEditing(null);
      return true;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '폴더를 저장하지 못했어요.';
      setError(message);
      onError(message);
      await onLibraryChanged().catch(() => {});
      return false;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function clearDrag() {
    dragEntry.current = null;
    setDragKey(null);
    setDropKey(null);
  }
  function startDrag(event: DragEvent, entry: Entry) {
    if (
      busy ||
      !library?.organization ||
      (event.target as HTMLElement).closest('.bot-row-actions, .bot-branch-actions')
    ) {
      event.preventDefault();
      return;
    }
    event.stopPropagation();
    dragEntry.current = { entry, revision: library.organization.revision };
    setDragKey(entry.key);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-uimori-bot-tree', entry.key);
  }
  function overEntry(event: DragEvent, key: string) {
    if (!dragEntry.current || busy) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    setDropKey(key);
    const box = event.currentTarget.getBoundingClientRect();
    setDropSide(
      key === 'unfiled' || (key.startsWith('folder:') && dragEntry.current.entry.bot)
        ? 'inside'
        : event.clientY < box.top + box.height / 2
          ? 'before'
          : 'after'
    );
    const scroll = event.currentTarget.closest('.bot-navigation-scroll');
    if (scroll) {
      const box = scroll.getBoundingClientRect();
      if (event.clientY < box.top + 36) scroll.scrollTop -= 12;
      if (event.clientY > box.bottom - 36) scroll.scrollTop += 12;
    }
  }
  async function dropEntry(event: DragEvent, target: Entry | null, siblings: Entry[] = roots) {
    const source = dragEntry.current;
    if (!source || busy) return;
    event.preventDefault();
    event.stopPropagation();
    const after =
      event.clientY >=
      event.currentTarget.getBoundingClientRect().top +
        event.currentTarget.getBoundingClientRect().height / 2;
    clearDrag();
    if (source.entry.key === target?.key) return;
    if (source.entry.folder) {
      if (!target?.folder) return;
      const ordered = folders.filter((folder) => folder.id !== source.entry.folder!.id);
      const index = ordered.findIndex((folder) => folder.id === target.folder!.id);
      const beforeFolderId = after ? (ordered[index + 1]?.id ?? null) : target.folder.id;
      if (
        await mutate(
          `/library/folders/${source.entry.folder.id}`,
          { beforeFolderId },
          'PATCH',
          source.revision
        )
      )
        setView((current) => ({
          ...current,
          order: current.order.filter((key) => !key.startsWith('folder:')),
        }));
      return;
    }
    const bot = source.entry.bot!;
    const destinationFolder = target?.folder?.id ?? (target?.bot ? folderOf(target.bot) : null);
    if (folderOf(bot) !== destinationFolder) {
      if (!library || libraryCategory(library, bot) !== 'bot') return;
      if (
        !(await mutate(
          '/library/organization/move',
          {
            items: [{ kind: 'content', id: bot.id }],
            category: 'bot',
            folderId: destinationFolder,
          },
          'POST',
          source.revision
        ))
      )
        return;
    }
    const ordered = (target?.folder ? botEntries(target.folder.id) : siblings)
      .filter((entry) => entry.bot && entry.key !== source.entry.key)
      .map((entry) => entry.key);
    const index = target?.bot ? ordered.indexOf(target.key) + (after ? 1 : 0) : ordered.length;
    ordered.splice(index < 0 ? ordered.length : index, 0, source.entry.key);
    setView((current) => ({
      ...current,
      sort: 'manual',
      order: [...current.order.filter((key) => !ordered.includes(key)), ...ordered],
      open: {
        ...current.open,
        ...(destinationFolder ? { [`folder:${destinationFolder}`]: true } : {}),
      },
    }));
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
        headingDrag={{
          draggable: !busy,
          className: `${dragKey === entry.key ? 'tree-dragging' : ''} ${dropKey === entry.key ? `tree-drop-target tree-drop-${dropSide}` : ''}`,
          onDragStart: (event) => startDrag(event, entry),
          onDragEnd: clearDrag,
          onDragOver: (event) => overEntry(event, entry.key),
          onDrop: (event) => void dropEntry(event, entry, siblings),
        }}
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
        <NavigationQuickActions compact onSearch={props.onSearch} onLibrary={onLibrary} />
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
          <NavigationQuickActions onSearch={props.onSearch} onLibrary={onLibrary} />
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
      <div
        className={`bot-tree-section-heading ${dropKey === 'unfiled' ? 'tree-drop-target' : ''}`}
        onDragOver={(event) => overEntry(event, 'unfiled')}
        onDrop={(event) => void dropEntry(event, null)}
      >
        <button
          className="bot-folder-toggle"
          aria-label="봇"
          aria-expanded={!!view.open.section}
          onClick={() => toggle('section')}
        >
          봇<ExpandIcon size={14} className={view.open.section ? 'expanded' : ''} />
        </button>
        <div className="bot-row-actions">
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
      </div>
      <div className="bot-navigation-scroll">
        {view.open.section && (
          <nav
            aria-label="봇별 채팅"
            onKeyDown={(event) => {
              if (event.key === 'Escape') clearDrag();
            }}
          >
            {roots.map((entry) =>
              entry.bot ? (
                renderBot(entry, roots)
              ) : (
                <section
                  className="bot-tree-folder"
                  key={entry.key}
                  data-bot-folder-id={entry.folder!.id}
                >
                  <div
                    className={`bot-tree-folder-heading ${dragKey === entry.key ? 'tree-dragging' : ''} ${dropKey === entry.key ? `tree-drop-target tree-drop-${dropSide}` : ''}`}
                    draggable={!busy}
                    onDragStart={(event) => startDrag(event, entry)}
                    onDragEnd={clearDrag}
                    onDragOver={(event) => overEntry(event, entry.key)}
                    onDrop={(event) => void dropEntry(event, entry)}
                  >
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
                    <div className="bot-row-actions">
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
                      </ActionMenu>
                    </div>
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
            {dragKey?.startsWith('bot:') && (
              <div
                className={`bot-tree-unfiled-drop ${dropKey === 'unfiled' ? 'tree-drop-target' : ''}`}
                onDragOver={(event) => overEntry(event, 'unfiled')}
                onDrop={(event) => void dropEntry(event, null)}
              >
                미분류로 이동
              </div>
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
