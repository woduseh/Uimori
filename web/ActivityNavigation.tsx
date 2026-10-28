import { t, useI18n, translateMessage, formatDate, formatNumber } from './i18n.js';
import { activityStatusLabel } from './ActivityStatus.js';
import { AlertCircle, Check, LoaderCircle, MessageCircle } from 'lucide-react';
import { useState } from 'react';
import { ActivitySection } from './ActivitySection.js';
import { navigationTimeLabel } from './navigation-time.js';
import type { ActivityFeed, ActivityFeedItem } from '../core/activity-feed.js';
import type { Chat } from '../core/types.js';
import type { Library } from '../core/product.js';
import type { ReaderTarget } from '../core/reader-target.js';
import { ChatActionMenu, ChatTitleDialog } from './ChatActionMenu.js';
import { groupRecentDates, recentDateGroupLabel } from './recent-date-groups.js';
import './activity-navigation.css';

type Props = {
  chats: Chat[];
  library: Library | null;
  selected: string;
  feed: ActivityFeed;
  error: string;
  onSelect: (id: string, target?: ReaderTarget) => void;
  onCopyChat?: (chatId: string) => void;
  copyingChats?: string[];
  onChatsChanged: () => Promise<void>;
  onError: (message: string) => void;
  onAcknowledge: (items: ActivityFeedItem[]) => void;
  onInspect: (item: ActivityFeedItem) => void;
  onRetry: () => void;
};
export function ActivityNavigation({
  chats,
  library,
  selected,
  feed,
  error,
  onSelect,
  onCopyChat,
  copyingChats,
  onChatsChanged,
  onError,
  onAcknowledge,
  onInspect,
  onRetry,
}: Props) {
  useI18n();
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  const names = new Map(library?.contents.map((bot) => [bot.id, bot.title]) ?? []);
  const chatById = new Map(chats.map((chat) => [chat.id, chat]));
  const grouped = new Map<string, ActivityFeedItem[]>();
  for (const item of feed.items) {
    if (!chatById.has(item.chatId)) continue;
    const group = grouped.get(item.chatId) ?? [];
    group.push(item);
    grouped.set(item.chatId, group);
  }
  const unread = [...grouped].sort(
    (a, b) =>
      Number(b[1].some((item) => item.actionable)) - Number(a[1].some((item) => item.actionable)) ||
      b[1][0].at.localeCompare(a[1][0].at)
  );
  const running = new Map<string, { count: number; kinds: Set<string> }>();
  const labels: Record<string, string> = {
    main: t('helpers.m216'),
    translation: t('helpers.m217'),
    image: t('helpers.m218'),
    illustration: t('helpers.m220'),
  };
  for (const task of feed.running) {
    if (!chatById.has(task.chatId)) continue;
    const info = running.get(task.chatId) ?? { count: 0, kinds: new Set<string>() };
    info.count += task.count;
    info.kinds.add(labels[task.kind] ?? t('helpers.m224'));
    running.set(task.chatId, info);
  }
  // The recent-chat index is for navigation, not an inbox: never exclude busy or unread chats.
  const recent = chats.toSorted(
    (a, b) =>
      (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '') || b.id.localeCompare(a.id)
  );
  const title = (chat: Chat) => chat.title || t('helpers.m260');
  const botName = (chat: Chat) => names.get(chat.botId) ?? t('helpers.m261');
  const openItem = (chatId: string, item: ActivityFeedItem) => {
    onInspect(item);
    onSelect(
      chatId,
      item.sourceId
        ? {
            chatId,
            sourceId: item.sourceId,
            representation: item.representation,
          }
        : undefined
    );
  };
  return (
    <nav className="activity-navigation" aria-label={t('helpers.m262')}>
      <ActivitySection
        id="unread"
        label={t('helpers.m263')}
        total={unread.length}
        empty={t('helpers.m264')}
      >
        {(limit) =>
          unread.slice(0, limit).map(([chatId, items]) => {
            const chat = chatById.get(chatId)!;
            const relevant = items.find((item) => item.actionable) ?? items[0];
            const available = items.filter((item) => item.canAcknowledge);
            return (
              <div className="activity-nav-entry" key={chatId}>
                <button
                  type="button"
                  className="activity-nav-link"
                  onClick={() => openItem(chatId, relevant)}
                >
                  <AlertCircle
                    size={16}
                    className={
                      relevant.actionable ? 'activity-nav-warning' : 'activity-nav-success'
                    }
                    aria-hidden="true"
                  />
                  <span className="activity-nav-copy">
                    <strong>{title(chat)}</strong>
                    <small className="ui-meta-row">
                      <span>{botName(chat)}</span>
                      <span>
                        {activityStatusLabel(relevant)}
                        {items.length > 1
                          ? t('helpers.m265', { v0: formatNumber(items.length - 1) })
                          : ''}
                      </span>
                    </small>
                  </span>
                  <time dateTime={relevant.at}>{navigationTimeLabel(relevant.at)}</time>
                </button>
                {available.length > 0 && (
                  <button
                    type="button"
                    className="activity-nav-confirm"
                    aria-label={t('helpers.m266', {
                      v0: title(chat),
                      v1: formatNumber(available.length),
                    })}
                    onClick={() => onAcknowledge(available)}
                  >
                    <Check size={14} aria-hidden="true" />
                    {t('helpers.m267')}
                  </button>
                )}
              </div>
            );
          })
        }
      </ActivitySection>
      <ActivitySection
        id="running"
        label={t('helpers.m113')}
        total={running.size}
        empty={t('helpers.m268')}
      >
        {(limit) =>
          [...running].slice(0, limit).map(([chatId, info]) => {
            const chat = chatById.get(chatId)!;
            return (
              <button
                key={chatId}
                type="button"
                className="activity-nav-link"
                onClick={() => onSelect(chatId)}
              >
                <LoaderCircle size={16} aria-hidden="true" />
                <span className="activity-nav-copy">
                  <strong>{title(chat)}</strong>
                  <small>
                    {t('helpers.m332', {
                      kinds: [...info.kinds].join(', '),
                      count: formatNumber(info.count),
                    })}
                  </small>
                </span>
              </button>
            );
          })
        }
      </ActivitySection>
      <ActivitySection
        id="recent"
        label={t('helpers.m270')}
        total={recent.length}
        empty={t('helpers.m271')}
      >
        {(limit) =>
          groupRecentDates(recent.slice(0, limit), (chat) => chat.lastActivityAt).map(
            (group, index) => (
              <div className="activity-nav-date-group" key={`${group.key}:${index}`}>
                <h3>{recentDateGroupLabel(group)}</h3>
                {group.items.map((chat) => (
                  <div className="activity-nav-chat-row" key={chat.id} data-chat-id={chat.id}>
                    <button
                      type="button"
                      className={`activity-nav-link${selected === chat.id ? ' selected' : ''}`}
                      aria-current={selected === chat.id ? 'page' : undefined}
                      onClick={() => onSelect(chat.id)}
                    >
                      <MessageCircle size={16} aria-hidden="true" />
                      <span className="activity-nav-copy">
                        <strong>{title(chat)}</strong>
                        <small className="activity-nav-detail">
                          <span>{botName(chat)}</span>
                          <time
                            dateTime={chat.lastActivityAt}
                            title={
                              chat.lastActivityAt ? formatDate(chat.lastActivityAt) : undefined
                            }
                          >
                            {navigationTimeLabel(chat.lastActivityAt ?? '')}
                          </time>
                        </small>
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
                ))}
              </div>
            )
          )
        }
      </ActivitySection>
      {error && (
        <p className="activity-nav-error" role="alert">
          {translateMessage(error)}{' '}
          <button type="button" onClick={onRetry}>
            {t('helpers.m282')}
          </button>
        </p>
      )}
      <ChatTitleDialog
        chat={chats.find((chat) => chat.id === renamingChatId)}
        onChatsChanged={onChatsChanged}
        onClose={() => setRenamingChatId(null)}
      />
    </nav>
  );
}
