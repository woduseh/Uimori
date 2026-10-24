import { t, useI18n, translateMessage, message as retainedMessage } from './i18n.js';
import { LoadingState } from './LoadingState.js';
import type { ReaderTarget } from '../core/reader-target.js';
import { ManuscriptSearchPanel } from './ManuscriptSearch.js';
import { Dialog } from './Dialog.js';
import { DraftDiscardActions } from './DraftDiscardActions.js';
import { NoticeBanner } from './NoticeBanner.js';
import { ActionMenu } from './ActionMenu.js';
import type { chatActivitySummaries } from './chat-activity-summaries.js';
import type { DragEvent, MouseEvent, HTMLAttributes } from 'react';
import { DeleteButton } from './DeleteButton.js';
import { IconButton } from './IconButton.js';
import { SaveButton } from './SaveButton.js';
import { useEffect, useRef, useState } from 'react';
import {
  AddIcon,
  EditIcon,
  ExpandIcon,
  FolderAddIcon,
  FolderIcon,
  CloseIcon,
  LibraryIcon,
  MoreIcon,
  RunningIcon,
  SearchIcon,
} from './ui-icons.js';
import type { Content, Library } from '../core/product.js';
import type { Chat } from '../core/types.js';
import type { ChatFolder } from '../core/product.js';
import { api } from './api.js';
import { ContentAvatar } from './ContentAvatar.js';
import { ContentPicker } from './ContentPicker.js';
import { Copy, LoaderCircle } from 'lucide-react';
import { BotDefaultPersona } from './BotDefaultPersona.js';
import './bot-navigation.css';

export type { ChatFolder } from '../core/product.js';
type LibraryDestination = 'bot' | 'persona' | 'module' | 'prompts';
export type Props = {
  library: Library | null;
  chats: Chat[];
  selected: string;
  destination: 'story' | 'library';
  onSelect: (id: string, target?: ReaderTarget) => void;
  onNew: (bot: Content, folder?: ChatFolder) => void;
  onConfigureNew?: (bot: Content, folder?: ChatFolder) => void;
  onImportChat?: (bot: Content) => void;
  onLibrary: (tab: LibraryDestination) => void;
  onChatsChanged: () => Promise<void>;
  onCopyChat?: (chatId: string) => void;
  copyingChats?: string[];
  onError: (message: string) => void;
  onSettings: () => void;
  onTasks: () => void;
  onOpenHelperTask?: (target: import('../core/activity-feed.js').HelperRecentTask) => void;
  tasks: number;
};
const reference = (value: { id: string; revision: number }) => `${value.id}@${value.revision}`;
/** A menu item that opens a dialog closes its ⋯ and refocuses it first, so the dialog's focus
 *  restore lands on the still-visible summary instead of a hidden item. */
function openFromMenu(event: MouseEvent<HTMLButtonElement>, run: () => void) {
  const menu = event.currentTarget.closest('details');
  if (menu) {
    menu.open = false;
    menu.querySelector('summary')?.focus();
  }
  run();
}

