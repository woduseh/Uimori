import { parseOwnJson } from './json.js';
import { useI18n, message as uiMessage } from './i18n.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { HelperConversation, HelperScope, HelperStatus } from '../core/helper.js';
import { api, ApiError } from './api.js';
import { watchLive } from './live-stream.js';
import { helperPollDelay, helperRefreshSpacing } from './poll-delays.js';
import { helperSessionsFrame } from './live-frames.js';
import {
  clearPendingHelperRequest,
  pendingHelperRequest,
  type PendingHelperRequest,
} from './helper-pending-request.js';
import {
  readOptionalStorage,
  removeOptionalStorage,
  writeOptionalStorage,
} from './optional-storage.js';
import { listedHelperSessions } from './helper-navigation-model.js';
import { storageKeys } from './storage-keys.js';

export type HelperSession = HelperConversation & {
  title?: string;
  updatedAt?: string;
  activity?: { running: number; queued: number };
  latestEventSeq?: number;
  latestActivityEventSeq?: number;
  readActivityEventSeq?: number;
  lastTaskStatus?: HelperStatus;
  lastActivityAt?: string;
  chatTitle?: string;
  projectId?: string | null;
  unused?: true;
};
const helperGroupKey = (scope: HelperScope) =>
  scope.kind === 'chat' ? `chat:${scope.chatId}` : 'library';
function read(key: string) {
  return readOptionalStorage('local', key);
}
function remember(key: string, value: string | null) {
  if (value === null) removeOptionalStorage('local', key);
  else writeOptionalStorage('local', key, value);
}
const openedSessions = new Set<string>();
const localReadKey = storageKeys.helperSeen;
const localRead = (id: string) => Number(read(localReadKey(id)) ?? 0);
type HelperCreationRequest = { scope: HelperScope; requestKey: string; projectId?: string | null };
export function forgetHelperSession(conversation: HelperConversation) {
  for (const key of [
    storageKeys.helperSession('all'),
    storageKeys.helperSession(helperGroupKey(conversation.scope)),
    storageKeys.helperSessionScope(JSON.stringify(conversation.scope)),
  ])
    if (read(key) === conversation.id) remember(key, null);
  remember(localReadKey(conversation.id), null);
  openedSessions.delete(conversation.id);
}
export function selectedHelperSession(scope: HelperScope) {
  return read(storageKeys.helperSessionScope(JSON.stringify(scope)));
}

