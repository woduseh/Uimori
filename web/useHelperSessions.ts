import { useCallback, useEffect, useRef, useState } from 'react';
import type { HelperConversation, HelperScope } from '../core/helper.js';
import { activityChangedEvent, api, ApiError } from './api.js';

export type HelperSession = HelperConversation & {
  title?: string;
  updatedAt?: string;
  activity?: { running: number; queued: number };
  latestEventSeq?: number;
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
  request: { scope: HelperScope; requestKey: string };
  storage: Storage;
};
function pendingHelperCreation(key: string, scope: HelperScope): PendingHelperCreation {
  const stores = [() => localStorage, () => sessionStorage];
  // Restore before choosing where to write: a fallback request must survive a reload,
  // even if localStorage has become writable in the meantime.
  for (const getStorage of stores) {
    try {
      const storage = getStorage();
      const saved = JSON.parse(storage.getItem(key) ?? 'null') as {
        scope?: HelperScope;
        requestKey?: unknown;
      } | null;
      if (
        typeof saved?.requestKey === 'string' &&
        saved.requestKey.length > 0 &&
        JSON.stringify(saved.scope) === JSON.stringify(scope)
      )
        return { request: { scope, requestKey: saved.requestKey }, storage };
    } catch {
      // The other store may still hold the pending request.
    }
  }
  const request = { scope, requestKey: crypto.randomUUID() };
  const value = JSON.stringify(request);
  for (const getStorage of stores) {
    try {
      const storage = getStorage();
      storage.setItem(key, value);
      return { request, storage };
    } catch {
      // Never send a new request before its retry key has been stored.
    }
  }
  throw new Error(
    '브라우저에 대화 생성 요청을 보관하지 못했어요. 저장 공간이나 사이트 저장소 설정을 확인한 뒤 다시 시도해 주세요.'
  );
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
export function useHelperSessions(open: boolean, scope: HelperScope) {
  const group = helperGroupKey(scope);
  const scopeKey = JSON.stringify(scope);
  const [lists, setLists] = useState<Record<string, HelperSession[]>>({});
  const [selected, setSelected] = useState<Record<string, string | null>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const [branching, setBranching] = useState(false);
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
  const branchLock = useRef(false);
  const sessions = lists[group] ?? [];
  const currentId = selected[group] ?? null;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const select = useCallback((conversation: HelperConversation) => {
    const key = helperGroupKey(conversation.scope);
    selectionVersions.current.set(key, (selectionVersions.current.get(key) ?? 0) + 1);
    selectionScopes.current.set(key, viewedScope.current);
    remember(`uimori:helper-session:${key}`, conversation.id);
    remember(`uimori:helper-session-scope:${JSON.stringify(conversation.scope)}`, conversation.id);
    selectedRef.current = { ...selectedRef.current, [key]: conversation.id };
    setSelected(selectedRef.current);
    setLists((old) => ({
      ...old,
      [key]: [conversation, ...(old[key] ?? []).filter((item) => item.id !== conversation.id)],
    }));
    window.dispatchEvent(
      new CustomEvent('uimori-helper-session-selected', { detail: conversation })
    );
  }, []);
  const reload = useCallback(async () => {
    const version = (versions.current.get(group) ?? 0) + 1;
    versions.current.set(group, version);
    const target = JSON.parse(scopeKey) as HelperScope;
    const query =
      target.kind === 'chat'
        ? `kind=chat&chatId=${encodeURIComponent(target.chatId)}`
        : 'kind=library';
    const values = await api<HelperSession[]>(`/helper/conversations?${query}`);
    if (!alive.current || versions.current.get(group) !== version) return;
    const active = values.some((session) => session.activity?.running || session.activity?.queued);
    setLists((old) => ({ ...old, [group]: values }));
    const moved =
      selectionScopes.current.has(group) && selectionScopes.current.get(group) !== scopeKey;
    const saved = moved
      ? read(`uimori:helper-session-scope:${scopeKey}`)
      : (selectedRef.current[group] ?? read(`uimori:helper-session:${group}`));
    const chosen =
      values.find((item) => item.id === saved) ??
      values.find((item) => JSON.stringify(item.scope) === scopeKey);
    if (chosen) {
      if (selectedRef.current[group] !== chosen.id) select(chosen);
      return active;
    }
    const selectionVersion = selectionVersions.current.get(group) ?? 0;
    const created = await api<HelperConversation>('/helper/conversations', { scope: target });
    if (alive.current && versions.current.get(group) === version) {
      if ((selectionVersions.current.get(group) ?? 0) === selectionVersion) select(created);
      else
        setLists((old) => ({
          ...old,
          [group]: [...(old[group] ?? []).filter((item) => item.id !== created.id), created],
        }));
    }
    return active;
  }, [group, scopeKey, select]);
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
            [group]: cause instanceof Error ? cause.message : '세션을 불러오지 못했어요.',
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
  const selectedSequence = sessions.find((item) => item.id === currentId)?.latestEventSeq ?? 0;
  useEffect(() => {
    if (!open || !currentId) return;
    const mark = () => {
      if (document.hidden) return;
      const sequence = Math.max(
        selectedSequence,
        Number(read(`uimori:helper-seen:${currentId}`) ?? 0)
      );
      remember(`uimori:helper-seen:${currentId}`, String(sequence));
      setSeen((old) => (old[currentId] === sequence ? old : { ...old, [currentId]: sequence }));
    };
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [open, currentId, selectedSequence]);
  const unread = sessions
    .filter(
      (item) =>
        item.id !== currentId &&
        (item.latestEventSeq ?? 0) >
          (seen[item.id] ?? Number(read(`uimori:helper-seen:${item.id}`) ?? 0))
    )
    .map((item) => item.id);
  const create = async () => {
    if (createLock.current) return;
    createLock.current = true;
    setCreating(true);
    setErrors((old) => ({ ...old, [group]: '' }));
    const key = `uimori:helper-create:${scopeKey}`;
    const selectionVersion = selectionVersions.current.get(group) ?? 0;
    let pending: PendingHelperCreation | undefined;
    try {
      pending = pendingHelperCreation(key, scope);
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
    } catch (cause) {
      if (cause instanceof ApiError && cause.status < 500 && ![408, 429].includes(cause.status))
        forgetHelperCreation(key, pending);
      if (alive.current)
        setErrors((old) => ({
          ...old,
          [group]: cause instanceof Error ? cause.message : '세션을 만들지 못했어요.',
        }));
    } finally {
      createLock.current = false;
      if (alive.current) setCreating(false);
    }
  };
  const branch = async () => {
    if (branchLock.current || !currentId) return;
    branchLock.current = true;
    setBranching(true);
    setErrors((old) => ({ ...old, [group]: '' }));
    const key = `uimori:helper-branch:${currentId}`;
    const selectionVersion = selectionVersions.current.get(group) ?? 0;
    const originalScope = viewedScope.current;
    try {
      const request = JSON.parse(read(key) ?? 'null') ?? { requestKey: crypto.randomUUID() };
      remember(key, JSON.stringify(request));
      const value = await api<HelperConversation>(
        `/helper/conversations/${encodeURIComponent(currentId)}/branch`,
        request
      );
      remember(key, null);
      // A delayed branch must not steal selection after the user opens another session/tab.
      if (
        alive.current &&
        viewedScope.current === originalScope &&
        (selectionVersions.current.get(group) ?? 0) === selectionVersion
      )
        select(value);
      void reload().catch(() => {});
    } catch (cause) {
      if (cause instanceof ApiError && cause.status < 500 && ![408, 429].includes(cause.status))
        remember(key, null);
      setErrors((old) => ({
        ...old,
        [group]: cause instanceof Error ? cause.message : '세션 분기에 실패했어요.',
      }));
    } finally {
      branchLock.current = false;
      setBranching(false);
    }
  };
  return {
    sessions,
    unread,
    currentId,
    select,
    create,
    creating,
    branch,
    branching,
    reload,
    error: errors[group] ?? '',
    clearError: () => setErrors((old) => ({ ...old, [group]: '' })),
  };
}