export function BotBranch(
  props: Props & {
    botId: string;
    expanded: boolean;
    onToggle: () => void;
    headingDrag?: HTMLAttributes<HTMLDivElement>;
    activities: ReturnType<typeof chatActivitySummaries>;
  }
) {
  useI18n();
  const {
    library,
    chats,
    selected,
    destination,
    onSelect,
    onNew,
    onLibrary,
    onChatsChanged,
    onError,
    tasks,
    botId,
    expanded,
    onToggle,
    headingDrag,
    activities,
  } = props;
  const [searching, setSearching] = useState(false);
  const [editingDefaults, setEditingDefaults] = useState(false);
  const [folders, setFolders] = useState<ChatFolder[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState<Record<string, number>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      const value: unknown = JSON.parse(
        localStorage.getItem(`uimori.chat-folders.${botId}`) ?? '{}'
      );
      return value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).filter(([, flag]) => typeof flag === 'boolean'))
        : {};
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(`uimori.chat-folders.${botId}`, JSON.stringify(collapsed));
    } catch {
      /* Optional navigation storage. */
    }
  }, [botId, collapsed]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    folderId: string | null;
    beforeId: string | null;
  } | null>(null);
  const expandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expandKey = useRef<string | null>(null);
  const dragChat = useRef<Chat | null>(null);
  useEffect(
    () => () => {
      if (expandTimer.current) clearTimeout(expandTimer.current);
    },
    []
  );

  const currentBot = useRef(botId);
  currentBot.current = botId;
  const epoch = useRef(0);
  const operation = useRef(false);
  const selectedChatFolder = chats.find(
    (chat) => chat.id === selected && chat.botId === botId
  )?.folderId;
  useEffect(() => {
    if (selected && destination === 'story' && selectedChatFolder)
      setCollapsed((value) => ({ ...value, [`${botId}:${selectedChatFolder}`]: false }));
  }, [selected, selectedChatFolder, destination, botId]);
  const bot = library?.contents.find((content) => content.id === botId);
  const scoped = chats
    .filter((chat) => chat.botId === botId)
    .sort((a, b) => (a.sortPosition ?? 0) - (b.sortPosition ?? 0));
  const visible = scoped;
  const shouldLoad = expanded || searching || creating;
  const [requested, setRequested] = useState(false);
  useEffect(() => {
    if (shouldLoad) setRequested(true);
  }, [shouldLoad]);
  useEffect(() => {
    if (!requested) return;
    const version = ++epoch.current;
    setFolders([]);
    setSettingsId(null);
    setMenuId(null);
    setDragId(null);
    dragChat.current = null;
    setDropTarget(null);
    if (expandTimer.current) clearTimeout(expandTimer.current);
    expandKey.current = null;
    setNewTitle('');
    setError('');
    if (!botId) return;
    let alive = true;
    setLoading(true);
    void api<ChatFolder[]>(`/bots/${encodeURIComponent(botId)}/folders`)
      .then((value) => {
        if (alive && epoch.current === version) setFolders(value);
      })
      .catch((reason) => {
        if (alive && epoch.current === version) setError(reason.message);
      })
      .finally(() => {
        if (alive && epoch.current === version) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [botId, requested]);
  async function perform(action: () => Promise<unknown>) {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError('');
    const owner = botId;
    const version = epoch.current;
    try {
      await action();
      await onChatsChanged();
      if (owner === currentBot.current && version === epoch.current) {
        const value = await api<ChatFolder[]>(`/bots/${encodeURIComponent(owner)}/folders`);
        if (owner === currentBot.current && version === epoch.current) setFolders(value);
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : retainedMessage('transfer.m237');
      onError(message);
      if (owner === currentBot.current) setError(message);
      // Refresh revisions after a conflict, retaining the user's editable form values.
      try {
        const value = await api<ChatFolder[]>(`/bots/${encodeURIComponent(owner)}/folders`);
        if (owner === currentBot.current && version === epoch.current) setFolders(value);
        await onChatsChanged();
      } catch {
        /* The original error remains visible. */
      }
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }
  async function start(folder?: ChatFolder, configure = false) {
    if (!bot || operation.current) return;
    operation.current = true;
    setBusy(true);
    const owner = bot.id;
    const version = epoch.current;
    try {
      const full = await api<Content>(`/content/${encodeURIComponent(bot.id)}`);
      if (owner === currentBot.current && version === epoch.current) {
        if (configure) props.onConfigureNew?.(full, folder);
        else onNew(full, folder);
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : retainedMessage('transfer.m238');
      setError(message);
      onError(message);
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }
  function clearDrag() {
    setDragId(null);
    dragChat.current = null;
    setDropTarget(null);
    if (expandTimer.current) clearTimeout(expandTimer.current);
    expandTimer.current = null;
    expandKey.current = null;
  }
  function moveChat(chat: Chat, folderId: string | null, beforeId: string | null = null) {
    if (beforeId === chat.id) return;
    void perform(() =>
      api(
        `/chats/${encodeURIComponent(chat.id)}/organization`,
        {
          expectedRevision: chat.organizationRevision,
          folderId,
          beforeChatId: beforeId,
        },
        'PATCH'
      )
    );
  }
  function over(event: DragEvent, folderId: string | null, beforeId: string | null) {
    if (!dragChat.current || busy || dragChat.current.botId !== botId) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    setDropTarget({ folderId, beforeId });
    const key = `${botId}:${folderId ?? ''}`;
    if (expandKey.current !== key) {
      if (expandTimer.current) clearTimeout(expandTimer.current);
      expandKey.current = key;
      if (collapsed[key])
        expandTimer.current = setTimeout(
          () => setCollapsed((value) => ({ ...value, [key]: false })),
          650
        );
    }
    const scroll = event.currentTarget.closest('.bot-navigation-scroll');
    if (scroll) {
      const bounds = scroll.getBoundingClientRect();
      if (event.clientY < bounds.top + 36) scroll.scrollTop -= 12;
      if (event.clientY > bounds.bottom - 36) scroll.scrollTop += 12;
    }
  }
  function drop(event: DragEvent, folderId: string | null, beforeId: string | null) {
    event.preventDefault();
    event.stopPropagation();
    const chat = dragChat.current;
    clearDrag();
    if (chat && chat.botId === botId && !busy) moveChat(chat, folderId, beforeId);
  }
  function activity(chat: Chat) {
    return (
      activities[chat.id] ??
      (chat.id === selected && tasks > 0
        ? { count: tasks, label: t('transfer.d012', { v0: tasks }) }
        : undefined)
    );
  }
  function status(label?: string) {
    return label ? (
      <span className="bot-chat-status" tabIndex={0} role="img" aria-label={label} title={label}>
        <RunningIcon size={14} aria-hidden="true" />
      </span>
    ) : null;
  }
  function chatList(folderId: string | null) {
    const items = visible.filter((chat) => (chat.folderId ?? null) === folderId);
    const key = `${botId}:${folderId ?? ''}`;
    const limit = visibleCount[key] ?? 5;
    const initial = items.slice(0, limit);
    // Keep the selected chat accessible even if it lies beyond the displayed page.
    const selectedItem =
      destination === 'story' ? items.find((chat) => chat.id === selected) : undefined;
    // A selected chat beyond the first page is a shortcut, not part of the visible
    // sortable page. Keep it separate at the top so its actual position is not implied.
    const shown =
      selectedItem && !initial.includes(selectedItem) ? [selectedItem, ...initial] : initial;
    return (
      <div className="bot-chat-list">
        {shown.map((chat) => {
          const index = items.indexOf(chat);
          const pinned = index >= limit;
          const selectedChat = selected === chat.id && destination === 'story';
          function target(event: DragEvent) {
            const box = event.currentTarget.getBoundingClientRect();
            return event.clientY < box.top + box.height / 2
              ? chat.id
              : (items[index + 1]?.id ?? null);
          }
          return (
            <div
              className={`bot-chat-item ${pinned ? 'pinned' : ''} ${selectedChat ? 'selected' : ''} ${dragId === chat.id ? 'dragging' : ''} ${dropTarget?.folderId === folderId && dropTarget.beforeId === chat.id ? 'drop-before' : ''}`}
              key={chat.id}
              data-chat-id={chat.id}
              draggable={!pinned && !busy && !loading}
              onDragStart={(event) => {
                if (pinned) {
                  event.preventDefault();
                  return;
                }
                event.stopPropagation();
                if ((event.target as HTMLElement).closest('.bot-row-actions')) {
                  event.preventDefault();
                  return;
                }
                dragChat.current = chat;
                setDragId(chat.id);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', chat.id);
              }}
              onDragEnd={clearDrag}
              onDragOver={(event) => {
                if (pinned) return event.stopPropagation();
                over(event, folderId, target(event));
              }}
              onDrop={(event) => {
                if (pinned) {
                  event.preventDefault();
                  return event.stopPropagation();
                }
                drop(event, folderId, target(event));
              }}
            >
              <button
                className="chat-link"
                title={chat.title}
                aria-current={selectedChat ? 'page' : undefined}
                onClick={() => onSelect(chat.id)}
              >
                <strong>{chat.title}</strong>
                {pinned && <small className="bot-chat-current-label">{t('transfer.m218')}</small>}
              </button>
              {status(activity(chat)?.label)}
              <div className="bot-row-actions">
                <ActionMenu label={t('transfer.d013', { v0: chat.title })} viewport>
                  <div className="action-menu-group">
                    {props.onCopyChat && (
                      <button
                        type="button"
                        disabled={props.copyingChats?.includes(chat.id)}
                        onClick={() => props.onCopyChat?.(chat.id)}
                      >
                        {props.copyingChats?.includes(chat.id) ? (
                          <LoaderCircle size={18} aria-hidden="true" />
                        ) : (
                          <Copy size={18} aria-hidden="true" />
                        )}
                        {t(
                          props.copyingChats?.includes(chat.id)
                            ? 'recent.copyingChat'
                            : 'recent.copyChat'
                        )}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={(event) => openFromMenu(event, () => setMenuId(chat.id))}
                    >
                      <EditIcon size={18} aria-hidden="true" />
                      {t('transfer.m239')}
                    </button>
                  </div>
                  <div className="action-menu-group">
                    <DeleteButton
                      path={`/chats/${encodeURIComponent(chat.id)}`}
                      preparePath={`/chats/${encodeURIComponent(chat.id)}/deletion-impact`}
                      title={chat.title}
                      label={t('transfer.m240')}
                      disabled={busy}
                      description={t('transfer.m241')}
                      onError={onError}
                      onDeleted={onChatsChanged}
                    />
                  </div>
                </ActionMenu>
              </div>
            </div>
          );
        })}
        {items.length > limit && (
          <button
            type="button"
            className="bot-chat-more"
            onClick={() =>
              setVisibleCount((current) => ({
                ...current,
                [key]: (current[key] ?? 5) + 20,
              }))
            }
          >
            <ExpandIcon size={13} aria-hidden="true" />
            {t('transfer.moreChats', { count: Math.min(20, items.length - limit) })}
          </button>
        )}
        {dropTarget?.folderId === folderId && dropTarget.beforeId === null && (
          <div className="bot-drop-end" aria-hidden="true" />
        )}
        {!items.length && (folderId !== null || folders.length === 0 || dragId) && (
          <p className="bot-empty-folder">{dragId ? t('transfer.m243') : t('transfer.m244')}</p>
        )}
      </div>
    );
  }
  // The blank space after a truncated list means "after the visible rows", not
  // "append after every hidden chat". Individual row drops already use full indices.
  function firstHiddenId(folderId: string | null) {
    const key = `${botId}:${folderId ?? ''}`;
    const limit = visibleCount[key] ?? 5;
    return (
      visible
        .filter((chat) => (chat.folderId ?? null) === folderId)
        .slice(limit)
        .find((chat) => chat.id !== dragChat.current?.id)?.id ?? null
    );
  }
  function folderSection(folder: ChatFolder | null) {
    const id = folder?.id ?? null,
      title = folder?.title ?? t('transfer.m245');
    const key = `${botId}:${id ?? ''}`;
    const expanded = !collapsed[key];
    const count = scoped
      .filter((chat) => (chat.folderId ?? null) === id)
      .reduce((sum, chat) => sum + (activity(chat)?.count ?? 0), 0);
    if (!folder)
      return (
        <section
          className={`bot-folder bot-folder-unfiled ${dropTarget?.folderId === null && dropTarget.beforeId === null ? 'drop-folder' : ''}`}
          key=""
          data-folder-id=""
          onDragOver={(event) => over(event, null, firstHiddenId(null))}
          onDrop={(event) => drop(event, null, firstHiddenId(null))}
        >
          {chatList(null)}
        </section>
      );
    return (
      <section
        className={`bot-folder ${dropTarget?.folderId === id && dropTarget.beforeId === null ? 'drop-folder' : ''}`}
        key={id ?? ''}
        data-folder-id={id ?? ''}
        onDragOver={(event) =>
          over(
            event,
            id,
            (event.target as HTMLElement).closest('.bot-folder-heading') ? null : firstHiddenId(id)
          )
        }
        onDrop={(event) =>
          drop(
            event,
            id,
            (event.target as HTMLElement).closest('.bot-folder-heading') ? null : firstHiddenId(id)
          )
        }
      >
        <div className="bot-folder-heading">
          <button
            className="bot-folder-toggle"
            aria-label={t('transfer.d014', { v0: title })}
            aria-expanded={expanded}
            onClick={() => setCollapsed((value) => ({ ...value, [key]: expanded }))}
          >
            <ExpandIcon size={12} className={expanded ? 'expanded' : ''} />
            <FolderIcon size={15} />
            <span>{title}</span>
          </button>
          {!expanded && status(count ? t('transfer.d015', { v0: count }) : undefined)}
          <div className="bot-row-actions">
            {bot && (
              <button
                className="icon-button"
                aria-label={t('transfer.d016', { v0: title })}
                title={t('transfer.m246')}
                disabled={busy}
                onClick={() => void start(folder ?? undefined)}
              >
                <AddIcon size={16} />
              </button>
            )}
            {folder && (
              <button
                className="icon-button"
                aria-label={t('transfer.d017', { v0: title })}
                title={t('transfer.m247')}
                onClick={() => setSettingsId(folder.id)}
              >
                <MoreIcon size={16} />
              </button>
            )}
          </div>
        </div>
        {expanded && chatList(id)}
      </section>
    );
  }
  const menuChat = scoped.find((chat) => chat.id === menuId);
  const settingsFolder = folders.find((folder) => folder.id === settingsId);
  return (
    <div
      className="bot-branch"
      data-bot-id={botId}
      onKeyDown={(event) => {
        if (event.key === 'Escape') clearDrag();
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDropTarget(null);
          if (expandTimer.current) clearTimeout(expandTimer.current);
          expandKey.current = null;
        }
      }}
    >
      <div {...headingDrag} className={`bot-branch-heading ${headingDrag?.className ?? ''}`}>
        <button
          className="bot-branch-toggle"
          aria-label={t('transfer.d018', { v0: bot?.title ?? t('transfer.m005') })}
          aria-expanded={expanded}
          onClick={onToggle}
          title={bot?.title}
        >
          <ExpandIcon size={12} className={expanded ? 'expanded' : ''} />
          {bot && <ContentAvatar content={bot} className="bot-choice-avatar" />}
          <strong>{bot?.title ?? t('transfer.m005')}</strong>
        </button>
        <div className="bot-branch-actions">
          <ActionMenu label={t('transfer.d019', { v0: bot?.title ?? t('transfer.m005') })} viewport>
            <div className="action-menu-group">
              <button
                type="button"
                onClick={(event) => {
                  const menu = event.currentTarget.closest('details');
                  if (menu) menu.open = false;
                  setSearching(true);
                }}
              >
                <SearchIcon size={18} aria-hidden="true" />
                {t('transfer.m248')}
              </button>
              {bot && props.onConfigureNew && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={(event) => openFromMenu(event, () => void start(undefined, true))}
                >
                  <AddIcon size={18} aria-hidden="true" />
                  {t('transfer.configureNewChat')}
                </button>
              )}
              {bot && props.onImportChat && (
                <button
                  type="button"
                  onClick={(event) => openFromMenu(event, () => props.onImportChat?.(bot))}
                >
                  <LibraryIcon size={18} aria-hidden="true" />
                  {t('transfer.m106')}
                </button>
              )}
            </div>
            <div className="action-menu-group">
              <button
                type="button"
                disabled={busy}
                onClick={(event) => {
                  const menu = event.currentTarget.closest('details');
                  if (menu) {
                    menu.open = false;
                    menu.querySelector('summary')?.focus();
                  }
                  setCreating(true);
                }}
              >
                <FolderAddIcon size={18} aria-hidden="true" />
                {t('transfer.m249')}
              </button>
              {bot && library && (
                <button
                  type="button"
                  onClick={(event) => openFromMenu(event, () => setEditingDefaults(true))}
                >
                  <EditIcon size={18} aria-hidden="true" />
                  {t('transfer.m251')}
                </button>
              )}
              <button
                type="button"
                onClick={(event) => {
                  const menu = event.currentTarget.closest('details');
                  if (menu) menu.open = false;
                  onLibrary('bot');
                }}
              >
                <LibraryIcon size={18} aria-hidden="true" />
                {t('transfer.m250')}
              </button>
            </div>
          </ActionMenu>
          <IconButton
            label={t('transfer.d020', { v0: bot?.title ?? t('transfer.m005') })}
            icon={AddIcon}
            disabled={busy}
            onClick={() => void start()}
          />
        </div>
      </div>
      {expanded && (
        <div className="bot-branch-chats">
          {loading ? (
            <LoadingState presentation="inline" label={t('transfer.m252')} />
          ) : (
            <nav aria-label={t('transfer.d021', { v0: bot?.title ?? t('transfer.m005') })}>
              {folderSection(null)}
              {folders.map((folder) => folderSection(folder))}
            </nav>
          )}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {translateMessage(error)}
        </p>
      )}
      {editingDefaults && bot && library && (
        <BotDefaultPersona bot={bot} library={library} onClose={() => setEditingDefaults(false)} />
      )}
      <Dialog
        open={searching}
        title={t('transfer.m253')}
        onClose={() => setSearching(false)}
        className="manuscript-search-dialog"
      >
        {searching && (
          <ManuscriptSearchPanel
            initialScope="bot"
            botId={botId}
            chats={chats}
            folders={folders}
            library={library}
            label={t('transfer.m248')}
            onChat={(id) => {
              setSearching(false);
              onSelect(id);
            }}
            onNavigate={(target) => {
              setSearching(false);
              onSelect(target.chatId, target);
            }}
          />
        )}
      </Dialog>
      <Dialog
        open={creating}
        title={t('transfer.m254')}
        onClose={() => setCreating(false)}
        className="bot-organize-dialog"
      >
        <form
          className="bot-folder-create"
          onSubmit={(event) => {
            event.preventDefault();
            const title = newTitle.trim();
            if (title)
              void perform(async () => {
                await api(`/bots/${encodeURIComponent(botId)}/folders`, { title });
                if (currentBot.current === botId) {
                  setNewTitle('');
                  setCreating(false);
                }
              });
          }}
        >
          <label>
            {t('transfer.m255')}
            <input
              aria-label={t('transfer.m255')}
              required
              maxLength={200}
              value={newTitle}
              onChange={(event) => setNewTitle(event.target.value)}
            />
          </label>
          <button disabled={busy || !newTitle.trim()}>{t('transfer.m256')}</button>
        </form>
      </Dialog>
      <Dialog
        open={!!settingsFolder}
        title={t('transfer.m247')}
        onClose={() => setSettingsId(null)}
        className="bot-organize-dialog"
      >
        {settingsFolder && (
          <FolderSettings
            key={settingsFolder.id}
            folder={settingsFolder}
            library={library}
            busy={busy}
            onSave={async (value) => {
              let saved: ChatFolder | null = null;
              await perform(async () => {
                saved = await api<ChatFolder>(
                  `/bots/${encodeURIComponent(botId)}/folders/${settingsFolder.id}`,
                  value,
                  'PATCH'
                );
              });
              return saved;
            }}
            onRemove={() =>
              perform(() =>
                api(
                  `/bots/${encodeURIComponent(botId)}/folders/${settingsFolder.id}`,
                  { expectedRevision: settingsFolder.revision },
                  'DELETE'
                )
              )
            }
          />
        )}
        {settingsFolder && props.onConfigureNew && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              const folder = settingsFolder;
              setSettingsId(null);
              void start(folder, true);
            }}
          >
            <AddIcon size={18} aria-hidden="true" />
            {t('transfer.configureNewChat')}
          </button>
        )}
      </Dialog>
      <Dialog
        open={!!menuChat}
        title={t('transfer.m257')}
        onClose={() => setMenuId(null)}
        className="bot-organize-dialog"
      >
        {menuChat && (
          <div className="bot-chat-menu">
            <ChatTitleEditor
              key={menuChat.id}
              chat={menuChat}
              disabled={busy}
              onChatsChanged={onChatsChanged}
              onClose={() => setMenuId(null)}
            />
          </div>
        )}
      </Dialog>
    </div>
  );
}

function ChatTitleEditor({
  chat,
  disabled,
  onChatsChanged,
  onClose,
}: {
  chat: Chat;
  disabled: boolean;
  onChatsChanged: () => Promise<void>;
  onClose: () => void;
}) {
  useI18n();
  const [draft, setDraft] = useState(chat.title);
  const [baseTitle, setBaseTitle] = useState(chat.title);
  const [baseTitleRevision, setBaseTitleRevision] = useState(chat.titleRevision ?? 0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const observedTitleRevision = useRef(chat.titleRevision ?? 0);
  const dirty = draft !== baseTitle;
  // Background refreshes may publish an automatic title while the user is typing.
  // Only adopt it when there is no manual draft to preserve.
  useEffect(() => {
    const changed = observedTitleRevision.current !== (chat.titleRevision ?? 0);
    observedTitleRevision.current = chat.titleRevision ?? 0;
    if (changed && !dirty && !saving) {
      setDraft(chat.title);
      setBaseTitle(chat.title);
      setBaseTitleRevision(chat.titleRevision ?? 0);
    }
  }, [chat.title, chat.titleRevision, dirty, saving]);
  async function save() {
    if (lock.current || !draft.trim()) return;
    lock.current = true;
    setSaving(true);
    setError('');
    try {
      const updated = await api<Chat>(
        `/chats/${encodeURIComponent(chat.id)}/title`,
        { title: draft.trim(), expectedTitleRevision: baseTitleRevision },
        'PATCH'
      );
      setDraft(updated.title);
      setBaseTitle(updated.title);
      setBaseTitleRevision(updated.titleRevision ?? 0);
      await onChatsChanged();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : retainedMessage('transfer.m258'));
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }
  return (
    <form
      className="bot-chat-title-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label>
        {t('transfer.m221')}
        <input
          aria-label={t('transfer.m221')}
          value={draft}
          maxLength={200}
          required
          disabled={disabled || saving}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <div className="form-actions">
        <button
          type="button"
          className="secondary"
          disabled={saving}
          onClick={() => {
            setDraft(chat.title);
            setBaseTitle(chat.title);
            setBaseTitleRevision(chat.titleRevision ?? 0);
            setError('');
            onClose();
          }}
        >
          <CloseIcon size={18} aria-hidden="true" />
          {t('transfer.m206')}
        </button>
        <SaveButton
          label={t('transfer.m260')}
          disabled={disabled || !dirty || !draft.trim()}
          aria-busy={saving}
        />
      </div>
      {dirty && (chat.titleRevision ?? 0) !== baseTitleRevision && (
        <small>{t('transfer.m261')}</small>
      )}
      {error && (
        <p className="error" role="alert">
          {translateMessage(error)}
        </p>
      )}
    </form>
  );
}

function FolderSettings({
  folder,
  library,
  busy,
  onSave,
  onRemove,
}: {
  folder: ChatFolder;
  library: Library | null;
  busy: boolean;
  onSave: (value: {
    expectedRevision: number;
    title: string;
    defaultPersona: { id: string; revision: number } | null;
  }) => Promise<ChatFolder | null>;
  onRemove: () => Promise<void>;
}) {
  useI18n();
  const [title, setTitle] = useState(folder.title);
  const [persona, setPersona] = useState(
    folder.defaultPersona ? reference(folder.defaultPersona) : ''
  );
  const [base, setBase] = useState(folder);
  const [edited, setEdited] = useState({ title: false, persona: false });
  const [discarding, setDiscarding] = useState(false);
  const dirty = edited.title || edited.persona;
  const conflicted = folder.revision > base.revision;
  const [selectedContent, setSelectedContent] = useState<Content | null>(null);
  const personaId = folder.defaultPersona?.id,
    personaRevision = folder.defaultPersona?.revision;
  useEffect(() => {
    let current = true;
    setSelectedContent(null);
    if (personaId !== undefined && personaRevision !== undefined)
      void api<Content>(`/content/${encodeURIComponent(personaId)}`)
        .then((content) => {
          if (current) {
            setSelectedContent(content);
            setPersona((previous) =>
              previous.slice(0, previous.lastIndexOf('@')) === personaId
                ? reference(content)
                : previous
            );
          }
        })
        .catch(() => {
          /* Keep the missing selection visible until the user explicitly replaces it. */
        });
    return () => {
      current = false;
    };
  }, [personaId, personaRevision]);
  useEffect(() => {
    if (folder.revision <= base.revision || busy) return;
    if (!edited.title) setTitle(folder.title);
    if (!edited.persona) setPersona(folder.defaultPersona ? reference(folder.defaultPersona) : '');
    // A draft still belongs to the revision the user started editing. A conflict refresh
    // may update untouched fields, but cannot quietly authorize overwriting newer settings.
    if (!dirty) setBase(folder);
  }, [folder, base.revision, busy, edited.title, edited.persona, dirty]);
  function loadLatest() {
    setTitle(folder.title);
    setPersona(folder.defaultPersona ? reference(folder.defaultPersona) : '');
    setBase(folder);
    setEdited({ title: false, persona: false });
    setDiscarding(false);
  }
  const savedPersonaTitle = folder.defaultPersona
    ? (library?.contents.find((content) => content.id === folder.defaultPersona?.id)?.title ??
      (selectedContent?.id === folder.defaultPersona.id ? selectedContent.title : null) ??
      t('transfer.m262'))
    : t('transfer.m263');
  return (
    <div className="bot-folder-settings">
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || conflicted || !title.trim()) return;
          const selected = [
            ...(library?.contents ?? []),
            ...(selectedContent ? [selectedContent] : []),
          ]
            .filter((content) => content.id === persona.slice(0, persona.lastIndexOf('@')))
            .sort((a, b) => b.revision - a.revision)[0];
          const saved = await onSave({
            expectedRevision: base.revision,
            title,
            defaultPersona: selected
              ? { id: selected.id, revision: selected.revision }
              : persona
                ? base.defaultPersona
                : null,
          });
          if (saved) {
            setTitle(saved.title);
            setPersona(saved.defaultPersona ? reference(saved.defaultPersona) : '');
            setBase(saved);
            setEdited({ title: false, persona: false });
          }
        }}
      >
        <label>
          {t('transfer.m264')}
          <input
            aria-label={t('transfer.d022', { v0: folder.title })}
            value={title}
            maxLength={200}
            required
            disabled={busy}
            onChange={(event) => {
              setTitle(event.target.value);
              setEdited((current) => ({ ...current, title: event.target.value !== base.title }));
            }}
          />
        </label>
        {library && (
          <ContentPicker
            library={library}
            role="persona"
            label={t('transfer.d023', { v0: folder.title })}
            value={persona}
            onChange={(value) => {
              setPersona(value);
              setEdited((current) => ({
                ...current,
                persona: value !== (base.defaultPersona ? reference(base.defaultPersona) : ''),
              }));
            }}
            allowNone
            noneLabel={t('transfer.m263')}
            selectedContent={selectedContent}
            disabled={busy}
          />
        )}
        {conflicted && (
          <NoticeBanner tone="error">
            <p>{t('transfer.m265')}</p>
            <details>
              <summary>{t('transfer.m266')}</summary>
              <p>{t('transfer.folderNameValue', { name: folder.title })}</p>
              <p>{t('transfer.personaValue', { name: savedPersonaTitle })}</p>
            </details>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                if (dirty) setDiscarding(true);
                else loadLatest();
              }}
            >
              {t('transfer.m269')}
            </button>
          </NoticeBanner>
        )}
        <small>{t('transfer.m270')}</small>
        <SaveButton
          label={t('transfer.m271')}
          className="secondary"
          disabled={conflicted || !title.trim()}
          aria-busy={busy}
        />
      </form>
      <button
        type="button"
        className="bot-folder-release secondary"
        disabled={busy}
        onClick={() => {
          void onRemove();
        }}
      >
        {t('transfer.m272')}
      </button>
      <Dialog
        open={discarding}
        title={t('transfer.m273')}
        variant="confirmation"
        onClose={() => setDiscarding(false)}
      >
        <p>{t('transfer.m274')}</p>
        <DraftDiscardActions
          open={discarding}
          disabled={busy}
          onContinue={() => setDiscarding(false)}
          onDiscard={loadLatest}
          discardLabel={t('transfer.m275')}
        />
      </Dialog>
    </div>
  );
}
