import { useI18n, message as uiMessage } from './i18n.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { HelperConversation, HelperScope, HelperStatus } from '../core/helper.js';
import { activityChangedEvent, api, ApiError } from './api.js';

export type HelperSession = HelperConversation & {
  title?: string;
  updatedAt?: string;
  activity?: { running: number; queued: number };
  latestEventSeq?: number;
  latestActivityEventSeq?: number;
  lastTaskStatus?: HelperStatus;
  lastActivityAt?: string;
  chatTitle?: string;
  projectId?: string | null;
};
const helperGroupKey = (scope: HelperScope) =>
  scope.kind === 'chat' ? `chat:${scope.chatId}` : 'library';
function read(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function remember(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Selection remains available in the current window.
  }
}
type PendingHelperCreation = {
  request: { scope: HelperScope; requestKey: string; projectId?: string | null };
  storage: Storage;
};
function pendingHelperCreation(
  key: string,
  scope: HelperScope,
  projectId?: string | null
): PendingHelperCreation {
  const local = () => localStorage;
  const session = () => sessionStorage;
  // This tab's fallback request takes precedence over another tab's shared request,
  // even after a reload has made localStorage writable again.
  for (const getStorage of [session, local]) {
    try {
      const storage = getStorage();
      const saved = JSON.parse(storage.getItem(key) ?? 'null') as {
        scope?: HelperScope;
        requestKey?: unknown;
        projectId?: string | null;
      } | null;
      if (
        typeof saved?.requestKey === 'string' &&
        saved.requestKey.length > 0 &&
        JSON.stringify(saved.scope) === JSON.stringify(scope) &&
        (saved.projectId ?? null) === (projectId ?? null)
      )
        return {
          request: { scope, requestKey: saved.requestKey, ...(projectId ? { projectId } : {}) },
          storage,
        };
    } catch {
      // The other store may still hold the pending request.
    }
  }
  const request = { scope, requestKey: crypto.randomUUID(), ...(projectId ? { projectId } : {}) };
  const value = JSON.stringify(request);
  for (const getStorage of [local, session]) {
    try {
      const storage = getStorage();
      storage.setItem(key, value);
      return { request, storage };
    } catch {
      // Never send a new request before its retry key has been stored.
    }
  }
  throw new Error(uiMessage('helpers.m209'));
}
function forgetHelperCreation(key: string, pending: PendingHelperCreation | undefined) {
  try {
    pending?.storage.removeItem(key);
  } catch {
    // A storage cleanup failure must not turn an acknowledged creation into a failure.
  }
}
export function forgetHelperSession(conversation: HelperConversation) {
  for (const key of [
    'uimori:helper-session:all',
    `uimori:helper-session:${helperGroupKey(conversation.scope)}`,
    `uimori:helper-session-scope:${JSON.stringify(conversation.scope)}`,
  ])
    if (read(key) === conversation.id) remember(key, null);
  remember(`uimori:helper-seen:${conversation.id}`, null);
}
export function selectedHelperSession(scope: HelperScope) {
  return read(`uimori:helper-session-scope:${JSON.stringify(scope)}`);
}

