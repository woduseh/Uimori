import { useI18n, message as uiMessage } from './i18n.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  HelperConversation,
  HelperEvent,
  HelperMessage,
  HelperMessageMutation,
  HelperResourceEdit,
  HelperTask,
} from '../core/helper.js';
import { api } from './api.js';
import { evictHelperViews } from './helper-conversation-cache.js';

export type HelperTaskView = Omit<HelperTask, 'snapshot'> & { modelTitle: string };
type View = {
  conversation: HelperConversation;
  messages: HelperMessage[];
  tasks: HelperTaskView[];
  lastResourceEdit: HelperResourceEdit | null;
  hasOlderMessages: boolean;
  hasOlderTasks: boolean;
};
const id = encodeURIComponent;
const diagnosticEvent = (kind: string) =>
  kind === 'tool.finished' ||
  kind === 'input.measured' ||
  kind === 'progress' ||
  kind.startsWith('context.');

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

/** Retains the current and recent conversations across panel hides; idle reads use event cursors. */
export function useHelperConversation(
  open: boolean,
  conversationId: string | null,
  latestEventSeq?: number
) {
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
  const [error, setError] = useState('');
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const alive = useRef(true);
  const earlierLock = useRef(false);
  const current = views[scopeKey];
  const latestSequence = useRef(latestEventSeq);
  latestSequence.current = latestEventSeq;
  const wake = useRef<() => void>(() => {});
  const running =
    current?.tasks.some((task) => ['queued', 'running'].includes(task.status)) ?? false;
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
      // An acknowledged local write is only one change, not proof that preceding events
      // were read. Keep that replay boundary until polling catches up in sequence.
      if (!replayed) next.conversation.historyRevision = previous.conversation.historyRevision;
      // A response started before this mutation cannot restore the old text or deleted rows.
      versions.current.set(key, ++requestVersion.current);
      write(key, next);
    },
    [write]
  );
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
          lastResourceEdit,
        } = await api<{
          messages: HelperMessage[];
          tasks: HelperTaskView[];
          conversation: HelperConversation;
          eventCursor: number;
          lastResourceEdit: HelperResourceEdit | null;
        }>(`/helper/conversations/${id(key)}/view`);
        if (!alive.current || versions.current.get(key) !== version) return;
        // The first view starts at now. Later views must not skip effects arriving between polls.
        if (!cursors.current.has(key)) cursors.current.set(key, eventCursor);
        let previous = cache.current.get(key);
        if (
          (latestConversation.historyRevision ?? 0) < (previous?.conversation.historyRevision ?? 0)
        )
          return;
        // Explicit refreshes can precede event polling. Replay only message changes so older
        // loaded pages stay current without discarding their reading position or task records.
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
            for (const event of events) {
              if (
                event.kind === 'messages.changed' &&
                event.seq <= (latestConversation.historyRevision ?? 0)
              )
                previous = applyMessageChange(previous, messageChange(previous, event));
            }
            const nextCursor = events.at(-1)?.seq ?? cursor;
            if (nextCursor <= cursor) break;
            cursor = nextCursor;
          }
        }
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
          lastResourceEdit: lastResourceEdit ?? null,
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
      needsRefresh = true,
      forceEvents = false,
      requested = false;
    const report = (cause: unknown) => {
      if (!disposed && selectedScope.current === scopeKey)
        setError(cause instanceof Error ? cause.message : uiMessage('helpers.m207'));
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
          if (event.kind === 'messages.changed') {
            const view = cache.current.get(conversationId);
            if (view) applyMessageMutation(messageChange(view, event), true);
          }
          if (event.kind === 'illustration-preset.updated')
            window.dispatchEvent(new Event('uimori-illustration-presets-changed'));
          if (event.kind === 'theme.updated')
            window.dispatchEvent(new Event('uimori-themes-changed'));
          if (event.kind === 'font.updated')
            window.dispatchEvent(new Event('uimori-fonts-changed'));
          cursor = event.seq;
          // Diagnostics advance the cursor without reloading unchanged conversation text.
          if (!diagnosticEvent(event.kind)) changed = true;
          if (
            /^task\.(completed|failed|cancelled|interrupted)$/u.test(event.kind) ||
            event.kind === 'artifact.saved' ||
            event.kind === 'settings.updated' ||
            event.kind === 'resource.edit.undone'
          )
            notify = true;
        }
        cursors.current.set(
          conversationId,
          Math.max(cursors.current.get(conversationId) ?? 0, cursor)
        );
        if (page.length < 500 || document.hidden) break;
      }
      if (notify) window.dispatchEvent(new Event('uimori-helper-updated'));
      return changed;
    };
    const poll = async () => {
      if (disposed || document.hidden) return;
      if (polling) {
        requested = true;
        return;
      }
      clearTimeout(timer);
      polling = true;
      const checkEvents = forceEvents;
      forceEvents = false;
      const active = () =>
        cache.current
          .get(scopeKey)
          ?.tasks.some((task) => ['queued', 'running'].includes(task.status));
      try {
        if (!initialized) {
          // A retained cursor owns side effects as well as text: catch up after a hidden panel.
          if (cursors.current.has(conversationId)) await events();
          if (disposed || document.hidden) return;
          await refresh({ id: conversationId });
          initialized = true;
          needsRefresh = false;
        } else if (
          needsRefresh ||
          checkEvents ||
          active() ||
          latestSequence.current === undefined ||
          latestSequence.current > (cursors.current.get(conversationId) ?? 0)
        ) {
          needsRefresh = (await events()) || needsRefresh;
          if (needsRefresh && !disposed && !document.hidden) {
            await refresh({ id: conversationId });
            needsRefresh = false;
          }
        }
        if (!disposed && selectedScope.current === scopeKey) setError('');
      } catch (cause) {
        report(cause);
      } finally {
        polling = false;
        if (!disposed) setLoading(false);
        if (!disposed && !document.hidden)
          timer = setTimeout(() => void poll(), requested ? 0 : active() ? 1200 : 10000);
        requested = false;
      }
    };
    const visible = () => {
      clearTimeout(timer);
      if (!document.hidden) {
        forceEvents = true;
        void poll();
      }
    };
    wake.current = () => void poll();
    const cached = cache.current.get(scopeKey);
    if (cached) {
      cache.current.delete(scopeKey);
      cache.current.set(scopeKey, cached);
    }
    setLoading(!cached);
    setError('');
    void poll();
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('focus', visible);
    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('focus', visible);
    };
  }, [open, scopeKey, conversationId, refresh, applyMessageMutation]);
  useEffect(() => {
    if (open && (running || (latestEventSeq ?? 0) > (cursors.current.get(scopeKey) ?? 0)))
      wake.current();
  }, [open, scopeKey, running, latestEventSeq]);
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
      if (selectedScope.current === scopeKey)
        setError(cause instanceof Error ? cause.message : uiMessage('helpers.m208'));
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
