import { t, useI18n, translateMessage, formatDate, formatNumber } from './i18n.js';
import { activityStatusLabel } from './ActivityStatus.js';
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  LoaderCircle,
  MessageCircle,
} from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import type { ActivityFeed, ActivityFeedItem, HelperRecentTask } from '../core/activity-feed.js';
import type { Chat } from '../core/types.js';
import type { Library } from '../core/product.js';
import type { ReaderTarget } from '../core/reader-target.js';
import './activity-navigation.css';

type Props = {
  chats: Chat[];
  library: Library | null;
  selected: string;
  feed: ActivityFeed;
  error: string;
  onSelect: (id: string, target?: ReaderTarget) => void;
  onAcknowledge: (items: ActivityFeedItem[]) => void;
  onInspect: (item: ActivityFeedItem) => void;
  onOpenHelper?: (task: HelperRecentTask) => void;
  onRetry: () => void;
};
type ActivitySectionId = 'unread' | 'running' | 'recent' | 'helpers';
const sectionStorageKey = 'uimori:activity-sections:v1';
const initialExpanded: Record<ActivitySectionId, boolean> = {
  unread: true,
  running: true,
  recent: true,
  helpers: false,
};
function readExpanded(id: ActivitySectionId) {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(sectionStorageKey) ?? 'null');
    return stored &&
      typeof stored === 'object' &&
      !Array.isArray(stored) &&
      typeof (stored as Record<string, unknown>)[id] === 'boolean'
      ? (stored as Record<string, boolean>)[id]
      : initialExpanded[id];
  } catch {
    return initialExpanded[id];
  }
}
/** The section keeps its shown count while folded; reopening never starts over. */
function ActivitySection({
  id,
  label,
  total,
  children,
  empty,
}: {
  id: ActivitySectionId;
  label: string;
  total: number;
  children: (limit: number) => ReactNode;
  empty: string;
}) {
  useI18n();
  const [expanded, setExpanded] = useState(() => readExpanded(id));
  const [limit, setLimit] = useState(5);
  const contentsId = useId();
  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    try {
      const previous: unknown = JSON.parse(localStorage.getItem(sectionStorageKey) ?? 'null');
      const saved =
        previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {};
      localStorage.setItem(sectionStorageKey, JSON.stringify({ ...saved, [id]: next }));
    } catch {
      // Navigation must still work when optional presentation storage is disabled.
    }
  };
  return (
    <section className="activity-nav-section" data-activity-section={id}>
      <button
        type="button"
        className="activity-nav-heading"
        aria-expanded={expanded}
        aria-controls={contentsId}
        onClick={toggle}
      >
        <span className="activity-nav-heading-label">
          {expanded ? (
            <ChevronDown size={14} aria-hidden="true" />
          ) : (
            <ChevronRight size={14} aria-hidden="true" />
          )}
          <strong>{label}</strong>
        </span>
        <span>{formatNumber(total)}</span>
      </button>
      <div id={contentsId} hidden={!expanded}>
        {expanded && (total ? children(limit) : <p className="activity-nav-empty">{empty}</p>)}
        {expanded && limit < total && (
          <button
            type="button"
            className="activity-nav-more"
            onClick={() => setLimit((current) => Math.min(current + 20, total))}
          >
            <ChevronDown size={14} aria-hidden="true" />
            {t('helpers.m331', { count: formatNumber(Math.min(20, total - limit)) })}
          </button>
        )}
      </div>
    </section>
  );
}
function timeLabel(date: string) {
  const time = Date.parse(date);
  if (!Number.isFinite(time)) return '';
  const elapsed = Date.now() - time;
  if (elapsed >= 0 && elapsed < 60000) return t('helpers.m257');
  if (elapsed >= 0 && elapsed < 3600000)
    return t('helpers.m258', { v0: Math.floor(elapsed / 60000) });
  if (elapsed >= 0 && elapsed < 86400000)
    return t('helpers.m259', { v0: Math.floor(elapsed / 3600000) });
  return formatDate(new Date(time), { year: 'numeric', month: 'numeric', day: 'numeric' });
}
export function ActivityNavigation({
  chats,
  library,
  selected,
  feed,
  error,
  onSelect,
  onAcknowledge,
  onInspect,
  onOpenHelper,
  onRetry,
}: Props) {
  useI18n();
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
                    <small>
                      {botName(chat)} · {activityStatusLabel(relevant)}
                      {items.length > 1
                        ? t('helpers.m265', { v0: formatNumber(items.length - 1) })
                        : ''}
                    </small>
                  </span>
                  <time dateTime={relevant.at}>{timeLabel(relevant.at)}</time>
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
                      kinds: [...info.kinds].join(' · '),
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
          recent.slice(0, limit).map((chat) => (
            <button
              key={chat.id}
              type="button"
              className={`activity-nav-link${selected === chat.id ? ' selected' : ''}`}
              onClick={() => onSelect(chat.id)}
            >
              <MessageCircle size={16} aria-hidden="true" />
              <span className="activity-nav-copy">
                <strong>{title(chat)}</strong>
                <small>{botName(chat)}</small>
              </span>
              <time dateTime={chat.lastActivityAt}>{timeLabel(chat.lastActivityAt ?? '')}</time>
            </button>
          ))
        }
      </ActivitySection>
      <ActivitySection
        id="helpers"
        label={t('helpers.m272')}
        total={feed.helpers?.length ?? 0}
        empty={t('helpers.m273')}
      >
        {(limit) =>
          (feed.helpers ?? []).slice(0, limit).map((task) => (
            <button
              key={task.id}
              type="button"
              className="activity-nav-link"
              onClick={() => onOpenHelper?.(task)}
              disabled={!onOpenHelper}
            >
              {task.status === 'running' || task.status === 'queued' ? (
                <LoaderCircle size={16} aria-hidden="true" />
              ) : task.status === 'completed' ? (
                <Check size={16} aria-hidden="true" />
              ) : (
                <AlertCircle size={16} className="activity-nav-warning" aria-hidden="true" />
              )}
              <span className="activity-nav-copy">
                <strong>{task.title || t('helpers.m274')}</strong>
                <small>
                  {task.chatId
                    ? (chatById.get(task.chatId)?.title ?? t('helpers.m275'))
                    : t('helpers.m276')}{' '}
                  ·{' '}
                  {task.status === 'running'
                    ? t('helpers.m113')
                    : task.status === 'queued'
                      ? t('helpers.m277')
                      : task.status === 'completed'
                        ? t('helpers.m278')
                        : task.status === 'failed'
                          ? t('helpers.m279')
                          : task.status === 'cancelled'
                            ? t('helpers.m165')
                            : t('helpers.m280')}
                  {task.committedEffects > 0
                    ? t('helpers.m281', { v0: formatNumber(task.committedEffects) })
                    : ''}
                </small>
              </span>
              <time dateTime={task.updatedAt}>{timeLabel(task.updatedAt)}</time>
            </button>
          ))
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
    </nav>
  );
}