/** Session selection belongs to the chat; drafts and event cursors belong to each session. */
export function useHelperSessions(open: boolean, scope: HelperScope, expanded = false) {
  useI18n();
  const group = expanded ? 'all' : helperGroupKey(scope);
  const scopeKey = JSON.stringify(scope);
  const [carried, setCarried] = useState<HelperSession | null>(null);
  const lastScope = useRef(JSON.stringify(scope));
  const [lists, setLists] = useState<Record<string, HelperSession[]>>({});
  const [selected, setSelected] = useState<Record<string, string | null>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const [seen, setSeen] = useState<Record<string, number>>({});
  const versions = useRef(new Map<string, number>());
  const selectionVersions = useRef(new Map<string, number>());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  // The scope each selection was made under. A selection survives until the reader moves to
  // another chat; after that the panel resolves the session belonging to the chat on screen.
  const selectionScopes = useRef(new Map<string, string>());
  const viewedScope = useRef(scopeKey);
  viewedScope.current = scopeKey;
  const alive = useRef(true);
  const createLock = useRef(false);
  const scopeChanged = lastScope.current !== scopeKey;
  if (scopeChanged) {
    lastScope.current = scopeKey;
    if (carried && JSON.stringify(carried.scope) !== scopeKey) setCarried(null);
  }
  const carriedSession =
    scopeChanged && carried && JSON.stringify(carried.scope) !== scopeKey ? null : carried;
  const sessions =
    carriedSession && !(lists[group] ?? []).some((item) => item.id === carriedSession.id)
      ? [carriedSession, ...(lists[group] ?? [])]
      : (lists[group] ?? []);
  const currentId = carriedSession?.id ?? selected[group] ?? null;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const acknowledge = useCallback((ids?: string[]) => {
    const values = sessionsRef.current.filter((item) => !ids || ids.includes(item.id));
    setSeen((old) => {
      const next = { ...old };
      for (const item of values) {
        const sequence = Math.max(
          item.latestActivityEventSeq ?? 0,
          old[item.id] ?? 0,
          Number(read(`uimori:helper-seen:${item.id}`) ?? 0)
        );
        remember(`uimori:helper-seen:${item.id}`, String(sequence));
        next[item.id] = sequence;
      }
      return next;
    });
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const select = useCallback(
    (conversation: HelperConversation, markRead = true) => {
      if (markRead) acknowledge([conversation.id]);
      const key = helperGroupKey(conversation.scope);
      setCarried(conversation);
      selectionVersions.current.set(key, (selectionVersions.current.get(key) ?? 0) + 1);
      selectionVersions.current.set('all', (selectionVersions.current.get('all') ?? 0) + 1);
      selectionScopes.current.set(key, viewedScope.current);
      remember(`uimori:helper-session:${key}`, conversation.id);
      remember('uimori:helper-session:all', conversation.id);
      remember(
        `uimori:helper-session-scope:${JSON.stringify(conversation.scope)}`,
        conversation.id
      );
      selectedRef.current = {
        ...selectedRef.current,
        [key]: conversation.id,
        all: conversation.id,
      };
      setSelected(selectedRef.current);
      setLists((old) => ({
        ...old,
        [key]: [conversation, ...(old[key] ?? []).filter((item) => item.id !== conversation.id)],
      }));
      window.dispatchEvent(
        new CustomEvent('uimori-helper-session-selected', { detail: conversation })
      );
    },
    [acknowledge]
  );
  const reload = useCallback(async () => {
    const version = (versions.current.get(group) ?? 0) + 1;
    versions.current.set(group, version);
    const target = JSON.parse(scopeKey) as HelperScope;
    const query = expanded
      ? 'kind=all'
      : target.kind === 'chat'
        ? `kind=chat&chatId=${encodeURIComponent(target.chatId)}`
        : 'kind=library';
    const values = await api<HelperSession[]>(`/helper/conversations?${query}`);
    if (!alive.current || versions.current.get(group) !== version) return;
    const active = values.some((session) => session.activity?.running || session.activity?.queued);
    setLists((old) => ({ ...old, [group]: values }));
    if (carried) return active;
    const moved =
      selectionScopes.current.has(group) && selectionScopes.current.get(group) !== scopeKey;
    const saved = moved
      ? read(`uimori:helper-session-scope:${scopeKey}`)
      : (selectedRef.current[group] ?? read(`uimori:helper-session:${group}`));
    const chosen =
      values.find((item) => item.id === saved) ??
      values.find((item) => JSON.stringify(item.scope) === scopeKey);
    if (chosen) {
      if (selectedRef.current[group] !== chosen.id) select(chosen, false);
      return active;
    }
    const selectionVersion = selectionVersions.current.get(group) ?? 0;
    const created = await api<HelperConversation>('/helper/conversations', {
      scope: expanded ? { kind: 'library', workId: 'workspace' } : target,
    });
    if (alive.current && versions.current.get(group) === version) {
      if ((selectionVersions.current.get(group) ?? 0) === selectionVersion) select(created);
      else
        setLists((old) => ({
          ...old,
          [group]: [...(old[group] ?? []).filter((item) => item.id !== created.id), created],
        }));
    }
    return active;
  }, [group, scopeKey, select, expanded, carried]);
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let polling = false;
    let requested = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (disposed || document.hidden) return;
      if (polling) {
        requested = true;
        return;
      }
      clearTimeout(timer);
      polling = true;
      let active = false;
      try {
        active = (await reload()) ?? false;
      } catch (cause) {
        if (!disposed)
          setErrors((old) => ({
            ...old,
            [group]: cause instanceof Error ? cause.message : uiMessage('helpers.m210'),
          }));
      } finally {
        polling = false;
        if (!disposed && !document.hidden)
          timer = setTimeout(() => void poll(), requested ? 0 : active ? 2400 : 10000);
        requested = false;
      }
    };
    const visible = () => {
      clearTimeout(timer);
      void poll();
    };
    const submitted = (event: Event) => {
      if ((event as CustomEvent<string>).detail.startsWith('/helper/')) visible();
    };
    void poll();
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('focus', visible);
    window.addEventListener(activityChangedEvent, submitted);
    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('focus', visible);
      window.removeEventListener(activityChangedEvent, submitted);
      versions.current.set(group, (versions.current.get(group) ?? 0) + 1);
    };
  }, [open, group, reload]);
  const unread = sessions
    .filter(
      (item) =>
        (item.latestActivityEventSeq ?? 0) >
        (seen[item.id] ?? Number(read(`uimori:helper-seen:${item.id}`) ?? 0))
    )
    .map((item) => item.id);
  const create = async (projectId?: string | null) => {
    if (createLock.current) return;
    createLock.current = true;
    setCreating(true);
    setErrors((old) => ({ ...old, [group]: '' }));
    const creationScope: HelperScope = expanded ? { kind: 'library', workId: 'workspace' } : scope;
    const key = `uimori:helper-create:${JSON.stringify(creationScope)}${projectId ? `:project:${projectId}` : ''}`;
    const selectionVersion = selectionVersions.current.get(group) ?? 0;
    let pending: PendingHelperCreation | undefined;
    try {
      pending = pendingHelperCreation(key, creationScope, projectId);
      const value = await api<HelperConversation>('/helper/conversations/new', pending.request);
      forgetHelperCreation(key, pending);
      versions.current.set(group, (versions.current.get(group) ?? 0) + 1);
      if (alive.current) {
        if ((selectionVersions.current.get(group) ?? 0) === selectionVersion) select(value);
        else
          setLists((old) => ({
            ...old,
            [group]: [...(old[group] ?? []).filter((item) => item.id !== value.id), value],
          }));
      }
      return value;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status < 500 && ![408, 429].includes(cause.status))
        forgetHelperCreation(key, pending);
      if (alive.current)
        setErrors((old) => ({
          ...old,
          [group]: cause instanceof Error ? cause.message : uiMessage('helpers.m211'),
        }));
    } finally {
      createLock.current = false;
      if (alive.current) setCreating(false);
    }
  };
  return {
    sessions,
    unread,
    currentId,
    select,
    acknowledge,
    create,
    creating,
    reload,
    update: (conversation: HelperConversation) => {
      setLists((old) =>
        Object.fromEntries(
          Object.entries(old).map(([key, list]) => [
            key,
            list.map((item) => (item.id === conversation.id ? { ...item, ...conversation } : item)),
          ])
        )
      );
      setCarried((old) => (old?.id === conversation.id ? { ...old, ...conversation } : old));
    },
    remove: (id: string) => {
      setLists((old) =>
        Object.fromEntries(
          Object.entries(old).map(([key, list]) => [key, list.filter((item) => item.id !== id)])
        )
      );
      setCarried((old) => (old?.id === id ? null : old));
      selectedRef.current = Object.fromEntries(
        Object.entries(selectedRef.current).map(([key, value]) => [
          key,
          value === id ? null : value,
        ])
      );
      setSelected(selectedRef.current);
    },
    error: errors[group] ?? '',
    clearSelection: () => {
      setCarried(null);
      selectedRef.current = { ...selectedRef.current, [group]: null };
      setSelected(selectedRef.current);
    },
    clearError: () => setErrors((old) => ({ ...old, [group]: '' })),
  };
}
