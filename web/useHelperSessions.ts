import { useCallback, useEffect, useRef, useState } from 'react';
import type { HelperConversation, HelperScope } from '../core/helper.js';
import { api, ApiError } from './api.js';

export type HelperSession = HelperConversation & {
  title?: string;
  updatedAt?: string;
  activity?: { running: number; queued: number };
  latestEventSeq?: number;
};
export const helperGroupKey = (scope: HelperScope) =>
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
  const [seen, setSeen] = useState<Record<string, number>>({});
  const versions = useRef(new Map<string, number>());
  const selectionVersions = useRef(new Map<string, number>());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const alive = useRef(true);
  const createLock = useRef(false);
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
    setLists((old) => ({ ...old, [group]: values }));
    const saved = selectedRef.current[group] ?? read(`uimori:helper-session:${group}`);
    const chosen =
      values.find((item) => item.id === saved) ??
      values.find((item) => JSON.stringify(item.scope) === scopeKey);
    if (chosen) {
      if (selectedRef.current[group] !== chosen.id) select(chosen);
      return;
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
  }, [group, scopeKey, select]);
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (!document.hidden) await reload();
      } catch (cause) {
        if (!disposed)
          setErrors((old) => ({
            ...old,
            [group]: cause instanceof Error ? cause.message : '세션을 불러오지 못했어요.',
          }));
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), document.hidden ? 10000 : 2400);
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
      versions.current.set(group, (versions.current.get(group) ?? 0) + 1);
    };
  }, [open, group, reload]);
  const selectedSequence = sessions.find((item) => item.id === currentId)?.latestEventSeq ?? 0;
  useEffect(() => {
    if (!open || !currentId || document.hidden) return;
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
    try {
      let request: { scope: HelperScope; requestKey: string };
      try {
        request = JSON.parse(read(key) ?? 'null') ?? { scope, requestKey: crypto.randomUUID() };
      } catch {
        request = { scope, requestKey: crypto.randomUUID() };
      }
      // An uncertain create must reuse the same key after a reload.
      localStorage.setItem(key, JSON.stringify(request));
      const value = await api<HelperConversation>('/helper/conversations/new', request);
      remember(key, null);
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
        remember(key, null);
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
  return {
    sessions,
    unread,
    currentId,
    select,
    create,
    creating,
    reload,
    error: errors[group] ?? '',
    clearError: () => setErrors((old) => ({ ...old, [group]: '' })),
  };
}
