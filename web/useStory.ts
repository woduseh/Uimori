import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Chat, ReaderDetail, Run, Source } from '../core/types.js';
import type { Content, Library } from '../core/product.js';
import { api, ApiError, libraryChangedKey } from './api.js';
import { refValue } from './LibraryPanel.js';
import { useModelSelection } from './model-selection.js';

function initialView() {
  const params = new URLSearchParams(location.search);
  const chat = params.get('chat') || '';
  return { chat, branch: params.get('branch') || '', source: params.get('source') || '' };
}
function ancestry(sources: Source[], head: string | null) {
  const byId = new Map(sources.map((source) => [source.id, source]));
  const seen = new Set<string>();
  const result: Source[] = [];
  while (head && !seen.has(head)) {
    seen.add(head);
    const source = byId.get(head);
    if (!source) break;
    result.unshift(source);
    head = source.parentRevision;
  }
  return result;
}
type RunPayload = {
  packageRequestId?: string;
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
function definiteRejection(error: unknown): boolean {
  return (
    error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408
  );
}

type Position = { target?: string; source: string; anchor: string; offset: number; top: number };
export function useStory() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [selected, setSelected] = useState(() => initialView().chat);
  const [viewedBranch, setViewedBranch] = useState(() => initialView().branch);
  const [readSource, setReadSource] = useState(() => initialView().source);
  const [loadedDetail, setDetail] = useState<ReaderDetail | null>(null);
  const [library, setLibrary] = useState<Library | null>(null);
  const { choices: quickModels, canSelect: canSelectModel } = useModelSelection(
    library?.models ?? [],
    library?.connections ?? []
  );
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
  const [destination, setDestination] = useState<'story' | 'library'>(() =>
    initialView().chat ? 'story' : 'library'
  );
  const [profileDirty, setProfileDirty] = useState(false);
  const [quickBusy, setQuickBusy] = useState(false);
  const reader = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const current = useRef(selected);
  const currentView = useRef('');
  const currentDraftKey = useRef('');
  const refreshVersion = useRef(0);
  const restoredView = useRef('');
  // A completed server operation may navigate only while its original viewing intent is current.
  // Increment on every navigation, including A -> B -> A and changes within the same story.
  const navigationEpoch = useRef(0);
  const readerQuery = useRef({ branch: '', source: '', key: '' });
  const readerCache = useRef<{ key: string; detail: ReaderDetail } | null>(null);
  const savedPosition = JSON.parse(
    sessionStorage.getItem(`reading:${selected}:${viewedBranch}`) || 'null'
  ) as Position | null;
  readerQuery.current = {
    branch: viewedBranch,
    source:
      (savedPosition?.target === readSource ? savedPosition?.source : readSource) ||
      savedPosition?.source ||
      '',
    key: `${selected}:${viewedBranch}:${readSource}`,
  };
  const refresh = useCallback(async (id: string, incremental = false) => {
    if (current.current !== id) return;
    const version = ++refreshVersion.current;
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
    const value = await api<ReaderDetail>(`/chats/${id}/reader?${params}`);
    if (
      current.current === id &&
      readerQuery.current.key === query.key &&
      refreshVersion.current === version
    ) {
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
      };
      readerCache.current = { key: query.key, detail: merged };
      setDetail(merged);
      setChats((old) => old.map((chat) => (chat.id === id ? value.chat : chat)));
    }
  }, []);
  current.current = selected;
  const loadChats = useCallback(async () => {
    const selectedAtRequest = current.current,
      epoch = navigationEpoch.current;
    const chats = await api<Chat[]>('/chats');
    setChats(chats);
    if (
      selectedAtRequest &&
      current.current === selectedAtRequest &&
      navigationEpoch.current === epoch &&
      !chats.some((chat) => chat.id === selectedAtRequest)
    ) {
      navigationEpoch.current++;
      refreshVersion.current++;
      current.current = '';
      readerCache.current = null;
      setSelected('');
      setViewedBranch('');
      setReadSource('');
      setDetail(null);
      setDestination('library');
      const url = new URL(location.href);
      for (const key of ['chat', 'branch', 'source']) url.searchParams.delete(key);
      history.replaceState(null, '', url);
    }
  }, []);
  const libraryRequest = useRef(0);
  const loadLibrary = useCallback(async () => {
    const request = ++libraryRequest.current;
    const value = await api<Library>('/library?view=summary');
    if (libraryRequest.current === request) setLibrary(value);
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    let firstSnapshot = true;
    let requestedCursor = 0;
    let reconnect = false;
    let eventRefreshInFlight = false;
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
        if (!alive) return;
        const message = JSON.parse(event.data) as { kind: string; seq?: number; entityId?: string };
        if (message.kind === 'chat.deleted') {
          stream.close();
          void loadChats().catch((e) => {
            if (alive) setError(e.message);
          });
          return;
        }
        if (message.kind === 'branch.deleted' && readerQuery.current.branch === message.entityId) {
          navigationEpoch.current++;
          readerCache.current = null;
          setViewedBranch('');
          setReadSource('');
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
        requestedCursor = Math.max(requestedCursor, message.seq ?? 0);
        if (timer) return;
        const flush = () => {
          if (!alive) return;
          // Serialize event refreshes only. A stalled initial/manual HTTP response
          // must not block newer SSE state; refreshVersion rejects its late result.
          if (eventRefreshInFlight) {
            timer = setTimeout(flush, 100);
            return;
          }
          timer = undefined;
          const applied = readerCache.current?.detail.reader.cursor ?? -1;
          if (reconnect || requestedCursor > applied) {
            const incremental = !reconnect;
            reconnect = false;
            eventRefreshInFlight = true;
            void refresh(selected, incremental)
              .catch((e) => {
                if (alive) setError(e.message);
              })
              .finally(() => {
                eventRefreshInFlight = false;
              });
          }
        };
        timer = setTimeout(flush, 100);
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
      clearTimeout(timer);
      stream?.close();
      removeEventListener('offline', offline);
      removeEventListener('online', online);
    };
  }, [selected, refresh, loadChats]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Branch and source navigation reload the query held by refresh's stable refs.
  useEffect(() => {
    let alive = true;
    if (selected) {
      restoredView.current = '';
      setDetail(null);
      void refresh(selected).catch((e) => {
        if (alive) setError(e.message);
      });
    }
    return () => {
      alive = false;
    };
  }, [selected, viewedBranch, readSource, refresh]);
  const attachmentKey = [
    ...(detail?.profile?.attachments ?? []),
    ...(detail?.profile?.packageAttachments ?? []),
  ]
    .map(refValue)
    .join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: Archived reads follow pinned references, library changes and chat switches, not SSE profile object identity.
  useEffect(() => {
    let alive = true;
    if (!detail?.profile || !library) return;
    const missing = [
      ...detail.profile.attachments,
      ...(detail.profile.packageAttachments ?? []),
    ].filter((ref) => !library.contents.some((item) => refValue(item) === refValue(ref)));
    void Promise.all(
      missing.map((ref) => api<Content>(`/revisions/content/${ref.id}/${ref.revision}`))
    )
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
  const viewKey = `${selected}:${viewedBranch}`;
  const draftKey = `draft:${selected}${viewedBranch ? `:${viewedBranch}` : ''}`;
  currentDraftKey.current = draftKey;
  currentView.current = viewKey;
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
    const cursor = JSON.parse(sessionStorage.getItem(`cursor:${draftKey}`) || 'null') as {
      start: number;
      end: number;
    } | null;
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
  function editDraft(value: string, packageRequestId?: string) {
    setDraft(value);
    sessionStorage.setItem(draftKey, value);
    if (packageRequestId)
      sessionStorage.setItem(`package-request-draft:${draftKey}`, packageRequestId);
    else sessionStorage.removeItem(`package-request-draft:${draftKey}`);
  }
  function editLoreContextReset(value: boolean) {
    if (readCommand(`command:${selected}${viewedBranch ? `:${viewedBranch}` : ''}`)) return;
    setLoreResetDraft(value);
    if (value) sessionStorage.setItem(`lore-reset:${draftKey}`, 'true');
    else sessionStorage.removeItem(`lore-reset:${draftKey}`);
  }
  const branch =
    detail?.branches?.find((item) => item.id === viewedBranch) ??
    detail?.branches?.find((item) => item.default);
  const sources = useMemo(
    () =>
      detail
        ? detail.reader
          ? detail.sources
          : branch
            ? ancestry(detail.sources, branch.headRevision)
            : detail.sources
        : [],
    [detail, branch]
  );
  const visibleRuns =
    detail?.runs.filter(
      (run) =>
        !branch || (!run.snapshot.branchId && branch.default) || run.snapshot.branchId === branch.id
    ) ?? [];
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
    const saved = JSON.parse(
      sessionStorage.getItem(`reading:${viewKey}`) || 'null'
    ) as Position | null;
    const frame = requestAnimationFrame(() => {
      if (
        current.current !== selected ||
        currentView.current !== viewKey ||
        reader.current !== node
      )
        return;
      const sourceTarget =
        readSource && saved?.target !== readSource
          ? document.getElementById(`source-${readSource}`)
          : null;
      if (sourceTarget && node.contains(sourceTarget))
        node.scrollTop +=
          sourceTarget.getBoundingClientRect().top - node.getBoundingClientRect().top;
      else {
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
  }, [detail, selected, viewKey, readSource, destination]);
  const setViewUrl = (chat: string, branchId = '', source = '') => {
    const params = new URLSearchParams({ chat });
    if (branchId) params.set('branch', branchId);
    if (source) params.set('source', source);
    history.pushState(null, '', `?${params}`);
  };
  const select = (id: string) => {
    navigationEpoch.current++;
    savePosition();
    rememberCursor();
    const target = sessionStorage.getItem(`branch:${id}`) || '';
    setViewUrl(id, target);
    setSelected(id);
    setViewedBranch(target);
    setReadSource('');
    setDestination('story');
    restoredView.current = '';
  };
  const chooseBranch = (id: string) => {
    navigationEpoch.current++;
    savePosition();
    rememberCursor();
    setViewUrl(selected, id);
    sessionStorage.setItem(`branch:${selected}`, id);
    setViewedBranch(id);
    setReadSource('');
    restoredView.current = '';
  };
  const chooseSource = (id: string) => {
    navigationEpoch.current++;
    savePosition();
    restoredView.current = '';
    setReadSource(id);
    setViewUrl(selected, viewedBranch, id);
    if (id === readSource) {
      const key = currentView.current;
      requestAnimationFrame(() => {
        const node = reader.current,
          target = document.getElementById(`source-${id}`);
        if (currentView.current === key && node && target && node.contains(target)) {
          node.scrollTop += target.getBoundingClientRect().top - node.getBoundingClientRect().top;
          restoredView.current = key;
        }
      });
    }
  };
  useEffect(() => {
    const onPop = () => {
      navigationEpoch.current++;
      savePosition();
      rememberCursor();
      const view = initialView();
      setSelected(view.chat);
      setViewedBranch(view.branch);
      setReadSource(view.source);
      setDestination('story');
      restoredView.current = '';
    };
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, [savePosition, rememberCursor]);
  function showLibrary() {
    navigationEpoch.current++;
    savePosition();
    setDestination('library');
    restoredView.current = '';
  }
  function canReuseRun(id: string) {
    const run = visibleRuns.find((run) => run.id === id);
    return (
      !!run &&
      !run.sourceRevision &&
      ['failed', 'cancelled', 'interrupted', 'refused', 'partial'].includes(run.status)
    );
  }
  function activeRun() {
    return visibleRuns.find((run) =>
      ['queued', 'running', 'waiting_for_state'].includes(run.status)
    );
  }
  const reuseBlocked =
    !!activeRun() ||
    submitting.includes(viewKey) ||
    quickBusy ||
    profileDirty ||
    !detail ||
    !!sessionStorage.getItem(`pending-profile:${selected}`) ||
    !!readCommand(`command:${selected}${viewedBranch ? `:${viewedBranch}` : ''}`);
  function editRunRequest(id: string) {
    if (reuseBlocked || !canReuseRun(id) || submitLocks.current.has(viewKey)) return;
    const run = visibleRuns.find((run) => run.id === id)!;
    if (draft && draft !== run.request && !window.confirm('작성 중인 입력을 이 요청으로 바꿀까요?'))
      return;
    editDraft(run.request);
    editLoreContextReset(run.snapshot.loreContextReset === true);
    setNotice('이전 요청을 가져왔어요. 편집 후 보내면 현재 설정으로 새로 생성해요.');
    input.current?.focus();
  }
  async function generate(retryRunId?: string) {
    if (
      !detail ||
      detail.chat.id !== selected ||
      submitLocks.current.has(viewKey) ||
      sessionStorage.getItem(`pending-profile:${selected}`)
    )
      return;
    if (activeRun() || (retryRunId && (reuseBlocked || !canReuseRun(retryRunId)))) return;
    const retryRun = retryRunId ? visibleRuns.find((run) => run.id === retryRunId)! : undefined;
    const chat = detail.chat;
    const sentKey = draftKey;
    const sentView = viewKey;
    const commandKey = `command:${chat.id}${viewedBranch ? `:${viewedBranch}` : ''}`;
    const previous = readCommand(commandKey);
    if (!previous && !retryRun && !draft.trim()) return;
    // An uncertain request keeps its original snapshot as well as its key.
    // A newer draft is never silently sent after recovering that earlier request.
    const payload: RunPayload = previous?.payload ?? {
      request: retryRun?.request ?? draft,
      ...((retryRun ? retryRun.snapshot.loreContextReset : loreResetDraft)
        ? { loreContextReset: true }
        : {}),
      ...(!retryRun && sessionStorage.getItem(`package-request-draft:${draftKey}`)
        ? { packageRequestId: sessionStorage.getItem(`package-request-draft:${draftKey}`)! }
        : {}),
      expectedRevision: branch ? branch.headRevision : chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      ...(viewedBranch && branch ? { branchId: branch.id } : {}),
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
    sessionStorage.setItem(
      commandKey,
      JSON.stringify({
        payload: JSON.stringify(payload),
        id: idempotencyKey,
        startedAt,
        ...(preserveDraft ? { preserveDraft: true } : {}),
      })
    );
    track('sending');
    submitLocks.current.add(sentView);
    setSubmitting([...submitLocks.current]);
    setError('');
    setNotice('');
    let accepted = false;
    try {
      const admitted = await api<Run>(`/chats/${chat.id}/runs`, { ...payload, idempotencyKey });
      track('accepted', admitted.id);
      accepted = true;
      clearCommand(commandKey, idempotencyKey);
      if (!preserveDraft && payload.loreContextReset) {
        sessionStorage.removeItem(`lore-reset:${sentKey}`);
        if (currentDraftKey.current === sentKey) setLoreResetDraft(false);
      }
      if (!preserveDraft && sessionStorage.getItem(sentKey) === sentDraft) {
        sessionStorage.removeItem(sentKey);
        sessionStorage.removeItem(`package-request-draft:${sentKey}`);
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
  }
  const forkLocks = useRef(new Set<string>());
  const [forking, setForking] = useState<string[]>([]);
  async function fork(sourceId: string) {
    const chatId = selected;
    const epoch = navigationEpoch.current;
    const lock = `${chatId}:${sourceId}`;
    const key = `fork-command:${lock}`;
    if (!detail?.runs.some((run) => run.sourceRevision === sourceId) || forkLocks.current.has(lock))
      return;
    forkLocks.current.add(lock);
    setForking([...forkLocks.current]);
    const idempotencyKey = sessionStorage.getItem(key) || crypto.randomUUID();
    sessionStorage.setItem(key, idempotencyKey);
    setError('');
    try {
      const next = await api<Chat>(`/chats/${chatId}/fork`, {
        fromRevision: sourceId,
        idempotencyKey,
      });
      if (sessionStorage.getItem(key) === idempotencyKey) sessionStorage.removeItem(key);
      setChats((current) => [next, ...current.filter((chat) => chat.id !== next.id)]);
      if (current.current === chatId && navigationEpoch.current === epoch) select(next.id);
    } catch (error) {
      if (definiteRejection(error) && sessionStorage.getItem(key) === idempotencyKey)
        sessionStorage.removeItem(key);
      if (current.current === chatId && navigationEpoch.current === epoch)
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
  async function quickChange(kind: 'combination' | 'persona' | 'model' | 'module', value: string) {
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
        const prompt = profile.prompts?.main;
        if (!preset || !prompt || refValue(preset.prompt) !== refValue(prompt))
          throw new Error('현재 프롬프트의 창작 프리셋을 선택해 주세요.');
        const key = refValue(prompt);
        await api(
          `/chats/${chatId}/profile`,
          {
            expectedRevision: profile.revision,
            attachments: profile.attachments,
            personaReference: profile.personaReference,
            routes: profile.routes,
            image: profile.image,
            promptControls: {
              ...profile.promptControls,
              [key]: {
                values: preset.values,
                combinations: profile.promptControls?.[key]?.combinations ?? [],
              },
            },
          },
          'PUT'
        );
      } else if (kind === 'module') {
        const epoch = navigationEpoch.current;
        let module = library.contents.find((item) => refValue(item) === value);
        if (!module) {
          const separator = value.lastIndexOf('@');
          const id = value.slice(0, separator);
          const revision = Number(value.slice(separator + 1));
          if (separator <= 0 || !Number.isSafeInteger(revision) || revision < 1)
            throw new Error('추가할 모듈 버전을 다시 선택해 주세요.');
          // An immutable selection remains usable after a newer library revision is saved.
          module = await api<Content>(`/revisions/content/${encodeURIComponent(id)}/${revision}`);
        }
        if (current.current !== chatId || navigationEpoch.current !== epoch) return false;
        if (refValue(module) !== value || (!module.package && !module.hasPackage))
          throw new Error('추가할 모듈을 찾지 못했어요. 서재를 다시 확인해 주세요.');
        const existing = profile.packageAttachments ?? [];
        if (existing.some((item) => item.id === module.id && item.role === 'module'))
          throw new Error('이미 연결한 모듈이에요. 채팅 설정에서 확인해 주세요.');
        await api(
          `/chats/${chatId}/profile`,
          {
            expectedRevision: profile.revision,
            attachments: profile.attachments,
            personaReference: profile.personaReference,
            routes: profile.routes,
            image: profile.image,
            packageAttachments: [
              ...existing,
              { id: module.id, revision: module.revision, role: 'module' },
            ],
            packageValues: profile.packageValues,
          },
          'PUT'
        );
      } else {
        let contents = [...library.contents, ...archivedContents];
        if (kind === 'persona') {
          const missing = profile.attachments.filter(
            (ref) => !contents.some((item) => refValue(item) === refValue(ref))
          );
          // Resolve pinned revisions before classifying and replacing a persona.
          contents = [
            ...contents,
            ...(await Promise.all(
              missing.map((ref) => api<Content>(`/revisions/content/${ref.id}/${ref.revision}`))
            )),
          ];
        }
        const persona = contents.find(
          (item) =>
            (item.kind === 'persona' || item.package || item.hasPackage) && refValue(item) === value
        );
        const model = library.models.find((item) => item.id === value);
        if (
          kind === 'model' &&
          model &&
          value !== (profile.routes.main?.id ?? '') &&
          !canSelectModel(model)
        )
          throw new Error(
            '비활성 모델이거나 연결 권한을 확인할 수 없어요. 모델 목록을 다시 확인해 주세요.'
          );
        if ((kind === 'persona' && value && !persona) || (kind === 'model' && value && !model))
          throw new Error('선택한 설정을 찾지 못했어요. 목록을 다시 확인해 주세요.');
        const packaged = !!persona && (!!persona.package || !!persona.hasPackage);
        const attachments =
          kind === 'persona'
            ? [
                ...profile.attachments.filter(
                  (ref) =>
                    !contents.some(
                      (item) => item.kind === 'persona' && refValue(item) === refValue(ref)
                    )
                ),
                ...(persona && !packaged ? [{ id: persona.id, revision: persona.revision }] : []),
              ]
            : profile.attachments;
        const packageAttachments =
          kind === 'persona'
            ? [...(profile.packageAttachments ?? [])]
                .filter((r) => r.role !== 'persona')
                .concat(
                  persona && packaged
                    ? [{ id: persona.id, revision: persona.revision, role: 'persona' }]
                    : []
                )
            : profile.packageAttachments;
        const packageKeys = new Set(
          packageAttachments?.map((r) => `${r.id}@${r.revision}:${r.role}`)
        );
        const routes =
          kind === 'model'
            ? { ...profile.routes, main: model ? { id: model.id } : null }
            : profile.routes;
        await api(
          `/chats/${chatId}/profile`,
          {
            expectedRevision: profile.revision,
            attachments,
            personaReference: profile.personaReference,
            routes,
            image: profile.image,
            ...(packageAttachments
              ? {
                  packageAttachments,
                  packageValues: Object.fromEntries(
                    Object.entries(profile.packageValues ?? {}).filter(([key]) =>
                      packageKeys.has(key)
                    )
                  ),
                }
              : {}),
          },
          'PUT'
        );
      }
      if (current.current === chatId) setNotice('다음 요청에 적용할 설정을 저장했어요.');
      await refresh(chatId);
      return true;
    } catch (error) {
      if (current.current === chatId)
        setError(error instanceof Error ? error.message : '설정을 저장하지 못했어요.');
      await refresh(chatId).catch(() => undefined);
      return false;
    } finally {
      quickLock.current = false;
      setQuickBusy(false);
    }
  }
  const active = visibleRuns.find(
    (run) =>
      run.status === 'queued' || run.status === 'running' || run.status === 'waiting_for_state'
  );
  const allContents = [...(library?.contents ?? []), ...archivedContents];
  const attachmentsReady =
    !!detail?.profile &&
    detail.profile.attachments.every((ref) =>
      allContents.some((item) => refValue(item) === refValue(ref))
    );
  const pendingCommand = selected
    ? readCommand(`command:${selected}${viewedBranch ? `:${viewedBranch}` : ''}`)
    : null;
  const pendingRequest = pendingCommand?.payload.request ?? null;
  const loreContextReset = pendingCommand
    ? pendingCommand.payload.loreContextReset === true
    : loreResetDraft;
  const attached = allContents.filter((item) =>
    detail?.profile?.attachments.some((ref) => refValue(ref) === refValue(item))
  );
  const packageContent = (role: string) => {
    const r = detail?.profile?.packageAttachments?.find((r) => r.role === role);
    return r ? allContents.find((c) => refValue(c) === refValue(r)) : undefined;
  };
  const bot = packageContent('bot') ?? attached.find((item) => item.kind === 'bot');
  const persona = packageContent('persona') ?? attached.find((item) => item.kind === 'persona');
  const profileAsset = detail?.assets?.find((asset) => asset.allowedUse !== 'inline');
  const tasks = detail
    ? (detail.reader.activity?.filter((item) =>
        ['running', 'queued', 'waiting_for_state'].includes(item.status)
      ).length ??
      detail.runs.filter((run) => ['running', 'queued', 'waiting_for_state'].includes(run.status))
        .length + detail.reader.activeJobs)
    : 0;
  const pendingProfile = !!selected && !!sessionStorage.getItem(`pending-profile:${selected}`);
  const trackedRequest = requestActivities[viewKey];
  // Settled runs may leave the bounded activity projection. Do not resurrect their admission indicator.
  const settledOutsideActivity =
    trackedRequest?.status === 'accepted' &&
    (!detail ||
      (detail.runs.some(
        (run) =>
          run.id === trackedRequest.runId &&
          !['queued', 'running', 'waiting_for_state'].includes(run.status)
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
    requestActivity,
    chats,
    selected,
    viewedBranch,
    readSource,
    detail,
    library,
    quickModels,
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
    submitting,
    attachmentsReady,
    pendingRequest,
    loreContextReset,
    forking,
    setError,
    setNotice,
    setProfileDirty,
    refresh,
    loadChats,
    loadLibrary,
    savePosition,
    rememberCursor,
    editDraft,
    editLoreContextReset,
    select,
    chooseBranch,
    chooseSource,
    showLibrary,
    generate,
    canReuseRun,
    reuseBlocked,
    editRunRequest,
    fork,
    quickChange,
  };
}
export type StoryState = ReturnType<typeof useStory>;
