import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  HelperConversation,
  HelperEvent,
  HelperMessage,
  HelperScope,
  HelperTask,
} from '../core/helper.js';
import { api } from './api.js';

export type HelperTaskView = Omit<HelperTask, 'snapshot'>;
type View = {
  conversation: HelperConversation;
  messages: HelperMessage[];
  tasks: HelperTaskView[];
  hasOlderMessages: boolean;
  hasOlderTasks: boolean;
};
const id = encodeURIComponent;

/** Retains visited pages across panel hides and reads only new events while idle. */
export function useHelperConversation(open: boolean, scope: HelperScope) {
  const scopeKey = JSON.stringify(scope);
  const selectedScope = useRef(scopeKey);
  selectedScope.current = scopeKey;
  const cache = useRef(new Map<string, View>());
  const cursors = useRef(new Map<string, number>());
  const versions = useRef(new Map<string, number>());
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
    cache.current.set(key, value);
    if (alive.current) setViews((old) => ({ ...old, [key]: value }));
  }, []);
  const refresh = useCallback(
    async (conversation: HelperConversation) => {
      const key = JSON.stringify(conversation.scope);
      const version = (versions.current.get(key) ?? 0) + 1;
      versions.current.set(key, version);
      const [messages, tasks] = await Promise.all([
        api<HelperMessage[]>(`/helper/conversations/${id(conversation.id)}/messages`),
        api<HelperTaskView[]>(`/helper/conversations/${id(conversation.id)}/tasks`),
      ]);
      if (!alive.current || versions.current.get(key) !== version) return;
      const previous = cache.current.get(key);
      const messageIds = new Set(messages.map((message) => message.id));
      const taskIds = new Set(tasks.map((task) => task.id));
      write(key, {
        conversation:
          previous?.conversation.revision && previous.conversation.revision > conversation.revision
            ? previous.conversation
            : conversation,
        messages: [
          ...(previous?.messages ?? []).filter((message) => !messageIds.has(message.id)),
          ...messages,
        ],
        tasks: [...tasks, ...(previous?.tasks ?? []).filter((task) => !taskIds.has(task.id))],
        hasOlderMessages: messages.length === 100 && (previous?.hasOlderMessages ?? true),
        hasOlderTasks: tasks.length === 50 && (previous?.hasOlderTasks ?? true),
      });
    },
    [write]
  );
  useEffect(() => {
    if (!open) return;
    let disposed = false,
      polling = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let conversation: HelperConversation | undefined;
    const report = (cause: unknown) => {
      if (!disposed && selectedScope.current === scopeKey)
        setError(cause instanceof Error ? cause.message : '도우미 대화를 불러오지 못했어요.');
    };
    const events = async (initial = false) => {
      if (!conversation) return false;
      const known = cursors.current.has(conversation.id);
      let cursor = cursors.current.get(conversation.id) ?? 0;
      let changed = false,
        notify = false;
      for (;;) {
        const page = await api<HelperEvent[]>(
          `/helper/conversations/${id(conversation.id)}/events?after=${cursor}`
        );
        if (disposed) return false;
        for (const event of page) {
          if (event.seq <= cursor) continue;
          cursor = event.seq;
          changed = true;
          if (
            (!initial || known) &&
            (/^task\.(completed|failed|cancelled|interrupted)$/u.test(event.kind) ||
              event.kind === 'artifact.saved')
          )
            notify = true;
        }
        cursors.current.set(conversation.id, cursor);
        if (page.length < 500) break;
      }
      if (notify) window.dispatchEvent(new Event('uimori-helper-updated'));
      return changed;
    };
    const poll = async () => {
      if (disposed || polling || !conversation) return;
      polling = true;
      try {
        if (!document.hidden && (await events())) await refresh(conversation);
      } catch (cause) {
        report(cause);
      } finally {
        polling = false;
        if (!disposed) timer = setTimeout(() => void poll(), document.hidden ? 10000 : 1200);
      }
    };
    const visible = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        void poll();
      }
    };
    setLoading(!cache.current.has(scopeKey));
    setError('');
    void api<HelperConversation>('/helper/conversations', { scope: JSON.parse(scopeKey) })
      .then(async (value) => {
        if (disposed) return;
        conversation = value;
        await events(true);
        if (disposed) return;
        await refresh(value);
        if (!disposed) timer = setTimeout(() => void poll(), 1200);
      })
      .catch(report)
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    addEventListener('visibilitychange', visible);
    return () => {
      disposed = true;
      clearTimeout(timer);
      removeEventListener('visibilitychange', visible);
    };
  }, [open, scopeKey, refresh]);
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
        const latest = cache.current.get(scopeKey) ?? view;
        const existing = new Set(latest.messages.map((item) => item.id));
        write(scopeKey, {
          ...latest,
          messages: [...page.filter((item) => !existing.has(item.id)), ...latest.messages],
          hasOlderMessages: page.length === 100,
        });
      } else {
        const page = await api<HelperTaskView[]>(path);
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
      const key = JSON.stringify(conversation.scope),
        previous = cache.current.get(key);
      if (previous) write(key, { ...previous, conversation });
    },
    updateTask: (task: HelperTaskView) => {
      const entry = [...cache.current].find(
        ([, view]) => view.conversation.id === task.conversationId
      );
      if (!entry) return;
      const [key, view] = entry;
      const existing = view.tasks.some((item) => item.id === task.id);
      write(key, {
        ...view,
        tasks: existing
          ? view.tasks.map((item) => (item.id === task.id ? task : item))
          : [task, ...view.tasks],
      });
    },
  };
}
