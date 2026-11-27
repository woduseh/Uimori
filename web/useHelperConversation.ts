import { useI18n } from './i18n.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  HelperContextCompactionSummary,
  HelperConversation,
  HelperEvent,
  HelperMessage,
  HelperMessageMutation,
  HelperTask,
} from '../core/helper.js';
import { api } from './api.js';
import { evictHelperViews } from './helper-conversation-cache.js';
import { diagnosticHelperEvent } from './live-frames.js';
import { watchLive } from './live-stream.js';
import { helperPollDelay } from './poll-delays.js';
import { toUiMessage } from './api-errors.js';
import type { UiMessage } from './ui-message.js';

export type HelperTaskView = Omit<HelperTask, 'snapshot'> & { modelTitle: string };
type View = {
  conversation: HelperConversation;
  messages: HelperMessage[];
  tasks: HelperTaskView[];
  context?: HelperContextCompactionSummary;
  hasOlderMessages: boolean;
  hasOlderTasks: boolean;
};
const id = encodeURIComponent;
const viewActive = (view: View | undefined) =>
  Boolean(
    view?.context?.compaction.running ||
      view?.tasks.some((task) => ['queued', 'running'].includes(task.status))
  );

function applyMessageChange(view: View, change: HelperMessageMutation): View {
  if ((change.conversation.historyRevision ?? 0) <= (view.conversation.historyRevision ?? 0))
    return view;
  const removed = new Set(change.deletedMessageIds);
  return {
    ...view,
    conversation: {
      ...(change.conversation.revision >= view.conversation.revision
        ? change.conversation
        : view.conversation),
      historyRevision: change.conversation.historyRevision,
    },
    messages: view.messages
      .filter((message) => !removed.has(message.id))
      .map((message) =>
        message.id === change.updatedMessage?.id
          ? { ...message, text: change.updatedMessage.text }
          : message
      ),
  };
}

function messageChange(view: View, event: HelperEvent): HelperMessageMutation {
  const data = event.data as Omit<HelperMessageMutation, 'conversation'> & { revision: number };
  return {
    ...data,
    conversation: {
      ...view.conversation,
      revision: data.revision,
      historyRevision: event.seq,
    },
  };
}

export function replayMessageEvents(view: View, events: readonly HelperEvent[], through: number) {
  let replayed = view;
  for (const event of events)
    if (event.kind === 'messages.changed' && event.seq <= through)
      replayed = applyMessageChange(replayed, messageChange(replayed, event));
  return replayed;
}

type ViewPage = {
  messages: HelperMessage[];
  tasks: HelperTaskView[];
  conversation: HelperConversation;
  context?: HelperContextCompactionSummary;
};

export function mergeHelperView(previous: View | undefined, page: ViewPage): View {
  const { messages, tasks, conversation: latestConversation, context } = page;
  const messageIds = new Set(messages.map((message) => message.id));
  const latestGroups = new Map(
    messages.map((message) => [message.requestGroupId, message.latestTaskId])
  );
  const taskIds = new Set(tasks.map((task) => task.id));
  return {
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
    context: context ?? previous?.context,
    hasOlderMessages: messages.length === 100 && (previous?.hasOlderMessages ?? true),
    hasOlderTasks: tasks.length === 50 && (previous?.hasOlderTasks ?? true),
  };
}

