import { readerConversation } from '../core/reader-conversation.js';
import { createReaderSync } from './reader-sync.js';
import {
  transitionReaderNavigation,
  type ReaderNavigation,
  type ReaderNavigationAction,
} from './reader-navigation.js';
import {
  commandStorageKey,
  readReadingPosition,
  readDraftCursor,
  type ReadingPosition,
} from './story-storage.js';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { subscribeAppHistory } from './app-history.js';
import type { Chat, ReaderDetail, Run } from '../core/types.js';
import type { Content, CurrentPrompt, Library } from '../core/product.js';
import type { ChatOptionState } from '../core/chat-options.js';
import { api, ApiError, definiteRejection, libraryChangedKey } from './api.js';
import { requestChatFork } from './fork-request.js';
import { usePromptWorkspace } from './usePromptWorkspace.js';
import { combinationOwner, matchesPromptCombination } from '../core/prompt-combinations.js';
import { refValue } from './content-ref.js';
import {
  retainReaderNavigation,
  type ReaderNavigationPosition,
} from './reader-navigation-scroll.js';

const lastWorkspaceKey = 'uimori:last-workspace';
function initialView(restore = false) {
  const params = new URLSearchParams(location.search);
  let chat = params.get('chat') || '';
  if (restore && !location.search && !location.hash) {
    try {
      const saved = JSON.parse(localStorage.getItem(lastWorkspaceKey) || 'null');
      if (saved?.destination === 'story' && typeof saved.chatId === 'string') chat = saved.chatId;
    } catch {
      // Storage is optional; an unavailable or invalid workspace starts in the library.
    }
  }
  return {
    chat,
    branch: params.get('branch') || '',
    source: params.get('source') || '',
    destination:
      chat && params.get('workspace') !== 'library' ? ('story' as const) : ('library' as const),
  };
}
type RunPayload = {
  retryOf?: string;
  judgmentRecovery?: true;
  editedRequest?: boolean;
  loreContextReset?: boolean;
  request: string;
  expectedRevision: string | null;
  expectedSettingsRevision: number;
  branchId?: string;
  expectedProfileRevision?: number;
};
type PendingCommand = { payload: string; id: string; preserveDraft?: boolean; startedAt?: string };
export type RequestActivity = {
  id: string;
  startedAt: string;
  runId?: string;
  status: 'sending' | 'accepted' | 'uncertain' | 'failed';
};
function readCommand(key: string): { record: PendingCommand; payload: RunPayload } | null {
  try {
    const record = JSON.parse(sessionStorage.getItem(key) || 'null') as PendingCommand | null;
    if (
      !record ||
      typeof record.id !== 'string' ||
      !record.id ||
      typeof record.payload !== 'string'
    )
      return null;
    const payload = JSON.parse(record.payload) as RunPayload;
    if (
      !payload ||
      typeof payload.request !== 'string' ||
      !payload.request.trim() ||
      !(payload.expectedRevision === null || typeof payload.expectedRevision === 'string') ||
      !Number.isInteger(payload.expectedSettingsRevision)
    )
      return null;
    if (
      (payload.branchId !== undefined && typeof payload.branchId !== 'string') ||
      (payload.expectedProfileRevision !== undefined &&
        !Number.isInteger(payload.expectedProfileRevision))
    )
      return null;
    if (
      payload.judgmentRecovery !== undefined &&
      (payload.judgmentRecovery !== true || !payload.retryOf || payload.editedRequest)
    )
      return null;
    if (payload.retryOf !== undefined && (typeof payload.retryOf !== 'string' || !payload.retryOf))
      return null;
    if (payload.editedRequest !== undefined && (payload.editedRequest !== true || !payload.retryOf))
      return null;
    if (payload.loreContextReset !== undefined && typeof payload.loreContextReset !== 'boolean')
      return null;
    return { record, payload };
  } catch {
    return null;
  }
}
function clearCommand(key: string, id: string) {
  if (readCommand(key)?.record.id === id) sessionStorage.removeItem(key);
}

