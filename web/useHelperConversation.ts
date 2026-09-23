import { useCallback, useEffect, useRef, useState } from 'react';
import type { HelperConversation, HelperEvent, HelperMessage, HelperTask } from '../core/helper.js';
import { api } from './api.js';
import { evictHelperViews } from './helper-conversation-cache.js';

export type HelperTaskView = Omit<HelperTask, 'snapshot'> & { modelTitle: string };
type View = {
  conversation: HelperConversation;
  messages: HelperMessage[];
  tasks: HelperTaskView[];
  hasOlderMessages: boolean;
  hasOlderTasks: boolean;
};
const id = encodeURIComponent;

/** Retains the current and recent conversations across panel hides; idle reads use event cursors. */
export function useHelperConversation(open: boolean, conversationId: string | null) {
  const scopeKey = conversationId ?? '';
  const selectedScope = useRef(scopeKey);
  selectedScope.current = scopeKey;
  const cache = useRef(new Map<string, View>());
  const cursors = useRef(new Map<string, number>());
  const versions = useRef(new Map<string, number>());
  const requestVersion = useRef(0);
  const [views, setViews] = useState<Record<string, View>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const alive = useRef(true);
  const earlierLock = useRef(false);
  const current = views[scopeKey];
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const write = useCallback((key: string, value: View) => {
    cache.current.delete(key);
    cache.current.set(key, value);
    for (const removed of evictHelperViews(cache.current, selectedScope.current)) {
      cursors.current.delete(removed);
      versions.current.delete(removed);
    }
    if (alive.current) setViews(Object.fromEntries(cache.current));
  }, []);
  const refresh = useCallback(
    async (conversation: Pick<HelperConversation, 'id'>) => {
      const key = conversation.id;
      // Global request identities cannot be reused after a view has been evicted and reopened.
      const version = ++requestVersion.current;
      versions.current.set(key, version);
      try {
        const {
          messages,
          tasks,
          conversation: latestConversation,
          eventCursor,
        } = await api<{
          messages: HelperMessage[];
          tasks: HelperTaskView[];
          conversation: HelperConversation;
          eventCursor: number;
        }>(`/helper/conversations/${id(key)}/view`);
        if (!alive.current || versions.current.get(key) !== version) return;
        // The first view starts at now. Later views must not skip effects arriving between polls.
        if (!cursors.current.has(key)) cursors.current.set(key, eventCursor);
        const previous = cache.current.get(key);
        const messageIds = new Set(messages.map((message) => message.id));
        const latestGroups = new Map(
          messages.map((message) => [message.requestGroupId, message.latestTaskId])
        );
        const taskIds = new Set(tasks.map((task) => task.id));
        write(key, {
          conversation:
            previous?.conversation.revision &&
            previous.conversation.revision > latestConversation.revision
              ? previous.conversation
              : latestConversation,
          messages: [
            ...(previous?.messages ?? []).filter(
              (message) =>
                !messageIds.has(message.id) &&
                (!message.requestGroupId ||
                  !latestGroups.has(message.requestGroupId) ||
                  latestGroups.get(message.requestGroupId) === message.taskId)
            ),
            ...messages,
          ],
          tasks: [...tasks, ...(previous?.tasks ?? []).filter((task) => !taskIds.has(task.id))],
          hasOlderMessages: messages.length === 100 && (previous?.hasOlderMessages ?? true),
          hasOlderTasks: tasks.length === 50 && (previous?.hasOlderTasks ?? true),
        });
      } finally {
        if (versions.current.get(key) === version) versions.current.delete(key);
      }
    },
    [write]
  );
  useEffect(() => {
    if (!open || !conversationId) return;
    let disposed = false,
      polling = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let initialized = false,
      needsRefresh = true;
    const report = (cause: unknown) => {
      if (!disposed && selectedScope.current === scopeKey)
        setError(cause instanceof Error ? cause.message : '도우미 대화를 불러오지 못했어요.');
    };
    const events = async () => {
      let cursor = cursors.current.get(conversationId) ?? 0;
      let changed = false,
        notify = false;
      for (;;) {
        const page = await api<HelperEvent[]>(
          `/helper/conversations/${id(conversationId)}/events?after=${cursor}`
        );
        if (disposed) return false;
        for (const event of page) {
          if (event.seq <= cursor) continue;
          if (event.kind === 'theme.updated')
            window.dispatchEvent(new Event('uimori-themes-changed'));
          cursor = event.seq;
          changed = true;
          if (
            /^task\.(completed|failed|cancelled|interrupted)$/u.test(event.kind) ||
            event.kind === 'artifact.saved'
          )
            notify = true;
        }
        cursors.current.set(
          conversationId,
          Math.max(cursors.current.get(conversationId) ?? 0, cursor)
        );
        if (page.length < 500) break;
      }
      if (notify) window.dispatchEvent(new Event('uimori-helper-updated'));
      return changed;
    };
    const poll = async () => {
      if (disposed || polling) return;
      polling = true;
      try {
        if (!document.hidden) {
          if (!initialized) {
            await refresh({ id: conversationId });
            initialized = true;
            needsRefresh = false;
          } else {
            needsRefresh = (await events()) || needsRefresh;
            if (needsRefresh) {
              await refresh({ id: conversationId });
              needsRefresh = false;
            }
          }
          if (!disposed && selectedScope.current === scopeKey) setError('');
        }
      } catch (cause) {
        report(cause);
      } finally {
        polling = false;
        if (!disposed) setLoading(false);
        if (!disposed) timer = setTimeout(() => void poll(), document.hidden ? 10000 : 1200);
      }
    };
    const visible = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        void poll();
      }
    };
    const cached = cache.current.get(scopeKey);
    if (cached) {
      cache.current.delete(scopeKey);
      cache.current.set(scopeKey, cached);
    }
    setLoading(!cached);
    setError('');
    void poll();
    addEventListener('visibilitychange', visible);
    return () => {
      disposed = true;
      clearTimeout(timer);
      removeEventListener('visibilitychange', visible);
    };
  }, [open, scopeKey, conversationId, refresh]);
  const earlier = async (kind: 'messages' | 'tasks') => {
    const view = cache.current.get(scopeKey);
    if (!view || earlierLock.current) return;
    const before = kind === 'messages' ? view.messages[0]?.id : view.tasks.at(-1)?.id;
    if (!before) return;
    earlierLock.current = true;
    setLoadingEarlier(true);
    try {
      const path = `/helper/conversations/${id(view.conversation.id)}/${kind}?before=${id(before)}`;
      if (kind === 'messages') {
        const page = await api<HelperMessage[]>(path);
        if (!alive.current || (!cache.current.has(scopeKey) && selectedScope.current !== scopeKey))
          return;
        const latest = cache.current.get(scopeKey) ?? view;
        const existing = new Set(latest.messages.map((item) => item.id));
        write(scopeKey, {
          ...latest,
          messages: [...page.filter((item) => !existing.has(item.id)), ...latest.messages],
          hasOlderMessages: page.length === 100,
        });
      } else {
        const page = await api<HelperTaskView[]>(path);
        if (!alive.current || (!cache.current.has(scopeKey) && selectedScope.current !== scopeKey))
          return;
        const latest = cache.current.get(scopeKey) ?? view;
        const existing = new Set(latest.tasks.map((item) => item.id));
        write(scopeKey, {
          ...latest,
          tasks: [...latest.tasks, ...page.filter((item) => !existing.has(item.id))],
          hasOlderTasks: page.length === 50,
        });
      }
    } catch (cause) {
      if (selectedScope.current === scopeKey)
        setError(cause instanceof Error ? cause.message : '이전 기록을 불러오지 못했어요.');
    } finally {
      earlierLock.current = false;
      if (alive.current) setLoadingEarlier(false);
    }
  };
  return {
    current,
    loading,
    error,
    setError,
    loadingEarlier,
    refresh,
    earlier,
    updateConversation: (conversation: HelperConversation) => {
      const previous = cache.current.get(conversation.id);
      if (previous) write(conversation.id, { ...previous, conversation });
    },
    updateTask: (task: HelperTaskView) => {
      const view = cache.current.get(task.conversationId);
      if (!view) return;
      const existing = view.tasks.some((item) => item.id === task.id);
      write(task.conversationId, {
        ...view,
        tasks: existing
          ? view.tasks.map((item) => (item.id === task.id ? task : item))
          : [task, ...view.tasks],
      });
    },
  };
}