export function useHelperSessions(
  open: boolean,
  scope: HelperScope,
  expanded = false,
  selectionEpoch?: { current: number }
) {
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
  const currentId = carriedSession?.id ?? selected[group] ?? null;
  const sessions = listedHelperSessions(
    carriedSession && !(lists[group] ?? []).some((item) => item.id === carriedSession.id)
      ? [carriedSession, ...(lists[group] ?? [])]
      : (lists[group] ?? []),
    scope,
    openedSessions
  );
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const confirmedReads = useRef(new Map<string, number>());
  const readWrites = useRef(new Map<string, number>());
  const mergedLocalReads = useRef(new Set<string>());
  const raiseSeen = useCallback((id: string, sequence: number) => {
    setSeen((old) => ((old[id] ?? 0) >= sequence ? old : { ...old, [id]: sequence }));
  }, []);
  const saveRead = useCallback(
    (id: string, sequence: number) => {
      if ((readWrites.current.get(id) ?? 0) >= sequence) return;
      readWrites.current.set(id, sequence);
      api<{ readActivityEventSeq: number }>(
        `/helper/conversations/${encodeURIComponent(id)}/read`,
        { activityEventSeq: sequence }
      )
        .then((result) => {
          confirmedReads.current.set(
            id,
            Math.max(confirmedReads.current.get(id) ?? 0, result.readActivityEventSeq)
          );
          if (localRead(id) <= result.readActivityEventSeq) remember(localReadKey(id), null);
          if (alive.current) raiseSeen(id, result.readActivityEventSeq);
        })
        .catch(() => {})
        .finally(() => {
          if (readWrites.current.get(id) === sequence) readWrites.current.delete(id);
        });
    },
    [raiseSeen]
  );
  const acknowledge = useCallback(
    (ids?: string[]) => {
      for (const item of sessionsRef.current.filter((item) => !ids || ids.includes(item.id))) {
        const known = Math.max(
          item.readActivityEventSeq ?? 0,
          confirmedReads.current.get(item.id) ?? 0
        );
        const sequence = Math.max(item.latestActivityEventSeq ?? 0, localRead(item.id), known);
        raiseSeen(item.id, sequence);
        if (sequence <= known) continue;
        remember(localReadKey(item.id), String(sequence));
        saveRead(item.id, sequence);
      }
    },
    [raiseSeen, saveRead]
  );
  const mergeLocalReads = useCallback(
    (values: HelperSession[]) => {
      for (const item of values) {
        if (mergedLocalReads.current.has(item.id)) continue;
        mergedLocalReads.current.add(item.id);
        const local = localRead(item.id);
        if (!local) continue;
        if (local > (item.readActivityEventSeq ?? 0)) saveRead(item.id, local);
        else remember(localReadKey(item.id), null);
      }
    },
    [saveRead]
  );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const select = useCallback(
    (conversation: HelperConversation, markRead = true) => {
      if (markRead) acknowledge([conversation.id]);
      openedSessions.add(conversation.id);
      const key = helperGroupKey(conversation.scope);
      setCarried(conversation);
      selectionVersions.current.set(key, (selectionVersions.current.get(key) ?? 0) + 1);
      selectionVersions.current.set('all', (selectionVersions.current.get('all') ?? 0) + 1);
      selectionScopes.current.set(key, viewedScope.current);
      remember(storageKeys.helperSession(key), conversation.id);
      remember(storageKeys.helperSession('all'), conversation.id);
      remember(storageKeys.helperSessionScope(JSON.stringify(conversation.scope)), conversation.id);
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
    },
    [acknowledge]
  );
  const reload = useCallback(async () => {
    const version = (versions.current.get(group) ?? 0) + 1;
    versions.current.set(group, version);
    const target = parseOwnJson(scopeKey) as HelperScope;
    const query = expanded
      ? 'kind=all'
      : target.kind === 'chat'
        ? `kind=chat&chatId=${encodeURIComponent(target.chatId)}`
        : 'kind=library';
    const values = await api<HelperSession[]>(`/helper/conversations?${query}`);
    if (!alive.current || versions.current.get(group) !== version) return;
    const active = values.some((session) => session.activity?.running || session.activity?.queued);
    setLists((old) => ({ ...old, [group]: values }));
    mergeLocalReads(values);
    if (carried) return active;
    const moved =
      selectionScopes.current.has(group) && selectionScopes.current.get(group) !== scopeKey;
    const saved = moved
      ? read(storageKeys.helperSessionScope(scopeKey))
      : (selectedRef.current[group] ?? read(storageKeys.helperSession(group)));
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
  }, [group, scopeKey, select, expanded, carried, mergeLocalReads]);
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let active = false;
    const live = watchLive({
      match: (frame) =>
        helperSessionsFrame(frame, {
          chatTitles: expanded,
          chatIds: () =>
            sessionsRef.current.flatMap((item) =>
              item.scope.kind === 'chat' ? [item.scope.chatId] : []
            ),
        }),
      refresh: async () => {
        try {
          active = (await reload()) ?? false;
        } catch (cause) {
          if (!disposed)
            setErrors((old) => ({
              ...old,
              [group]: cause instanceof Error ? cause.message : uiMessage('helpers.m210'),
            }));
          throw cause;
        }
      },
      fallbackMs: () => (active ? helperPollDelay.sessions.active : helperPollDelay.sessions.idle),
      minIntervalMs: helperRefreshSpacing,
    });
    live.request();
    return () => {
      disposed = true;
      live.dispose();
      versions.current.set(group, (versions.current.get(group) ?? 0) + 1);
    };
  }, [open, group, reload, expanded]);
  const unread = sessions
    .filter(
      (item) =>
        (item.latestActivityEventSeq ?? 0) >
        Math.max(item.readActivityEventSeq ?? 0, seen[item.id] ?? 0, localRead(item.id))
    )
    .map((item) => item.id);
  const create = async (projectId?: string | null) => {
    if (createLock.current) return;
    createLock.current = true;
    setCreating(true);
    setErrors((old) => ({ ...old, [group]: '' }));
    const creationScope: HelperScope = expanded ? { kind: 'library', workId: 'workspace' } : scope;
    const key = storageKeys.helperCreate(
      `${JSON.stringify(creationScope)}${projectId ? `:project:${projectId}` : ''}`
    );
    const selectionVersion = selectionVersions.current.get(group) ?? 0;
    const epoch = selectionEpoch?.current;
    let pending: PendingHelperRequest<HelperCreationRequest> | undefined;
    try {
      pending = pendingHelperRequest<HelperCreationRequest>(
        key,
        () => ({
          scope: creationScope,
          requestKey: crypto.randomUUID(),
          ...(projectId ? { projectId } : {}),
        }),
        (value): value is HelperCreationRequest => {
          if (!value || typeof value !== 'object') return false;
          const saved = value as Partial<HelperCreationRequest>;
          return (
            typeof saved.requestKey === 'string' &&
            saved.requestKey.length > 0 &&
            JSON.stringify(saved.scope) === JSON.stringify(creationScope) &&
            (saved.projectId ?? null) === (projectId ?? null)
          );
        }
      );
      const request = {
        scope: creationScope,
        requestKey: pending.request.requestKey,
        ...(projectId ? { projectId } : {}),
      };
      const value = await api<HelperConversation>('/helper/conversations/new', request);
      clearPendingHelperRequest(key, pending);
      versions.current.set(group, (versions.current.get(group) ?? 0) + 1);
      if (alive.current) {
        if (
          (selectionVersions.current.get(group) ?? 0) === selectionVersion &&
          selectionEpoch?.current === epoch
        )
          select(value);
        else
          setLists((old) => ({
            ...old,
            [group]: [...(old[group] ?? []).filter((item) => item.id !== value.id), value],
          }));
      }
      return value;
    } catch (cause) {
      if (
        pending &&
        !pending.recovered &&
        cause instanceof ApiError &&
        cause.status < 500 &&
        ![408, 429].includes(cause.status)
      )
        clearPendingHelperRequest(key, pending);
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
