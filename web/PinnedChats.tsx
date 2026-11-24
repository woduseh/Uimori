import { useState } from 'react';
import { t, useI18n } from './i18n.js';
import { ActivitySection } from './ActivitySection.js';
import { ChatActionMenu, ChatTitleDialog } from './ChatActionMenu.js';
import { ContentAvatar } from './ContentAvatar.js';
import type { Chat } from '../core/types.js';
import type { Library } from '../core/product.js';
import './activity-navigation.css';

export function pinnedChats(chats: Chat[]) {
  return chats
    .filter((chat) => chat.pinnedAt)
    .toSorted((a, b) => b.pinnedAt!.localeCompare(a.pinnedAt!) || a.id.localeCompare(b.id));
}

export function PinnedChats({
  chats,
  library,
  selected,
  onSelect,
  onCopyChat,
  copyingChats,
  onChatsChanged,
  onError,
}: {
  chats: Chat[];
  library: Library | null;
  selected: string;
  onSelect: (id: string) => void;
  onCopyChat?: (chatId: string) => void;
  copyingChats?: string[];
  onChatsChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  useI18n();
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  const pinned = pinnedChats(chats);
  if (!pinned.length) return null;
  const botOf = (chat: Chat) => library?.contents.find((bot) => bot.id === chat.botId);
  return (
    <div className="pinned-chats">
      <ActivitySection id="pinned" label={t('recent.pinned')} total={pinned.length}>
        {(limit) =>
          pinned.slice(0, limit).map((chat) => {
            const bot = botOf(chat);
            const botName = bot?.title ?? t('helpers.m261');
            return (
              <div className="activity-nav-chat-row" key={chat.id} data-pinned-chat-id={chat.id}>
                <button
                  type="button"
                  className={`activity-nav-link${selected === chat.id ? ' selected' : ''}`}
                  aria-current={selected === chat.id ? 'page' : undefined}
                  onClick={() => onSelect(chat.id)}
                >
                  <ContentAvatar content={bot} className="pinned-chat-avatar" />
                  <span className="activity-nav-copy">
                    <strong>{chat.title || t('helpers.m260')}</strong>
                    <small>{botName}</small>
                  </span>
                </button>
                <ChatActionMenu
                  chat={chat}
                  onCopyChat={onCopyChat}
                  copying={copyingChats?.includes(chat.id)}
                  onRename={() => setRenamingChatId(chat.id)}
                  onChatsChanged={onChatsChanged}
                  onError={onError}
                />
              </div>
            );
          })
        }
      </ActivitySection>
      <ChatTitleDialog
        chat={chats.find((chat) => chat.id === renamingChatId)}
        onChatsChanged={onChatsChanged}
        onClose={() => setRenamingChatId(null)}
      />
    </div>
  );
}