export function useHelperConversation(open: boolean, conversationId: string | null) {
  useI18n();
  const scopeKey = conversationId ?? '';
  const selectedScope = useRef(scopeKey);
  selectedScope.current = scopeKey;
  const cache = useRef(new Map<string, View>());
  const cursors = useRef(new Map<string, number>());
  const versions = useRef(new Map<string, number>());
  const requestVersion = useRef(0);
  const [views, setViews] = useState<Record<string, View>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<UiMessage | null>(null);
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
  const applyMessageMutation = useCallback(
    (change: HelperMessageMutation, replayed = false) => {
      const key = change.conversation.id;
      const previous = cache.current.get(key);
      if (!previous) return;
      const next = applyMessageChange(previous, change);
      if (next === previous) return;
      if (!replayed) next.conversation.historyRevision = previous.conversation.historyRevision;
      versions.current.set(key, ++requestVersion.current);
      write(key, next);
    },
    [write]
  );
  const refresh = useCallback(
    async (conversation: Pick<HelperConversation, 'id'>) => {
      const key = conversation.id;
      const version = ++requestVersion.current;
      versions.current.set(key, version);
      try {
        const page = await api<ViewPage & { eventCursor: number }>(
          `/helper/conversations/${id(key)}/view`
        );
        const latestConversation = page.conversation;
        if (!alive.current || versions.current.get(key) !== version) return;
        if (!cursors.current.has(key)) cursors.current.set(key, page.eventCursor);
        let previous = cache.current.get(key);
        if (
          (latestConversation.historyRevision ?? 0) < (previous?.conversation.historyRevision ?? 0)
        )
          return;
        if (
          previous &&
          (latestConversation.historyRevision ?? 0) > (previous.conversation.historyRevision ?? 0)
        ) {
          let cursor = previous.conversation.historyRevision ?? 0;
          while (cursor < (latestConversation.historyRevision ?? 0)) {
            const events = await api<HelperEvent[]>(
              `/helper/conversations/${id(key)}/events?after=${cursor}`
            );
            if (!alive.current || versions.current.get(key) !== version) return;
            previous = replayMessageEvents(
              previous,
              events,
              latestConversation.historyRevision ?? 0
            );
            const nextCursor = events.at(-1)?.seq ?? cursor;
            if (nextCursor <= cursor) break;
            cursor = nextCursor;
          }
        }
        write(key, mergeHelperView(previous, page));
      } finally {
        if (versions.current.get(key) === version) versions.current.delete(key);
      }
    },
    [write]
  );
  useEffect(() => {
    if (!open || !conversationId) return;
    let disposed = false,
      initialized = false,
      needsRefresh = false;
    const report = (cause: unknown) => {
      if (!disposed && selectedScope.current === scopeKey)
        setError(toUiMessage(cause, 'helpers.m207'));
    };
    const queuedTask = (taskId: string | null) =>
      taskId !== null &&
      Boolean(
        cache.current
          .get(conversationId)
          ?.tasks.some((task) => task.id === taskId && task.status === 'queued')
      );
    const changesView = (event: Pick<HelperEvent, 'kind' | 'taskId'>) =>
      !diagnosticHelperEvent(event) || queuedTask(event.taskId);
    const events = async () => {
      let cursor = cursors.current.get(conversationId) ?? 0;
      let changed = false;
      for (;;) {
        const page = await api<HelperEvent[]>(
          `/helper/conversations/${id(conversationId)}/events?after=${cursor}`
        );
        if (disposed) return false;
        for (const event of page) {
          if (event.seq <= cursor) continue;
          if (event.kind === 'messages.changed') {
            const view = cache.current.get(conversationId);
            if (view) applyMessageMutation(messageChange(view, event), true);
          }
          cursor = event.seq;
          if (changesView(event)) changed = true;
        }
        cursors.current.set(
          conversationId,
          Math.max(cursors.current.get(conversationId) ?? 0, cursor)
        );
        if (page.length < 500 || document.hidden) break;
      }
      return changed;
    };
    const sync = async () => {
      try {
        if (!initialized) {
          if (cursors.current.has(conversationId)) await events();
          if (disposed || document.hidden) return;
          await refresh({ id: conversationId });
          initialized = true;
          needsRefresh = false;
        } else {
          needsRefresh = (await events()) || needsRefresh;
          if (needsRefresh && !disposed && !document.hidden) {
            await refresh({ id: conversationId });
            needsRefresh = false;
          }
        }
        if (!disposed && selectedScope.current === scopeKey) setError(null);
      } catch (cause) {
        report(cause);
        throw cause;
      } finally {
        if (!disposed) setLoading(false);
      }
    };
    const live = watchLive({
      match: (frame) =>
        frame.event === 'helper' && frame.conversationId === conversationId && changesView(frame),
      refresh: sync,
      fallbackMs: () =>
        viewActive(cache.current.get(scopeKey))
          ? helperPollDelay.conversation.active
          : helperPollDelay.conversation.idle,
    });
    const cached = cache.current.get(scopeKey);
    if (cached) {
      cache.current.delete(scopeKey);
      cache.current.set(scopeKey, cached);
    }
    setLoading(!cached);
    setError(null);
    live.request();
    return () => {
      disposed = true;
      live.dispose();
    };
  }, [open, scopeKey, conversationId, refresh, applyMessageMutation]);
  const earlier = async (kind: 'messages' | 'tasks') => {
    const view = cache.current.get(scopeKey);
    if (!view || earlierLock.current) return;
    const historyRevision = view.conversation.historyRevision ?? 0;
    const before = kind === 'messages' ? view.messages[0]?.id : view.tasks.at(-1)?.id;
    if (!before) return;
    earlierLock.current = true;
    setLoadingEarlier(true);
    try {
      const path = `/helper/conversations/${id(view.conversation.id)}/${kind}?before=${id(before)}`;
      if (kind === 'messages') {
        const page = await api<HelperMessage[]>(path);
        if ((cache.current.get(scopeKey)?.conversation.historyRevision ?? 0) !== historyRevision)
          return;
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
      if (selectedScope.current === scopeKey) setError(toUiMessage(cause, 'helpers.m208'));
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
    readCurrent: (conversationId: string) => cache.current.get(conversationId),
    applyMessageMutation,
    earlier,
    updateConversation: (conversation: HelperConversation) => {
      const previous = cache.current.get(conversation.id);
      if (previous && conversation.revision >= previous.conversation.revision)
        write(conversation.id, {
          ...previous,
          conversation: {
            ...conversation,
            historyRevision: previous.conversation.historyRevision,
          },
        });
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
