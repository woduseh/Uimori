import { t, useI18n, translateMessage, formatNumber, message as retainedMessage } from './i18n.js';
import { uiMessage, legacyUiMessage, type UiMessage } from './ui-message.js';
import { LoadingState } from './LoadingState.js';
import { memo, useEffect, useId, useMemo, useRef, useState, type DragEvent } from 'react';
import { Inbox, MessageCircle, PanelLeftClose, PanelLeftOpen, Sparkles } from 'lucide-react';
import type { Content } from '../core/product.js';
import {
  libraryCategory,
  libraryFolderOf,
  type LibraryFolder,
} from '../core/library-organization.js';
import { BotBranch, type Props } from './BotNavigation.js';
import { ActionMenu } from './ActionMenu.js';
import { Dialog } from './Dialog.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { IconButton } from './IconButton.js';
import {
  AddIcon,
  ExpandIcon,
  FolderAddIcon,
  LibraryIcon,
  PromptIcon,
  RunningIcon,
  SearchIcon,
  SettingsIcon,
  EditIcon,
  ImagesIcon,
} from './ui-icons.js';
import { libraryEndpoints } from '#contracts';
import { callEndpoint } from './api.js';
import { type LibraryWriteInput, type LibraryWrite } from './LibraryFolders.js';
import { chatActivitySummaries } from './chat-activity-summaries.js';
import { useActivityFeed } from './useActivityFeed.js';
import { ActivityNavigation } from './ActivityNavigation.js';
import { NavigationModeTabs } from './NavigationModeTabs.js';
import { PinnedChats } from './PinnedChats.js';
import { LibraryFolderCover, LibraryFolderCoverDialog } from './LibraryFolderCover.js';
import { contentPortraitUrl } from './content-portrait.js';
import './bot-tree-navigation.css';
import { readOptionalJson, writeOptionalStorage } from './optional-storage.js';
import { storageKeys } from './storage-keys.js';

