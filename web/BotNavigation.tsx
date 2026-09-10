import { Dialog } from './Dialog.js';
import { ActionMenu } from './ActionMenu.js';
import type { useChatActivities } from './useChatActivities.js';
import type { DragEvent, MouseEvent, ReactNode } from 'react';
import { DeleteButton } from './DeleteButton.js';
import { IconButton } from './IconButton.js';
import { useEffect, useRef, useState } from 'react';
import {
  AddIcon,
  DownIcon,
  EditIcon,
  ExpandIcon,
  FolderAddIcon,
  FolderIcon,
  LibraryIcon,
  MoreIcon,
  MoveIcon,
  RunningIcon,
  SearchIcon,
  UpIcon,
} from './ui-icons.js';
import type { Content, Library } from '../core/product.js';
import type { Chat } from '../core/types.js';
import type { ChatFolder } from '../core/product.js';
import { api } from './api.js';
import { ContentAvatar } from './ContentAvatar.js';
import { ContentPicker } from './ContentPicker.js';
import './bot-navigation.css';

export type { ChatFolder } from '../core/product.js';
type LibraryDestination = 'bot' | 'persona' | 'module' | 'prompts';
export type Props = {
  library: Library | null;
  chats: Chat[];
  selected: string;
  destination: 'story' | 'library';
  onSelect: (id: string) => void;
  onNew: (bot: Content, folder?: ChatFolder) => void;
  onLibrary: (tab: LibraryDestination) => void;
  onChatsChanged: () => Promise<void>;
  onError: (message: string) => void;
  onSettings: () => void;
  onTasks: () => void;
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
    managementActions?: ReactNode;
    activities: ReturnType<typeof useChatActivities>;
  }
) {
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
    managementActions,
    activities,
  } = props;
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [folders, setFolders] = useState<ChatFolder[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
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
  const shouldLoad = expanded || searching || creating || !!movingId;
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
      const message = reason instanceof Error ? reason.message : '변경 내용을 저장하지 못했어요.';
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
  async function start(folder?: ChatFolder) {
    if (!bot || operation.current) return;
    operation.current = true;
    setBusy(true);
    const owner = bot.id;
    const version = epoch.current;
    try {
      const full = await api<Content>(`/content/${encodeURIComponent(bot.id)}`);
      if (owner === currentBot.current && version === epoch.current) onNew(full, folder);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '봇을 불러오지 못했어요.';
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
        ? { count: tasks, label: `작업 ${tasks}개 진행 중` }
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
    return (
      <div className="bot-chat-list">
        {items.map((chat, index) => {
          const selectedChat = selected === chat.id && destination === 'story';
          function target(event: DragEvent) {
            const box = event.currentTarget.getBoundingClientRect();
            return event.clientY < box.top + box.height / 2
              ? chat.id
              : (items[index + 1]?.id ?? null);
          }
          return (
            <div
              className={`bot-chat-item ${selectedChat ? 'selected' : ''} ${dragId === chat.id ? 'dragging' : ''} ${dropTarget?.folderId === folderId && dropTarget.beforeId === chat.id ? 'drop-before' : ''}`}
              key={chat.id}
              data-chat-id={chat.id}
              draggable={!busy && !loading}
              onDragStart={(event) => {
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
              onDragOver={(event) => over(event, folderId, target(event))}
              onDrop={(event) => drop(event, folderId, target(event))}
            >
              <button
                className="chat-link"
                title={chat.title}
                aria-current={selectedChat ? 'page' : undefined}
                onClick={() => onSelect(chat.id)}
              >
                <strong>{chat.title}</strong>
              </button>
              {status(activity(chat)?.label)}
              <div className="bot-row-actions">
                <ActionMenu label={`${chat.title} 채팅 메뉴`} viewport>
                  <button
                    type="button"
                    onClick={(event) => openFromMenu(event, () => setMenuId(chat.id))}
                  >
                    <EditIcon size={18} aria-hidden="true" />
                    이름 변경
                  </button>
                  <button
                    type="button"
                    onClick={(event) => openFromMenu(event, () => setMovingId(chat.id))}
                  >
                    <MoveIcon size={18} aria-hidden="true" />
                    채팅 이동
                  </button>
                  <DeleteButton
                    path={`/chats/${encodeURIComponent(chat.id)}`}
                    preparePath={`/chats/${encodeURIComponent(chat.id)}/deletion-impact`}
                    title={chat.title}
                    label="채팅 삭제"
                    disabled={busy}
                    description="이 채팅의 모든 분기, 원문, 번역, 이미지와 실행 기록을 영구 삭제해요. 실행 중인 작업은 먼저 취소하거나 완료해 주세요."
                    onError={onError}
                    onDeleted={onChatsChanged}
                  />
                </ActionMenu>
              </div>
            </div>
          );
        })}
        {dropTarget?.folderId === folderId && dropTarget.beforeId === null && (
          <div className="bot-drop-end" aria-hidden="true" />
        )}
        {!items.length && (folderId !== null || folders.length === 0 || dragId) && (
          <p className="bot-empty-folder">{dragId ? '여기로 이동' : '채팅이 없어요.'}</p>
        )}
      </div>
    );
  }
  function folderSection(folder: ChatFolder | null) {
    const id = folder?.id ?? null,
      title = folder?.title ?? '미분류';
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
          onDragOver={(event) => over(event, null, null)}
          onDrop={(event) => drop(event, null, null)}
        >
          {chatList(null)}
        </section>
      );
    return (
      <section
        className={`bot-folder ${dropTarget?.folderId === id && dropTarget.beforeId === null ? 'drop-folder' : ''}`}
        key={id ?? ''}
        data-folder-id={id ?? ''}
        onDragOver={(event) => over(event, id, null)}
        onDrop={(event) => drop(event, id, null)}
      >
        <div className="bot-folder-heading">
          <button
            className="bot-folder-toggle"
            aria-label={`${title} 폴더`}
            aria-expanded={expanded}
            onClick={() => setCollapsed((value) => ({ ...value, [key]: expanded }))}
          >
            <ExpandIcon size={12} className={expanded ? 'expanded' : ''} />
            <FolderIcon size={15} />
            <span>{title}</span>
          </button>
          {!expanded && status(count ? `폴더 안에서 작업 ${count}개 진행 중` : undefined)}
          <div className="bot-row-actions">
            {bot && (
              <button
                className="icon-button"
                aria-label={`${title}에서 새 채팅`}
                title="새 채팅"
                disabled={busy}
                onClick={() => void start(folder ?? undefined)}
              >
                <AddIcon size={16} />
              </button>
            )}
            {folder && (
              <button
                className="icon-button"
                aria-label={`${title} 폴더 설정`}
                title="폴더 설정"
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
  const movingChat = scoped.find((chat) => chat.id === movingId);
  const menuSiblings = scoped.filter(
    (chat) => (chat.folderId ?? null) === (movingChat?.folderId ?? null)
  );
  const menuIndex = menuSiblings.findIndex((chat) => chat.id === movingId);
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
      <div className="bot-branch-heading">
        <button
          className="bot-branch-toggle"
          aria-label={`${bot?.title ?? '봇'} 채팅 목록`}
          aria-expanded={expanded}
          onClick={onToggle}
          title={bot?.title}
        >
          <ExpandIcon size={12} className={expanded ? 'expanded' : ''} />
          {bot && <ContentAvatar content={bot} className="bot-choice-avatar" />}
          <strong>{bot?.title ?? '봇'}</strong>
        </button>
        <div className="bot-branch-actions">
          <ActionMenu label={`${bot?.title ?? '봇'} 관리`} viewport>
            <button
              type="button"
              onClick={(event) => {
                const menu = event.currentTarget.closest('details');
                if (menu) menu.open = false;
                setQuery('');
                setSearching(true);
              }}
            >
              <SearchIcon size={18} aria-hidden="true" />
              채팅 검색
            </button>
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
              <FolderAddIcon size={18} aria-hidden="true" />새 폴더
            </button>
            <button
              type="button"
              onClick={(event) => {
                const menu = event.currentTarget.closest('details');
                if (menu) menu.open = false;
                onLibrary('bot');
              }}
            >
              <LibraryIcon size={18} aria-hidden="true" />
              서재에서 관리
            </button>
            {managementActions}
          </ActionMenu>
          <IconButton
            label={`${bot?.title ?? '봇'} 새 채팅`}
            icon={AddIcon}
            disabled={busy}
            onClick={() => void start()}
          />
        </div>
      </div>
      {expanded && (
        <div className="bot-branch-chats">
          {loading ? (
            <p role="status">폴더를 불러오는 중이에요…</p>
          ) : (
            <nav aria-label={`${bot?.title ?? '봇'}의 채팅 목록`}>
              {folderSection(null)}
              {folders.map((folder) => folderSection(folder))}
            </nav>
          )}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <Dialog
        open={searching}
        title="이 봇의 채팅 검색"
        onClose={() => setSearching(false)}
        className="bot-organize-dialog"
      >
        <label className="story-search">
          <SearchIcon size={16} />
          <input
            aria-label="채팅 검색"
            placeholder="채팅 이름 검색"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <nav className="bot-search-results" aria-label="채팅 검색 결과">
          {scoped
            .filter((chat) => chat.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
            .map((chat) => (
              <button
                key={chat.id}
                data-chat-id={chat.id}
                onClick={() => {
                  setSearching(false);
                  onSelect(chat.id);
                }}
              >
                <strong>{chat.title}</strong>
                <small>
                  {folders.find((folder) => folder.id === chat.folderId)?.title ?? '미분류'}
                </small>
              </button>
            ))}
          {!scoped.some((chat) =>
            chat.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())
          ) && <p>검색 결과가 없어요.</p>}
        </nav>
      </Dialog>
      <Dialog
        open={creating}
        title="폴더 만들기"
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
            새 폴더 이름
            <input
              aria-label="새 폴더 이름"
              required
              maxLength={200}
              value={newTitle}
              onChange={(event) => setNewTitle(event.target.value)}
            />
          </label>
          <button disabled={busy || !newTitle.trim()}>폴더 추가</button>
        </form>
      </Dialog>
      <Dialog
        open={!!settingsFolder}
        title="폴더 설정"
        onClose={() => setSettingsId(null)}
        className="bot-organize-dialog"
      >
        {settingsFolder && (
          <FolderSettings
            key={settingsFolder.id}
            folder={settingsFolder}
            library={library}
            busy={busy}
            onSave={(value) =>
              perform(() =>
                api(
                  `/bots/${encodeURIComponent(botId)}/folders/${settingsFolder.id}`,
                  { expectedRevision: settingsFolder.revision, ...value },
                  'PATCH'
                )
              )
            }
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
      </Dialog>
      <Dialog
        open={!!menuChat}
        title="채팅 이름 변경"
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
      <Dialog
        open={!!movingChat}
        title="채팅 이동"
        onClose={() => setMovingId(null)}
        className="bot-organize-dialog"
      >
        {movingChat && (
          <div className="bot-chat-menu">
            <label>
              폴더로 이동
              <select
                aria-label={`${movingChat.title} 폴더 이동`}
                value={movingChat.folderId ?? ''}
                disabled={busy || loading}
                onChange={(event) => moveChat(movingChat, event.target.value || null)}
              >
                <option value="">미분류</option>
                {folders.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.title}
                  </option>
                ))}
              </select>
            </label>
            <div className="bot-chat-menu-actions">
              <IconButton
                label="위로 이동"
                icon={UpIcon}
                disabled={busy || menuIndex <= 0}
                onClick={() =>
                  moveChat(movingChat, movingChat.folderId ?? null, menuSiblings[menuIndex - 1].id)
                }
              />
              <IconButton
                label="아래로 이동"
                icon={DownIcon}
                disabled={busy || menuIndex >= menuSiblings.length - 1}
                onClick={() =>
                  moveChat(
                    movingChat,
                    movingChat.folderId ?? null,
                    menuSiblings[menuIndex + 2]?.id ?? null
                  )
                }
              />
            </div>
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
      setError(reason instanceof Error ? reason.message : '채팅 제목을 저장하지 못했어요.');
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
        채팅 제목
        <input
          aria-label="채팅 제목"
          value={draft}
          maxLength={200}
          required
          disabled={disabled || saving}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <div className="form-actions">
        <button disabled={disabled || saving || !dirty || !draft.trim()}>
          {saving ? '저장 중…' : '제목 저장'}
        </button>
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
          취소
        </button>
      </div>
      {dirty && (chat.titleRevision ?? 0) !== baseTitleRevision && (
        <small>
          제목이 다른 곳에서 변경됐어요. 입력한 내용은 유지돼요. 취소하면 최신 제목을 불러와요.
        </small>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
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
    title: string;
    defaultPersona: { id: string; revision: number } | null;
  }) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [title, setTitle] = useState(folder.title);
  const [persona, setPersona] = useState(
    folder.defaultPersona ? reference(folder.defaultPersona) : ''
  );
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
    setTitle(folder.title);
    setPersona(personaId === undefined ? '' : `${personaId}@${personaRevision}`);
  }, [folder.title, personaId, personaRevision]);
  return (
    <div className="bot-folder-settings">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const selected = [
            ...(library?.contents ?? []),
            ...(selectedContent ? [selectedContent] : []),
          ]
            .filter((content) => content.id === persona.slice(0, persona.lastIndexOf('@')))
            .sort((a, b) => b.revision - a.revision)[0];
          void onSave({
            title,
            defaultPersona: selected
              ? { id: selected.id, revision: selected.revision }
              : persona
                ? folder.defaultPersona
                : null,
          });
        }}
      >
        <label>
          폴더 이름
          <input
            aria-label={`${folder.title} 폴더 이름`}
            value={title}
            maxLength={200}
            required
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        {library && (
          <ContentPicker
            library={library}
            role="persona"
            label={`${folder.title} 기본 페르소나`}
            value={persona}
            onChange={setPersona}
            allowNone
            noneLabel="지정 안 함"
            selectedContent={selectedContent}
            disabled={busy}
          />
        )}
        <small>앞으로 이 폴더에서 시작하는 채팅에 적용돼요.</small>
        <button className="secondary" disabled={busy || !title.trim()}>
          설정 저장
        </button>
      </form>
      <button
        type="button"
        className="bot-folder-release secondary"
        disabled={busy}
        onClick={() => {
          void onRemove();
        }}
      >
        폴더 해제 · 채팅 유지
      </button>
    </div>
  );
}