type Position = ReadingPosition;
export function useStory() {
  const { workspace: promptWorkspace } = usePromptWorkspace();
  const [initial] = useState(() => initialView(true));
  const [chats, setChats] = useState<Chat[]>([]);
  const [view, setView] = useState<ReaderNavigation>(() => ({ ...initial, epoch: 0 }));
  const navigation = useRef(view);
  const { chat: selected, branch: viewedBranch, source: readSource, destination } = view;
  const [loadedDetail, setDetail] = useState<ReaderDetail | null>(null);
  const [library, setLibrary] = useState<Library | null>(null);
  const [libraryError, setLibraryError] = useState('');
  const detail = loadedDetail?.chat.id === selected ? loadedDetail : null;
  const [archivedContents, setArchivedContents] = useState<Content[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loreResetDraft, setLoreResetDraft] = useState(false);
  const [submitting, setSubmitting] = useState<string[]>([]);
  const submitLocks = useRef(new Set<string>());
  const [requestActivities, setRequestActivities] = useState<Record<string, RequestActivity>>({});
  const [connected, setConnected] = useState(false);
  const [profileDirty, setProfileDirty] = useState(false);
  const [quickBusy, setQuickBusy] = useState(false);
  useEffect(() => {
    if (destination === 'story' && (!selected || !detail)) return;
    try {
      localStorage.setItem(
        lastWorkspaceKey,
        JSON.stringify({
          destination,
          chatId: destination === 'story' ? selected : null,
        })
      );
    } catch {
      // Restoring the last workspace must not be required to read or edit a chat.
    }
  }, [destination, selected, detail]);
  useEffect(() => {
    if (initial.chat && !location.search && !location.hash)
      history.replaceState(null, '', `?${new URLSearchParams({ chat: initial.chat })}`);
  }, [initial]);
  const reader = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const currentView = useRef('');
  const currentDraftKey = useRef('');
  const refreshVersion = useRef(0);
  const restoredView = useRef('');
  const cancelNavigationScroll = useRef<(() => void) | null>(null);
  const latestIntent = useRef<{ epoch: number; source: string } | null>(null);
  const readerQuery = useRef({ chat: '', branch: '', source: '', key: '', epoch: 0 });
  const readerCache = useRef<{ key: string; detail: ReaderDetail } | null>(null);
  // Bind an implicit default to the branch actually opened. Later default changes must not
  // retarget reading, drafts, or an in-flight request in this viewing session.
  const defaultView = useRef<{ chatId: string; branchId: string } | null>(null);
  const navigate = useCallback((action: ReaderNavigationAction) => {
    const previous = navigation.current;
    const next = transitionReaderNavigation(previous, action);
    // Publish intent synchronously: an HTTP response can settle before React renders again.
    navigation.current = next;
    if (next.epoch !== previous.epoch) {
      restoredView.current = '';
      if (action.kind !== 'source' && action.kind !== 'library') defaultView.current = null;
    }
    setView(next);
  }, []);
  if (!viewedBranch && detail && defaultView.current?.chatId !== selected) {
    const opened = detail.branches?.find((item) => item.default);
    if (opened) defaultView.current = { chatId: selected, branchId: opened.id };
  }
  const activeBranchId =
    viewedBranch || (defaultView.current?.chatId === selected ? defaultView.current.branchId : '');
  // Keep the initial branch's existing storage address; every other branch uses its own ID.
  // This identity is stable when either branch gains or loses the default flag.
  const storageBranch = activeBranchId === `main:${selected}` ? '' : activeBranchId;
  const preserveDefaultView = useRef<(branchId: string) => void>(() => {});
  preserveDefaultView.current = (branchId) => {
    if (viewedBranch || navigation.current.chat !== selected) return;
    navigate({ kind: 'bind-default', branch: branchId });
    const url = new URL(location.href);
    url.searchParams.set('branch', branchId);
    history.replaceState(null, '', url);
  };
  const savedPosition = readReadingPosition(`reading:${selected}:${storageBranch}`);
  readerQuery.current = {
    chat: selected,
    epoch: view.epoch,
    branch: activeBranchId,
    source:
      !activeBranchId && !readSource
        ? ''
        : (savedPosition?.target === readSource ? savedPosition?.source : readSource) ||
          savedPosition?.source ||
          '',
    key: `${selected}:${activeBranchId}:${readSource}`,
  };
  const refresh = useCallback(
    async (id: string, incremental = false) => {
      if (
        navigation.current.chat !== id ||
        readerQuery.current.chat !== id ||
        readerQuery.current.epoch !== navigation.current.epoch
      )
        return;
      const version = ++refreshVersion.current;
      const epoch = navigation.current.epoch;
      const query = readerQuery.current;
      const cached = readerCache.current?.key === query.key ? readerCache.current.detail : null;
      const params = new URLSearchParams({
        branch: query.branch,
        source: cached?.reader?.order[0] || query.source,
      });
      if (incremental && cached?.reader) {
        params.set('since', String(cached.reader.cursor));
        params.set('known', cached.reader.order.join(','));
      }
      let value: ReaderDetail;
      let replacementSource: string | undefined;
      try {
        value = await api<ReaderDetail>(`/chats/${id}/reader?${params}`);
      } catch (error) {
        // Native card actions replace an immutable suffix. An SSE refresh can arrive
        // before the action response, while this page still names the old source.
        // Only rebase a page we already read; invalid explicit navigation stays an error.
        if (!cached || !(error instanceof ApiError) || error.status !== 404) throw error;
        if (
          navigation.current.chat !== id ||
          navigation.current.epoch !== epoch ||
          readerQuery.current.key !== query.key
        )
          return;
        const rebasedParams = new URLSearchParams({ branch: query.branch });
        value = await api<ReaderDetail>(`/chats/${id}/reader?${rebasedParams}`);
        replacementSource =
          value.reader.navigation[Math.min(cached.reader.start, value.reader.navigation.length - 1)]
            ?.id ?? '';
        if (replacementSource && !value.reader.order.includes(replacementSource)) {
          rebasedParams.set('source', replacementSource);
          value = await api<ReaderDetail>(`/chats/${id}/reader?${rebasedParams}`);
        }
      }
      if (
        navigation.current.chat === id &&
        navigation.current.epoch === epoch &&
        readerQuery.current.key === query.key &&
        refreshVersion.current === version
      ) {
        const nextDefault = value.branches?.find((item) => item.default);
        if (query.branch && nextDefault && nextDefault.id !== query.branch)
          preserveDefaultView.current(query.branch);
        const changed = new Set(value.sources.map((source) => source.id));
        const available = new Map(
          [...(cached?.sources ?? []), ...value.sources].map((source) => [source.id, source])
        );
        const merged = {
          ...value,
          assets: value.assets ?? cached?.assets ?? [],
          sources: value.reader!.order.map((id) => available.get(id)!).filter(Boolean),
          jobs: [
            ...(cached?.jobs ?? []).filter(
              (job) =>
                !changed.has(job.sourceRevision) && value.reader!.order.includes(job.sourceRevision)
            ),
            ...value.jobs,
          ],
          illustrations: [
            ...(cached?.illustrations ?? []).filter(
              (item) =>
                !changed.has(item.sourceRevision) &&
                value.reader!.order.includes(item.sourceRevision)
            ),
            ...(value.illustrations ?? []),
          ],
        };
        let cacheKey = query.key;
        if (replacementSource !== undefined) {
          restoredView.current = '';
          const storageBranch = query.branch === `main:${id}` ? '' : query.branch;
          sessionStorage.removeItem(`reading:${id}:${storageBranch}`);
          cacheKey = `${id}:${query.branch}:${replacementSource}`;
          readerQuery.current = { ...query, source: replacementSource, key: cacheKey };
          navigate({ kind: 'rebase-source', source: replacementSource });
          const url = new URL(location.href);
          if (replacementSource) url.searchParams.set('source', replacementSource);
          else url.searchParams.delete('source');
          history.replaceState(null, '', url);
        }
        readerCache.current = { key: cacheKey, detail: merged };
        setDetail(merged);
        setChats((old) => old.map((chat) => (chat.id === id ? value.chat : chat)));
        return true;
      }
    },
    [navigate]
  );
  const refreshView = useCallback(
    async (id: string, incremental = false): Promise<void> => {
      await refresh(id, incremental);
    },
    [refresh]
  );
  const chatsRequest = useRef(0);
  const loadChats = useCallback(async () => {
    const request = ++chatsRequest.current;
    const selectedAtRequest = navigation.current.chat,
      epoch = navigation.current.epoch;
    const chats = await api<Chat[]>('/chats');
    if (chatsRequest.current !== request) return;
    setChats(chats);
    if (
      selectedAtRequest &&
      navigation.current.chat === selectedAtRequest &&
      navigation.current.epoch === epoch &&
      !chats.some((chat) => chat.id === selectedAtRequest)
    ) {
      navigate({ kind: 'chat-deleted' });
      refreshVersion.current++;
      readerCache.current = null;
      setDetail(null);
      const url = new URL(location.href);
      for (const key of ['chat', 'branch', 'source']) url.searchParams.delete(key);
      history.replaceState(null, '', url);
    }
  }, [navigate]);
  const libraryRequest = useRef(0);
  const loadLibrary = useCallback(async () => {
    const request = ++libraryRequest.current;
    try {
      const value = await api<Library>('/library?view=summary');
      if (libraryRequest.current === request) {
        setLibrary(value);
        setLibraryError('');
      }
    } catch (caught) {
      if (libraryRequest.current === request) setLibraryError((caught as Error).message);
      throw caught;
    }
  }, []);
  useEffect(() => {
    const refreshLibrary = () => {
      void loadLibrary().catch((caught) => setError(caught.message));
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === libraryChangedKey) refreshLibrary();
    };
    addEventListener('storage', onStorage);
    addEventListener('focus', refreshLibrary);
    return () => {
      removeEventListener('storage', onStorage);
      removeEventListener('focus', refreshLibrary);
      libraryRequest.current++;
    };
  }, [loadLibrary]);
  useEffect(() => {
    void Promise.all([loadChats(), loadLibrary()]).catch((e) => setError(e.message));
  }, [loadChats, loadLibrary]);
  useEffect(() => {
    readerCache.current = null;
    setDetail(null);
    setError('');
    setNotice('');
    setConnected(false);
    setProfileDirty(false);
    setArchivedContents([]);
    if (!selected) return;
    let alive = true;
    let firstSnapshot = true;
    let reconnect = false;
    const sync = createReaderSync({
      refresh: (incremental) => refresh(selected, incremental),
      cursor: () => readerCache.current?.detail.reader.cursor ?? -1,
      onError: (error) => setError(error instanceof Error ? error.message : String(error)),
    });
    const openStream = () => {
      const stream = new EventSource(`/api/chats/${selected}/events`);
      stream.onopen = () => {
        if (alive) setConnected(true);
      };
      stream.onerror = () => {
        if (alive) setConnected(false);
      };
      // Batch event bursts; refreshVersion still rejects out-of-order HTTP responses.
      stream.onmessage = (event) => {
        if (!alive || navigation.current.chat !== selected) return;
        const message = JSON.parse(event.data) as { kind: string; seq?: number; entityId?: string };
        if (message.kind === 'chat.deleted') {
          stream.close();
          void loadChats().catch((e) => {
            if (alive) setError(e.message);
          });
          return;
        }
        if (message.kind === 'prompt-workspace.updated')
          dispatchEvent(new Event('prompt-workspace-changed'));
        if (message.kind === 'profile.updated' || message.kind === 'prompt-workspace.updated')
          void loadLibrary().catch((e) => {
            if (alive) setError(e.message);
          });
        const currentBranch =
          navigation.current.branch ||
          (defaultView.current?.chatId === selected ? defaultView.current.branchId : '');
        if (message.kind === 'branch.deleted' && currentBranch === message.entityId) {
          navigate({ kind: 'branch-deleted' });
          readerCache.current = null;
          sessionStorage.removeItem(`branch:${selected}`);
          const url = new URL(location.href);
          url.searchParams.delete('branch');
          url.searchParams.delete('source');
          history.replaceState(null, '', url);
          return;
        }
        if (message.kind === 'snapshot') {
          if (firstSnapshot) {
            firstSnapshot = false;
            if (!reconnect) return;
          }
          reconnect = true;
        }
        sync.request(message.seq ?? 0, reconnect);
        reconnect = false;
      };
      return stream;
    };
    let stream = navigator.onLine ? openStream() : undefined;
    const offline = () => {
      stream?.close();
      setConnected(false);
    };
    const online = () => {
      if (alive) {
        stream?.close();
        reconnect = true;
        stream = openStream();
      }
    };
    addEventListener('offline', offline);
    addEventListener('online', online);
    return () => {
      alive = false;
      sync.dispose();
      stream?.close();
      removeEventListener('offline', offline);
      removeEventListener('online', online);
    };
  }, [selected, refresh, loadChats, loadLibrary, navigate]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Address changes and committed navigation intents reload the query held by refresh's stable refs.
  useEffect(() => {
    let alive = true;
    const epoch = view.epoch;
    if (selected && destination === 'story') {
      restoredView.current = '';
      // A repeated selection needs a fresh read, but can keep its already displayed page.
      if (readerCache.current?.key !== readerQuery.current.key) setDetail(null);
      void refresh(selected).catch((e) => {
        if (alive && navigation.current.epoch === epoch) setError(e.message);
      });
    }
    return () => {
      alive = false;
    };
  }, [selected, activeBranchId, readSource, destination, view.epoch, refresh]);
  const attachmentKey = [...(detail?.profile?.packageAttachments ?? [])].map(refValue).join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: Current content reads follow IDs/revisions, library changes and chat switches, not SSE object identity.
  useEffect(() => {
    let alive = true;
    if (!detail?.profile || !library) return;
    const missing = [...(detail.profile.packageAttachments ?? [])].filter(
      (ref) => !library.contents.some((item) => refValue(item) === refValue(ref))
    );
    void Promise.all(missing.map((ref) => api<Content>(`/content/${ref.id}`)))
      .then((items) => {
        if (alive) setArchivedContents(items);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [attachmentKey, library, selected]);
  const viewKey = `${selected}:${storageBranch}`;
  const draftKey = `draft:${selected}${storageBranch ? `:${storageBranch}` : ''}`;
  currentDraftKey.current = draftKey;
  currentView.current = viewKey;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Leaving this navigation scope releases its resize observer, even before new content mounts.
  useLayoutEffect(
    () => () => {
      cancelNavigationScroll.current?.();
      cancelNavigationScroll.current = null;
    },
    [viewKey, readSource, destination]
  );
  const holdNavigationPosition = useCallback(
    (node: HTMLElement, position: ReaderNavigationPosition) => {
      cancelNavigationScroll.current?.();
      const epoch = navigation.current.epoch;
      const query = readerQuery.current.key;
      cancelNavigationScroll.current = retainReaderNavigation(
        node,
        position,
        () =>
          navigation.current.chat === selected &&
          currentView.current === viewKey &&
          navigation.current.epoch === epoch &&
          readerQuery.current.key === query &&
          reader.current === node,
        () => {
          restoredView.current = viewKey;
        }
      );
    },
    [selected, viewKey]
  );
  const savePosition = useCallback(() => {
    const node = reader.current;
    if (!node || restoredView.current !== viewKey || !selected) return;
    const box = node.getBoundingClientRect();
    const blocks = node.querySelectorAll<HTMLElement>('.prose [data-block-anchor]');
    let low = 0,
      high = blocks.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (blocks[mid].getBoundingClientRect().bottom <= box.top + 12) low = mid + 1;
      else high = mid;
    }
    const block = blocks[low];
    const position: Position = {
      target: readSource,
      source: block?.closest('[data-source-id]')?.getAttribute('data-source-id') || '',
      anchor: block?.dataset.blockAnchor?.split(' ')[0] || '',
      offset: block ? block.getBoundingClientRect().top - box.top : 0,
      top: node.scrollTop,
    };
    sessionStorage.setItem(`reading:${viewKey}`, JSON.stringify(position));
  }, [selected, viewKey, readSource]);
  useLayoutEffect(() => {
    setDraft(sessionStorage.getItem(draftKey) || '');
    setLoreResetDraft(sessionStorage.getItem(`lore-reset:${draftKey}`) === 'true');
    const cursor = readDraftCursor(`cursor:${draftKey}`);
    const frame = requestAnimationFrame(() => {
      if (cursor && currentDraftKey.current === draftKey)
        input.current?.setSelectionRange(cursor.start, cursor.end);
    });
    return () => cancelAnimationFrame(frame);
  }, [draftKey]);
  useEffect(() => {
    const before = () => savePosition();
    addEventListener('pagehide', before);
    return () => {
      savePosition();
      removeEventListener('pagehide', before);
    };
  }, [savePosition]);
  const rememberCursor = useCallback(() => {
    const node = input.current;
    if (node)
      sessionStorage.setItem(
        `cursor:${draftKey}`,
        JSON.stringify({ start: node.selectionStart, end: node.selectionEnd })
      );
  }, [draftKey]);
  function editDraft(value: string) {
    setDraft(value);
    sessionStorage.setItem(draftKey, value);
  }
  function editLoreContextReset(value: boolean) {
    if (readCommand(commandStorageKey(selected, storageBranch))) return;
    setLoreResetDraft(value);
    if (value) sessionStorage.setItem(`lore-reset:${draftKey}`, 'true');
    else sessionStorage.removeItem(`lore-reset:${draftKey}`);
  }
  const branch =
    detail?.branches?.find((item) => item.id === activeBranchId) ??
    detail?.branches?.find((item) => item.default);
  const sources = useMemo(() => detail?.sources ?? [], [detail]);
  const visibleRuns =
    detail?.runs.filter(
      (run) =>
        !run.supersededBy &&
        (!branch ||
          (!run.snapshot.branchId && branch.default) ||
          run.snapshot.branchId === branch.id)
    ) ?? [];
  const conversation = readerConversation(
    sources,
    (detail?.runs ?? []).filter(
      (run) =>
        run.sourceRevision ||
        (visibleRuns.some((visible) => visible.id === run.id) &&
          (!detail?.reader.pendingRunIds || detail.reader.pendingRunIds.includes(run.id)))
    )
  );
  useLayoutEffect(() => {
    if (
      !detail ||
      readerCache.current?.key !== readerQuery.current.key ||
      destination !== 'story' ||
      restoredView.current === viewKey ||
      !reader.current
    )
      return;
    const node = reader.current;
    const saved = readReadingPosition(`reading:${viewKey}`);
    const epoch = navigation.current.epoch;
    const frame = requestAnimationFrame(() => {
      if (
        navigation.current.chat !== selected ||
        currentView.current !== viewKey ||
        navigation.current.epoch !== epoch ||
        reader.current !== node
      )
        return;
      const sourceTarget =
        readSource && saved?.target !== readSource
          ? document.getElementById(`source-${readSource}`)
          : null;
      const latest = latestIntent.current;
      if (
        latest?.epoch === navigation.current.epoch &&
        detail.reader.order.includes(latest.source)
      ) {
        holdNavigationPosition(node, { kind: 'end' });
        latestIntent.current = null;
      } else if (sourceTarget && node.contains(sourceTarget)) {
        holdNavigationPosition(node, { kind: 'source', element: sourceTarget });
      } else {
        // Ordinary opening/restoration does not turn reading into a pinned navigation target.
        const block = saved?.anchor
          ? [...node.querySelectorAll<HTMLElement>('[data-block-anchor]')].find(
              (item) =>
                item.offsetParent !== null &&
                item.closest('[data-source-id]')?.getAttribute('data-source-id') === saved.source &&
                item.dataset.blockAnchor?.split(' ').includes(saved.anchor)
            )
          : null;
        if (block && saved)
          node.scrollTop +=
            block.getBoundingClientRect().top - node.getBoundingClientRect().top - saved.offset;
        else node.scrollTop = saved?.top || 0;
      }
      restoredView.current = viewKey;
    });
    return () => cancelAnimationFrame(frame);
  }, [detail, selected, viewKey, readSource, destination, holdNavigationPosition]);
  const setViewUrl = (chat: string, branchId = '', source = '') => {
    const params = new URLSearchParams({ chat });
    if (branchId) params.set('branch', branchId);
    if (source) params.set('source', source);
    history.pushState(null, '', `?${params}`);
  };
  const select = (id: string) => {
    savePosition();
    rememberCursor();
    setViewUrl(id);
    navigate({ kind: 'chat', chat: id });
  };
  const chooseBranch = (id: string, source = '') => {
    savePosition();
    rememberCursor();
    setViewUrl(selected, id, source);
    sessionStorage.setItem(`branch:${selected}`, id);
    navigate({ kind: 'branch', branch: id, source });
  };
  const chooseSource = (id: string, toEnd = false) => {
    cancelNavigationScroll.current?.();
    savePosition();
    navigate({ kind: 'source', source: id });
    latestIntent.current = toEnd ? { epoch: navigation.current.epoch, source: id } : null;
    setViewUrl(selected, viewedBranch, id);
    if (id === readSource) {
      const key = currentView.current;
      const epoch = navigation.current.epoch;
      requestAnimationFrame(() => {
        const node = reader.current,
          target = document.getElementById(`source-${id}`);
        if (
          currentView.current === key &&
          navigation.current.epoch === epoch &&
          node &&
          target &&
          node.contains(target)
        ) {
          holdNavigationPosition(
            node,
            toEnd ? { kind: 'end' } : { kind: 'source', element: target }
          );
          latestIntent.current = null;
          restoredView.current = key;
        }
      });
    }
  };
  const chooseLatest = () => {
    const last = detail?.reader.navigation.at(-1);
    if (last) chooseSource(last.id, true);
  };
  useEffect(() => {
    const onPop = () => {
      savePosition();
      rememberCursor();
      navigate({ kind: 'restore', view: initialView() });
    };
    return subscribeAppHistory(onPop);
  }, [savePosition, rememberCursor, navigate]);
  function showLibrary() {
    savePosition();
    history.pushState(null, '', '?workspace=library');
    navigate({ kind: 'library' });
  }
  function canReuseRun(id: string) {
    const run = visibleRuns.find((run) => run.id === id);
    return (
      !!run &&
      !!run.request.trim() &&
      run.packageStart?.mode !== 'authored' &&
      ['completed', 'failed', 'cancelled', 'interrupted', 'refused', 'partial'].includes(run.status)
    );
  }
  function activeRun() {
    return visibleRuns.find((run) => ['queued', 'running'].includes(run.status));
  }
  const reuseBlocked =
    !!activeRun() ||
    submitting.includes(viewKey) ||
    quickBusy ||
    profileDirty ||
    !detail ||
    !!sessionStorage.getItem(`pending-profile:${selected}`) ||
    !!readCommand(commandStorageKey(selected, activeBranchId));
  async function generate(
    retryRunId?: string,
    editedRequest?: string,
    judgmentRecovery = false
  ): Promise<boolean> {
    if (
      !detail ||
      detail.chat.id !== selected ||
      submitLocks.current.has(viewKey) ||
      sessionStorage.getItem(`pending-profile:${selected}`)
    )
      return false;
    if (editedRequest !== undefined && (!retryRunId || !editedRequest.trim())) return false;
    const retryRun = retryRunId ? visibleRuns.find((run) => run.id === retryRunId)! : undefined;
    const chat = detail.chat;
    const sentKey = draftKey;
    const sentView = viewKey;
    const sentEpoch = navigation.current.epoch;
    const commandKey = commandStorageKey(chat.id, activeBranchId);
    const previous = readCommand(commandKey);
    // Recovering an uncertain admission reuses its key even if SSE already shows a running run.
    if ((!previous && activeRun()) || (retryRunId && (reuseBlocked || !canReuseRun(retryRunId))))
      return false;
    if (!previous && !retryRun && !draft.trim()) return false;
    // An uncertain request keeps its original snapshot as well as its key.
    // A newer draft is never silently sent after recovering that earlier request.
    const payload: RunPayload = previous?.payload ?? {
      request: editedRequest ?? retryRun?.request ?? draft,
      ...(editedRequest !== undefined ? { editedRequest: true } : {}),
      ...(retryRun
        ? { retryOf: retryRun.id, ...(judgmentRecovery ? { judgmentRecovery: true as const } : {}) }
        : {}),
      ...((retryRun ? retryRun.snapshot.loreContextReset : loreResetDraft)
        ? { loreContextReset: true }
        : {}),
      expectedRevision: branch ? branch.headRevision : chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      ...(branch ? { branchId: branch.id } : {}),
      ...(detail.profile ? { expectedProfileRevision: detail.profile.revision } : {}),
    };
    const preserveDraft = !!retryRun || previous?.record.preserveDraft === true;
    const sentDraft = payload.request;
    const idempotencyKey = previous?.record.id ?? crypto.randomUUID();
    const startedAt = previous?.record.startedAt ?? new Date().toISOString();
    const track = (status: RequestActivity['status'], runId?: string) =>
      setRequestActivities((old) => ({
        ...old,
        [sentView]: { id: idempotencyKey, startedAt, status, runId },
      }));
    try {
      if (!previous && sessionStorage.getItem(commandKey)) {
        setError(
          '이전 요청 기록을 읽을 수 없어 새 요청을 보내지 않았어요. 기록을 보존한 상태로 복구가 필요해요.'
        );
        return false;
      }
      sessionStorage.setItem(
        commandKey,
        JSON.stringify({
          payload: JSON.stringify(payload),
          id: idempotencyKey,
          startedAt,
          ...(preserveDraft ? { preserveDraft: true } : {}),
        })
      );
    } catch {
      setError(
        '요청 복구 기록을 저장하지 못해 요청을 보내지 않았어요. 브라우저 저장 공간을 확인해 주세요.'
      );
      return false;
    }
    track('sending');
    submitLocks.current.add(sentView);
    setSubmitting([...submitLocks.current]);
    setError('');
    setNotice('');
    let accepted = false;
    try {
      const admitted = payload.retryOf
        ? await api<Run>(
            `/runs/${encodeURIComponent(payload.retryOf)}/${payload.judgmentRecovery ? 'rejudge' : 'retry'}`,
            {
              idempotencyKey,
              ...(payload.editedRequest ? { request: payload.request } : {}),
            }
          )
        : await api<Run>(`/chats/${chat.id}/runs`, { ...payload, idempotencyKey });
      track('accepted', admitted.id);
      accepted = true;
      clearCommand(commandKey, idempotencyKey);
      if (payload.editedRequest && payload.retryOf)
        sessionStorage.removeItem(`request-edit:${payload.retryOf}`);
      if (!preserveDraft && payload.loreContextReset) {
        sessionStorage.removeItem(`lore-reset:${sentKey}`);
        if (currentDraftKey.current === sentKey) setLoreResetDraft(false);
      }
      if (!preserveDraft && sessionStorage.getItem(sentKey) === sentDraft) {
        sessionStorage.removeItem(sentKey);
        if (currentDraftKey.current === sentKey) setDraft('');
      }
      if (currentView.current === sentView)
        setNotice(
          previous
            ? sessionStorage.getItem(sentKey)
              ? '이전 요청의 수락을 확인했어요. 새로 작성한 초안은 남겨두었어요.'
              : '이전 요청의 수락을 확인했어요.'
            : ''
        );
      if (
        payload.retryOf &&
        admitted.snapshot.branchId &&
        admitted.snapshot.branchId !== branch?.id &&
        currentView.current === sentView &&
        navigation.current.epoch === sentEpoch
      )
        chooseBranch(admitted.snapshot.branchId);
    } catch (error) {
      track(definiteRejection(error) ? 'failed' : 'uncertain');
      if (
        definiteRejection(error) &&
        (!previous || (error instanceof ApiError && error.status === 409))
      )
        clearCommand(commandKey, idempotencyKey);
      if (currentView.current === sentView)
        setError(error instanceof Error ? error.message : '요청의 수락 여부를 확인하지 못했어요.');
    }
    // Failure to refresh an accepted run must not turn it into a pending command.
    try {
      await refresh(chat.id);
    } catch {
      if (accepted && currentView.current === sentView)
        setError('요청은 수락됐어요. 화면을 다시 불러오지 못해 연결을 확인하고 있어요.');
    } finally {
      submitLocks.current.delete(sentView);
      setSubmitting([...submitLocks.current]);
    }
    return accepted;
  }
  const forkLocks = useRef(new Set<string>());
  const [forking, setForking] = useState<string[]>([]);
  // The chat a fork was copied from, shown until the reader leaves the new chat or dismisses it.
  const [forkOrigin, setForkOrigin] = useState<{
    id: string;
    title: string;
    forkId: string;
  } | null>(null);
  async function fork(sourceId: string) {
    const chatId = selected;
    const epoch = navigation.current.epoch;
    const lock = `${chatId}:${sourceId}`;
    // The reader contains only the current page; the server verifies source ownership and ancestry.
    if (!detail || detail.chat.id !== chatId || !sourceId || forkLocks.current.has(lock)) return;
    forkLocks.current.add(lock);
    setForking([...forkLocks.current]);
    setError('');
    try {
      const next = await requestChatFork(chatId, sourceId);
      setChats((current) => [next, ...current.filter((chat) => chat.id !== next.id)]);
      if (navigation.current.chat === chatId && navigation.current.epoch === epoch) {
        setForkOrigin({
          id: chatId,
          title: chats.find((chat) => chat.id === chatId)?.title ?? '원본 채팅',
          forkId: next.id,
        });
        select(next.id);
      }
    } catch (error) {
      if (navigation.current.chat === chatId && navigation.current.epoch === epoch)
        setError(
          error instanceof Error
            ? error.message
            : '이야기 복사를 확인하지 못했어요. 다시 누르면 같은 요청을 확인해요.'
        );
    } finally {
      forkLocks.current.delete(lock);
      setForking([...forkLocks.current]);
    }
  }
  const quickLock = useRef(false);
  const pinnedPromptId = detail?.profile?.pinned?.mainPromptPresetId;
  const pinnedPrompt = library?.promptPresets?.find(
    (item) => item.id === pinnedPromptId && item.role === 'main'
  );
  // Library summaries keep prompt programs. A missing pin must never fall back to the workspace.
  const currentPrompt: CurrentPrompt | undefined = pinnedPromptId
    ? pinnedPrompt
      ? {
          presetId: pinnedPrompt.id,
          title: pinnedPrompt.title,
          program: pinnedPrompt.program,
          values: pinnedPrompt.values ?? {},
        }
      : undefined
    : promptWorkspace?.main;
  async function quickChange(kind: 'combination' | 'persona' | 'module', value: string) {
    if (
      !detail?.profile ||
      detail.chat.id !== selected ||
      !library ||
      profileDirty ||
      quickLock.current
    )
      return;
    const chatId = detail.chat.id;
    const profile = detail.profile;
    quickLock.current = true;
    setQuickBusy(true);
    setError('');
    setNotice('');
    try {
      if (kind === 'combination') {
        const preset = library.promptCombinations?.find((c) => refValue(c) === value);
        if (
          !preset ||
          !promptWorkspace ||
          !currentPrompt ||
          !matchesPromptCombination(
            preset,
            combinationOwner(currentPrompt, 'main'),
            'main',
            currentPrompt.program
          )
        )
          throw new Error('현재 프롬프트와 옵션 정의가 일치하는 조합을 선택해 주세요.');
        if (pinnedPromptId) {
          if (!branch) throw new Error('현재 채팅 분기를 확인해 주세요.');
          const state = await api<ChatOptionState>(
            `/chats/${chatId}/options?branchId=${encodeURIComponent(branch.id)}`
          );
          if (
            state.binding.owner !== `preset:${pinnedPromptId}` ||
            !matchesPromptCombination(
              preset,
              { kind: 'preset', id: pinnedPromptId },
              'main',
              state.program
            )
          )
            throw new Error('채팅의 작문 프롬프트가 바뀌었어요. 옵션 조합을 다시 확인해 주세요.');
          await api(`/chats/${chatId}/options/fixed`, {
            branchId: branch.id,
            expectedRevision: state.revision,
            operationId: crypto.randomUUID(),
            binding: state.binding,
            values: preset.values,
          });
          dispatchEvent(new Event('chat-options-changed'));
        } else {
          await api('/prompt-workspace/apply-options', {
            expectedRevision: promptWorkspace.revision,
            role: 'main',
            combinationId: preset.id,
          });
        }
      } else if (kind === 'module') {
        const epoch = navigation.current.epoch;
        let module = library.contents.find((item) => refValue(item) === value);
        if (!module) {
          const separator = value.lastIndexOf('@');
          const id = value.slice(0, separator);
          const revision = Number(value.slice(separator + 1));
          if (separator <= 0 || !Number.isSafeInteger(revision) || revision < 1)
            throw new Error('추가할 모듈을 다시 선택해 주세요.');
          module = await api<Content>(`/content/${encodeURIComponent(id)}`);
        }
        if (navigation.current.chat !== chatId || navigation.current.epoch !== epoch) return false;
        if (!module.package && !module.hasPackage)
          throw new Error('추가할 모듈을 찾지 못했어요. 서재를 다시 확인해 주세요.');
        const existing = profile.packageAttachments ?? [];
        if (existing.some((item) => item.id === module.id && item.role === 'module'))
          throw new Error('이미 연결한 모듈이에요. 채팅 설정에서 확인해 주세요.');
        await api(
          `/chats/${chatId}/profile`,
          {
            expectedRevision: profile.revision,
            image: profile.image,
            packageAttachments: [
              ...existing,
              { id: module.id, revision: module.revision, role: 'module' },
            ],
          },
          'PUT'
        );
      } else {
        let contents = [...library.contents, ...archivedContents];
        const persona = contents.find(
          (item) =>
            (item.kind === 'persona' || item.package || item.hasPackage) && refValue(item) === value
        );
        if (kind === 'persona' && value && !persona)
          throw new Error('선택한 페르소나를 찾지 못했어요.');
        const packageAttachments =
          kind === 'persona'
            ? [...(profile.packageAttachments ?? [])]
                .filter((r) => r.role !== 'persona')
                .concat(
                  persona ? [{ id: persona.id, revision: persona.revision, role: 'persona' }] : []
                )
            : profile.packageAttachments;
        await api(
          `/chats/${chatId}/profile`,
          {
            expectedRevision: profile.revision,
            image: profile.image,
            packageAttachments,
          },
          'PUT'
        );
      }
      if (navigation.current.chat === chatId) setNotice('다음 요청에 적용할 설정을 저장했어요.');
      await refresh(chatId);
      return true;
    } catch (error) {
      if (navigation.current.chat === chatId)
        setError(error instanceof Error ? error.message : '설정을 저장하지 못했어요.');
      await refresh(chatId).catch(() => undefined);
      return false;
    } finally {
      quickLock.current = false;
      setQuickBusy(false);
    }
  }
  const active = visibleRuns.find((run) => run.status === 'queued' || run.status === 'running');
  const allContents = [...(library?.contents ?? []), ...archivedContents];
  const attachmentsReady =
    !!detail?.profile &&
    (detail.profile.packageAttachments ?? []).every((ref) =>
      allContents.some((item) => refValue(item) === refValue(ref))
    );
  const pendingCommand = selected ? readCommand(commandStorageKey(selected, activeBranchId)) : null;
  const pendingRequest = pendingCommand?.payload.request ?? null;
  const pendingEditedRunId = pendingCommand?.payload.editedRequest
    ? pendingCommand.payload.retryOf
    : undefined;
  const loreContextReset = pendingCommand
    ? pendingCommand.payload.loreContextReset === true
    : loreResetDraft;
  const packageContent = (role: string) => {
    const r = detail?.profile?.packageAttachments?.find((r) => r.role === role);
    return r ? allContents.find((c) => refValue(c) === refValue(r)) : undefined;
  };
  const bot = packageContent('bot');
  const persona = packageContent('persona');
  const profileAsset = detail?.assets?.find((asset) => asset.allowedUse !== 'inline');
  const tasks = detail
    ? (detail.reader.activity?.filter((item) => ['running', 'queued'].includes(item.status))
        .length ??
      detail.runs.filter((run) => ['running', 'queued'].includes(run.status)).length +
        detail.reader.activeJobs)
    : 0;
  const pendingProfile = !!selected && !!sessionStorage.getItem(`pending-profile:${selected}`);
  const trackedRequest = requestActivities[viewKey];
  // Settled runs may leave the bounded activity projection. Do not resurrect their admission indicator.
  const settledOutsideActivity =
    trackedRequest?.status === 'accepted' &&
    (!detail ||
      (!detail.runs.some(
        (run) => run.id === trackedRequest.runId && ['queued', 'running'].includes(run.status)
      ) &&
        !detail.reader.activity?.some((item) => item.id === trackedRequest.runId)));
  const requestActivity =
    (settledOutsideActivity ? undefined : trackedRequest) ??
    (pendingCommand
      ? {
          id: pendingCommand.record.id,
          startedAt: pendingCommand.record.startedAt ?? '',
          status: 'uncertain' as const,
        }
      : undefined);
  return {
    promptWorkspace,
    currentPrompt,
    pinnedPromptRevision: pinnedPrompt?.revision,
    requestActivity,
    chats,
    selected,
    viewedBranch,
    readSource,
    detail,
    library,
    libraryError,
    draft,
    error,
    notice,
    connected,
    destination,
    profileDirty,
    quickBusy,
    reader,
    input,
    viewKey,
    active,
    allContents,
    bot,
    persona,
    profileAsset,
    tasks,
    pendingProfile,
    branch,
    sources,
    visibleRuns,
    conversation,
    submitting,
    attachmentsReady,
    pendingRequest,
    pendingEditedRunId,
    loreContextReset,
    forking,
    forkOrigin,
    dismissForkOrigin: () => setForkOrigin(null),
    setError,
    setNotice,
    setProfileDirty,
    refresh: refreshView,
    loadChats,
    loadLibrary,
    savePosition,
    rememberCursor,
    editDraft,
    editLoreContextReset,
    select,
    chooseBranch,
    chooseSource,
    chooseLatest,
    showLibrary,
    generate,
    canReuseRun,
    reuseBlocked,
    fork,
    quickChange,
  };
}
export type StoryState = ReturnType<typeof useStory>;