export type { ChatFolder } from '../core/product.js';
type View = {
  open: Record<string, boolean>;
  sort: 'manual' | 'recent';
  order: string[];
  mode: 'bots' | 'activity';
};
const storageKey = storageKeys.botTree;
function readView(): View {
  const value = readOptionalJson('local', storageKey, null) as Partial<View> | null;
  return {
    open: value?.open && typeof value.open === 'object' ? value.open : {},
    mode: value?.mode === 'activity' ? 'activity' : 'bots',
    sort: value?.sort === 'manual' ? 'manual' : 'recent',
    order: Array.isArray(value?.order)
      ? value.order.filter((id: unknown) => typeof id === 'string')
      : [],
  };
}
export function NavigationQuickActions({
  onSearch,
  onNewChat,
  onNewHelper,
  helperWorkspace = false,
}: {
  onSearch: () => void;
  onNewChat: () => void;
  onNewHelper?: () => void;
  helperWorkspace?: boolean;
}) {
  useI18n();
  const newLabel = t(helperWorkspace ? 'helpers.m173' : 'transfer.m246');
  const searchLabel = t(helperWorkspace ? 'helpers.searchSessions' : 'transfer.m276');
  const onNew = helperWorkspace ? onNewHelper : () => onNewChat();
  return (
    <div className="navigation-quick-actions">
      <IconButton label={newLabel} icon={AddIcon} onClick={onNew} />
      <IconButton label={searchLabel} icon={SearchIcon} onClick={onSearch} />
    </div>
  );
}
export const BotNavigation = memo(function BotNavigation(
  props: Props & {
    onLibraryChanged: () => Promise<void>;
    libraryError?: UiMessage | null;
    onSearch: () => void;
    onNewChat: () => void;
    onNewHelper?: () => void;
    onHelperActivity?: () => void;
    quickActions?: boolean;
    libraryTab?: 'bot' | 'persona' | 'module' | 'prompts';
    collapsed?: boolean;
    onToggleCollapse?: () => void;
    helperOpen?: boolean;
    helperExpanded?: boolean;
    onToggleHelper?: () => void;
    onChatWorkspace?: () => void;
    helperNavigationRef?: (node: HTMLDivElement | null) => void;
  }
) {
  useI18n();
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
  const modePanelId = useId();
  const activityFeed = useActivityFeed();
  const activities = chatActivitySummaries(activityFeed.feed.running);
  const unreadChats = new Set(activityFeed.feed.items.map((item) => item.chatId)).size;
  const setMode = (mode: View['mode']) => setView((current) => ({ ...current, mode }));
  const [runningPicker, setRunningPicker] = useState(false);
  const running = Object.entries(activities).filter(([, item]) => item.count > 0);
  const runningTotal = running.reduce((total, [, item]) => total + item.count, 0);
  const chatTitle = (id: string) =>
    chats.find((chat) => chat.id === id)?.title ?? t('transfer.m277');
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
      title={t('transfer.taskChatPickerTitle')}
      onClose={() => setRunningPicker(false)}
      className="bot-organize-dialog"
    >
      <nav className="bot-search-results" aria-label={t('transfer.m280')}>
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
        {!running.length && <p>{t('transfer.m281')}</p>}
      </nav>
    </Dialog>
  );
  const [editing, setEditing] = useState<LibraryFolder | 'new' | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [coverFolderId, setCoverFolderId] = useState<string | null>(null);
  const [removingFolder, setRemovingFolder] = useState<LibraryFolder | null>(null);
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
    writeOptionalStorage('local', storageKey, JSON.stringify(view));
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
  const folderPortraits = (folderId: string) =>
    bots
      .filter((bot) => folderOf(bot) === folderId)
      .map((bot) => contentPortraitUrl(bot))
      .filter(Boolean);
  const coverFolder = folders.find((folder) => folder.id === coverFolderId);
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
  async function mutate<E extends LibraryWrite>(
    endpoint: E,
    input: LibraryWriteInput<E>,
    revision = library?.organization?.revision
  ) {
    if (lock.current || !library?.organization) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await (callEndpoint as (endpoint: LibraryWrite, input: object) => Promise<unknown>)(
        endpoint,
        { ...input, expectedRevision: revision }
      );
      await onLibraryChanged();
      setEditing(null);
      return true;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : retainedMessage('transfer.m282');
      setError(message);
      onError(legacyUiMessage(message));
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
          libraryEndpoints.updateFolder,
          { id: source.entry.folder.id, beforeFolderId },
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
          libraryEndpoints.moveItems,
          {
            items: [{ kind: 'content', id: bot.id }],
            category: 'bot',
            folderId: destinationFolder,
          },
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
  const inLibrary = destination === 'library' && !props.helperExpanded;
  const inChat = destination === 'story' && !props.helperExpanded;
  const libraryCurrent = inLibrary && onLibraryTab !== 'prompts';
  const promptsCurrent = inLibrary && onLibraryTab === 'prompts';
  const helperRunning = activityFeed.feed.helpers?.some(
    (task) => task.status === 'running' || task.status === 'queued'
  );
  const helperIcon = (
    <span className="workspace-helper-icon">
      <Sparkles size={20} aria-hidden="true" />
      {helperRunning && <span className="workspace-running-dot" />}
    </span>
  );
  const chatDestination = props.collapsed ? (
    <IconButton
      label={t('workspace.chat')}
      icon={MessageCircle}
      aria-current={inChat ? 'page' : undefined}
      className={inChat ? 'selected' : ''}
      onClick={() => {
        setMode('bots');
        props.onChatWorkspace?.();
      }}
    />
  ) : (
    <button
      type="button"
      className={`nav-button${inChat ? ' selected' : ''}`}
      aria-current={inChat ? 'page' : undefined}
      onClick={props.onChatWorkspace}
    >
      <MessageCircle size={20} aria-hidden="true" />
      {t('workspace.chat')}
    </button>
  );
  const helperDestination =
    props.onToggleHelper &&
    (props.collapsed ? (
      <IconButton
        label={helperRunning ? `${t('main.m062')}, ${t('helpers.m113')}` : t('main.m062')}
        icon={Sparkles}
        aria-current={props.helperExpanded ? 'page' : undefined}
        className={`${props.helperExpanded ? 'selected' : ''}${helperRunning ? ' helper-running' : ''}`}
        onClick={props.onToggleHelper}
      />
    ) : (
      <button
        type="button"
        className={`nav-button${props.helperExpanded ? ' selected' : ''}`}
        aria-label={helperRunning ? `${t('main.m062')}, ${t('helpers.m113')}` : undefined}
        aria-current={props.helperExpanded ? 'page' : undefined}
        onClick={props.onToggleHelper}
      >
        {helperIcon}
        {t('main.m062')}
      </button>
    ));
  if (props.collapsed)
    return (
      <div className="bot-navigation bot-tree-navigation sidebar-rail" data-testid="bot-navigation">
        <div className="sidebar-rail-head">
          <IconButton
            className="sidebar-toggle"
            label={t('transfer.m283')}
            icon={PanelLeftOpen}
            aria-expanded={false}
            aria-controls="workspace-sidebar"
            onClick={props.onToggleCollapse}
          />
        </div>
        <nav className="sidebar-rail-workspaces" aria-label={t('transfer.m284')}>
          {chatDestination}
          {helperDestination}
        </nav>
        <NavigationQuickActions
          onSearch={props.onSearch}
          onNewChat={props.onNewChat}
          helperWorkspace={props.helperExpanded}
          onNewHelper={props.onNewHelper}
        />
        <IconButton
          label={
            props.helperExpanded
              ? t('helperNavigation.activity')
              : t('transfer.d024', { v0: unreadChats })
          }
          icon={Inbox}
          className={!props.helperExpanded && unreadChats > 0 ? 'activity-unread' : undefined}
          onClick={() => {
            if (props.helperExpanded) props.onHelperActivity?.();
            else {
              props.onChatWorkspace?.();
              setMode('activity');
            }
            props.onToggleCollapse?.();
          }}
        />
        <div className="sidebar-rail-spacer" />
        <nav className="sidebar-app-actions" aria-label={t('transfer.m288')}>
          {runningTotal > 0 && (
            <IconButton
              className="nav-progress"
              label={t('transfer.d025', { v0: runningTotal })}
              icon={RunningIcon}
              onClick={openRunning}
            />
          )}
          <IconButton
            label={t('transfer.m285')}
            icon={LibraryIcon}
            aria-current={libraryCurrent ? 'page' : undefined}
            onClick={() => onLibrary('bot')}
          />
          <IconButton
            label={t('transfer.m286')}
            icon={PromptIcon}
            aria-current={promptsCurrent ? 'page' : undefined}
            onClick={() => onLibrary('prompts')}
          />
          <IconButton label={t('transfer.m289')} icon={SettingsIcon} onClick={onSettings} />
        </nav>
        {runningDialog}
      </div>
    );
  return (
    <div className="bot-navigation bot-tree-navigation" data-testid="bot-navigation">
      <div className="brand">
        <span className="brand-name">
          <img src="/icons/halo-mark.svg" width={26} height={26} alt="" aria-hidden="true" />
          Uimori
        </span>
        <div className="sidebar-header-actions">
          {quickActions && (
            <NavigationQuickActions
              onSearch={props.onSearch}
              onNewChat={props.onNewChat}
              helperWorkspace={props.helperExpanded}
              onNewHelper={props.onNewHelper}
            />
          )}
          {props.onToggleCollapse && (
            <IconButton
              className="sidebar-toggle"
              label={t('transfer.m290')}
              icon={PanelLeftClose}
              aria-expanded
              aria-controls="workspace-sidebar"
              onClick={props.onToggleCollapse}
            />
          )}
        </div>
      </div>
      <nav className="sidebar-workspaces" aria-label={t('transfer.m284')}>
        {chatDestination}
        {helperDestination}
      </nav>
      {props.helperExpanded ? (
        <div ref={props.helperNavigationRef} className="helper-navigation-host" />
      ) : (
        <>
          <NavigationModeTabs
            label={t('transfer.m291')}
            panelId={modePanelId}
            active={view.mode}
            onSelect={setMode}
            headerProps={{
              className: dropKey === 'unfiled' ? 'tree-drop-target' : '',
              onDragOver: (event) => overEntry(event, 'unfiled'),
              onDrop: (event) => void dropEntry(event, null),
            }}
            tabs={[
              { value: 'bots', label: t('transfer.m005') },
              {
                value: 'activity',
                accessibleName: t('transfer.d024', { v0: unreadChats }),
                label: (
                  <>
                    {t('transfer.m292')}
                    {unreadChats > 0 && (
                      <span className="activity-mode-count">{formatNumber(unreadChats)}</span>
                    )}
                  </>
                ),
              },
            ]}
            actions={
              <div className="bot-row-actions">
                {view.mode === 'bots' && (
                  <ActionMenu label={t('transfer.m293')} viewport>
                    <div className="action-menu-group">
                      <label>
                        {t('transfer.m294')}
                        <select
                          aria-label={t('transfer.m294')}
                          value={view.sort}
                          onChange={(event) =>
                            setView((current) => ({
                              ...current,
                              sort: event.target.value === 'manual' ? 'manual' : 'recent',
                            }))
                          }
                        >
                          <option value="recent">{t('transfer.m295')}</option>
                          <option value="manual">{t('transfer.m296')}</option>
                        </select>
                      </label>
                    </div>
                    <div className="action-menu-group">
                      <button
                        onClick={() => {
                          setTitle('');
                          setEditing('new');
                        }}
                      >
                        <FolderAddIcon size={16} />
                        {t('transfer.m297')}
                      </button>
                      <button onClick={() => onLibrary('bot')}>
                        <LibraryIcon size={16} />
                        {t('transfer.m250')}
                      </button>
                    </div>
                  </ActionMenu>
                )}
              </div>
            }
          />
          <div
            className="bot-navigation-scroll"
            id={modePanelId}
            role="tabpanel"
            aria-labelledby={`${modePanelId}-${view.mode}`}
          >
            {view.mode === 'activity' && (
              <ActivityNavigation
                chats={chats}
                library={library}
                selected={selected}
                feed={activityFeed.feed}
                error={translateMessage(activityFeed.error)}
                onSelect={onSelect}
                onCopyChat={props.onCopyChat}
                copyingChats={props.copyingChats}
                onChatsChanged={props.onChatsChanged}
                onError={props.onError}
                onAcknowledge={(items) => void activityFeed.acknowledge(items)}
                onInspect={activityFeed.inspect}
                onRetry={() => void activityFeed.refresh()}
              />
            )}
            {view.mode === 'bots' && (
              <PinnedChats
                chats={chats}
                library={library}
                selected={destination === 'story' ? selected : ''}
                onSelect={onSelect}
                onCopyChat={props.onCopyChat}
                copyingChats={props.copyingChats}
                onChatsChanged={props.onChatsChanged}
                onError={onError}
              />
            )}
            {view.mode === 'bots' && (
              <nav
                aria-label={t('transfer.m298')}
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
                          aria-label={t('transfer.d026', { v0: entry.title })}
                          aria-expanded={!!view.open[entry.key]}
                          onClick={() => toggle(entry.key)}
                        >
                          <ExpandIcon
                            size={12}
                            className={view.open[entry.key] ? 'expanded' : ''}
                          />
                          <LibraryFolderCover
                            coverImageHash={entry.folder!.coverImageHash}
                            portraits={folderPortraits(entry.folder!.id)}
                            iconSize={16}
                          />
                          <span>{entry.title}</span>
                        </button>
                        <div className="bot-row-actions">
                          <ActionMenu label={t('transfer.d027', { v0: entry.title })} viewport>
                            <div className="action-menu-group">
                              <button
                                onClick={() => {
                                  setEditing(entry.folder!);
                                  setTitle(entry.title);
                                }}
                              >
                                <EditIcon size={18} aria-hidden="true" />
                                {t('transfer.m299')}
                              </button>
                              <button
                                disabled={busy}
                                onClick={() => setCoverFolderId(entry.folder!.id)}
                              >
                                <ImagesIcon size={18} aria-hidden="true" />
                                {t('library.changeCover')}
                              </button>
                            </div>
                            <div className="action-menu-group">
                              <button
                                className="danger"
                                disabled={busy}
                                onClick={() => setRemovingFolder(entry.folder!)}
                              >
                                {t('transfer.m300')}
                              </button>
                            </div>
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
                    {t('transfer.m301')}
                  </div>
                )}
                {!bots.length &&
                  (library ? (
                    <p className="bot-navigation-empty">{t('transfer.m302')}</p>
                  ) : (
                    <LoadingState
                      presentation="inline"
                      loading={!props.libraryError}
                      error={props.libraryError}
                      label={uiMessage('transfer.m303')}
                      onRetry={() => void onLibraryChanged().catch(() => {})}
                    />
                  ))}
              </nav>
            )}
            {view.mode === 'bots' && error && (
              <p className="error" role="alert">
                {translateMessage(error)}
              </p>
            )}
          </div>
        </>
      )}
      <ConfirmDialog
        open={removingFolder !== null}
        title={t('transfer.deleteFolderTitle', { name: removingFolder?.title ?? '' })}
        body={t('transfer.deleteBotFolderMessage')}
        action={t('transfer.m300')}
        busy={busy}
        onCancel={() => setRemovingFolder(null)}
        onConfirm={() => {
          const folder = removingFolder!;
          setRemovingFolder(null);
          void mutate(libraryEndpoints.deleteFolder, { id: folder.id });
        }}
      />
      <LibraryFolderCoverDialog
        folder={coverFolder}
        portraits={coverFolder ? folderPortraits(coverFolder.id) : undefined}
        busy={busy}
        onApply={async (coverImageHash) =>
          (await mutate(libraryEndpoints.updateFolder, { id: coverFolder!.id, coverImageHash })) ===
          true
        }
        onClose={() => setCoverFolderId(null)}
      />
      <Dialog
        open={editing !== null}
        title={editing === 'new' ? t('transfer.m304') : t('transfer.m305')}
        onClose={() => !busy && setEditing(null)}
      >
        <form
          className="bot-folder-create"
          onSubmit={(event) => {
            event.preventDefault();
            if (!editing || !title.trim()) return;
            void (editing === 'new'
              ? mutate(libraryEndpoints.createFolder, { category: 'bot', title: title.trim() })
              : mutate(libraryEndpoints.updateFolder, { id: editing.id, title: title.trim() }));
          }}
        >
          <label>
            {t('transfer.m306')}
            <input
              aria-label={t('transfer.m306')}
              required
              maxLength={200}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          {error && (
            <p className="error" role="alert">
              {translateMessage(error)}
            </p>
          )}
          <button disabled={busy || !title.trim()}>{t('transfer.m308')}</button>
        </form>
      </Dialog>
      {runningDialog}
      <div className="nav-bottom">
        {runningTotal > 0 && (
          <button
            className="nav-button nav-progress"
            aria-label={t('transfer.d025', { v0: runningTotal })}
            onClick={openRunning}
          >
            <RunningIcon size={17} />
            {t('transfer.runningCount', { count: runningTotal })}
          </button>
        )}
        <nav className="sidebar-footer" aria-label={t('transfer.m288')}>
          <button
            type="button"
            className={`nav-button${libraryCurrent ? ' selected' : ''}`}
            aria-current={libraryCurrent ? 'page' : undefined}
            onClick={() => onLibrary('bot')}
          >
            <LibraryIcon size={20} aria-hidden="true" />
            <span>{t('transfer.m285')}</span>
          </button>
          <button
            type="button"
            className={`nav-button${promptsCurrent ? ' selected' : ''}`}
            aria-current={promptsCurrent ? 'page' : undefined}
            onClick={() => onLibrary('prompts')}
          >
            <PromptIcon size={20} aria-hidden="true" />
            <span>{t('transfer.m286')}</span>
          </button>
          <IconButton
            className="sidebar-settings"
            label={t('transfer.m289')}
            icon={SettingsIcon}
            onClick={onSettings}
          />
        </nav>
      </div>
    </div>
  );
});
