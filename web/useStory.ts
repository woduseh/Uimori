import { message as descriptor, useI18n } from './i18n.js';
import { UiError, uiMessage } from './ui-message.js';
import { IMAGE_INPUT_MAX_BYTES } from '../core/image-limits.js';
import { REQUEST_IMAGE_MAX_COUNT, type RequestImageUpload } from '../core/request-images.js';
import {
  clearRequestDraft,
  readRequestDraft,
  rememberRequestDraft,
  writeRequestDraft,
  type DraftImage,
  type RequestDraft,
} from './request-image-draft.js';
import { createComposerDraft } from './composer-draft.js';
import {
  dispatchQueuedRequest,
  mergeReturnedText,
  type QueuedHandoff,
  type QueuedRequest,
  type QueuedReturnReason,
  type QueuedRevisions,
} from './queued-send.js';
import {
  localReadingBlock,
  readerLocation,
  THEME_BODY_SCROLL_SELECTOR,
} from './theme-body-scroll.js';
import { captureReaderLocation, targetAtReaderLocation, useReadingSync } from './useReadingSync.js';
import {
  paragraphPosition,
  readerTargetFromUrl,
  readerTargetUrl,
  type ReaderTarget,
} from '../core/reader-target.js';
import { displayTranslationJob, latestTranslation } from '../core/translation-display.js';
import { markArrivalWhenShown } from './arrival-mark.js';
import { canDismissReaderRun, readerConversation } from '../core/reader-conversation.js';
import { createReaderSync } from './reader-sync.js';
import { liveStream, watchLive } from './live-stream.js';
import { helperDataFrame, promptWorkspaceFrame } from './live-frames.js';
import { helperRefreshSpacing } from './poll-delays.js';
import { type ReaderResponse, restoreReaderBlockText } from './reader-blocks.js';
import {
  transitionReaderNavigation,
  type ReaderNavigation,
  type ReaderNavigationAction,
} from './reader-navigation.js';
import {
  clearReadingPosition,
  readReadingPosition,
  readDraftCursor,
  writeViewCache,
  type ReadingPosition,
} from './story-storage.js';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { subscribeAppHistory } from './app-history.js';
import type { Chat, ReaderDetail, RunReceipt } from '../core/types.js';
import type {
  ChatProfile,
  Content,
  CurrentPrompt,
  Library,
  PromptPreset,
} from '../core/product.js';
import type { ChatOptionState } from '../core/chat-options.js';
import type { SceneDeletionResult } from '../core/scene-deletion.js';
import { promptEndpoints } from '#contracts';
import {
  api,
  apiBinary,
  ApiError,
  callEndpoint,
  definiteRejection,
  libraryChangedKey,
} from './api.js';
import { requestChatFork } from './fork-request.js';
import { usePromptWorkspace } from './usePromptWorkspace.js';
import { useInputTranslation } from './useInputTranslation.js';
import { useCodexContentWarning } from './useCodexContentWarning.js';
import { combinationOwner, matchesPromptCombination } from '../core/prompt-combinations.js';
import { refValue } from './content-ref.js';
import { isModelSelectable } from './model-selection.js';
import {
  retainReaderNavigation,
  type ReaderNavigationPosition,
} from './reader-navigation-scroll.js';
import {
  readOptionalJson,
  removeOptionalStorage,
  writeOptionalStorage,
} from './optional-storage.js';
import { forgetMissingBots, forgetMissingChats, storageKeys } from './storage-keys.js';
import { errorDescriptor } from './api-errors.js';

const lastWorkspaceKey = storageKeys.lastWorkspace;
function semanticReaderTarget(search: string): ReaderTarget | null {
  const params = new URLSearchParams(search);
  return ['mode', 'anchor', 'contentHash', 'position'].some((key) => params.has(key))
    ? readerTargetFromUrl(search)
    : null;
}

function initialView(restore = false) {
  const params = new URLSearchParams(location.search);
  let chat = params.get('chat') || '';
  if (restore && !location.search && !location.hash) {
    const saved = readOptionalJson('local', lastWorkspaceKey, null) as {
      destination?: unknown;
      chatId?: unknown;
    } | null;
    if (saved?.destination === 'story' && typeof saved.chatId === 'string') chat = saved.chatId;
  }
  return {
    chat,
    source: params.get('source') || '',
    destination:
      chat && params.get('workspace') !== 'library' ? ('story' as const) : ('library' as const),
  };
}
type RunPayload = {
  retryOf?: string;
  retryMode?: 'replace' | 'copy';
  judgmentRecovery?: true;
  editedRequest?: boolean;
  loreContextReset?: boolean;
  request: string;
  requestImages?: RequestImageUpload[];
  expectedRevision: string | null;
  expectedSettingsRevision: number;
  expectedProfileRevision?: number;
};
type PendingCommand = {
  payload: string;
  id: string;
  preserveDraft?: boolean;
  startedAt?: string;
  draftToken?: string;
};
export type RequestActivity = {
  id: string;
  startedAt: string;
  runId?: string;
  status: 'sending' | 'accepted' | 'uncertain' | 'failed';
  confirmationBlocked?: boolean;
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
      (!payload.request.trim() && !payload.requestImages?.length && !payload.retryOf) ||
      !(payload.expectedRevision === null || typeof payload.expectedRevision === 'string') ||
      !Number.isInteger(payload.expectedSettingsRevision)
    )
      return null;
    if (
      payload.expectedProfileRevision !== undefined &&
      !Number.isInteger(payload.expectedProfileRevision)
    )
      return null;
    if (
      payload.judgmentRecovery !== undefined &&
      (payload.judgmentRecovery !== true || !payload.retryOf || payload.editedRequest)
    )
      return null;
    if (payload.retryOf !== undefined && (typeof payload.retryOf !== 'string' || !payload.retryOf))
      return null;
    if (
      payload.retryMode !== undefined &&
      (!payload.retryOf ||
        !['replace', 'copy'].includes(payload.retryMode) ||
        payload.judgmentRecovery)
    )
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
async function readQueuedRevisions(chatId: string): Promise<QueuedRevisions> {
  const chat = `/chats/${encodeURIComponent(chatId)}`;
  const [profile, options, workspace] = await Promise.all([
    api<ChatProfile>(`${chat}/profile`),
    api<ChatOptionState>(`${chat}/options`),
    callEndpoint(promptEndpoints.readModelWorkspace),
  ]);
  return {
    profileRevision: profile.revision,
    optionsRevision: options.revision,
    workspaceRevision: workspace.revision,
  };
}
type ParkedQueue = { text: string; loreContextReset: boolean; reason?: QueuedReturnReason };
const queuedRequestKey = storageKeys.queuedRequest;
function readParkedQueue(chatId: string): ParkedQueue | null {
  const value = readOptionalJson('session', queuedRequestKey(chatId), null) as ParkedQueue | null;
  return value && typeof value.text === 'string' && typeof value.loreContextReset === 'boolean'
    ? value
    : null;
}
function parkQueue(chatId: string, value: ParkedQueue): boolean {
  return writeOptionalStorage('session', queuedRequestKey(chatId), JSON.stringify(value));
}

type Position = ReadingPosition;
const readReader = async (path: string) => restoreReaderBlockText(await api<ReaderResponse>(path));
function changedParagraphPosition(detail: ReaderDetail, target: ReaderTarget, paragraph: number) {
  const source = detail.sources.find((item) => item.id === target.sourceId);
  if (!source) return null;
  if (target.representation === 'original')
    return source.blocks?.length ? paragraphPosition(source.text, source.blocks, paragraph) : null;
  const job = displayTranslationJob(source, latestTranslation(source, detail.jobs));
  const text = job?.result?.text;
  const blocks = job?.translationLayout?.blocks;
  return typeof text === 'string' && blocks?.length
    ? paragraphPosition(text, blocks, paragraph)
    : null;
}

export function useStory() {
  useI18n();
  const {
    workspace: promptWorkspace,
    error: promptWorkspaceError,
    refresh: refreshPromptWorkspace,
  } = usePromptWorkspace();
  const [initial] = useState(() => initialView(true));
  const [chats, setChats] = useState<Chat[]>([]);
  const [view, setView] = useState<ReaderNavigation>(() => ({ ...initial, epoch: 0 }));
  const navigation = useRef(view);
  const { chat: selected, source: readSource, destination } = view;
  const [loadedDetail, setDetail] = useState<ReaderDetail | null>(null);
  const [readerLoad, setReaderLoad] = useState({ key: '', epoch: -1, pending: false, error: '' });
  const [readingSourceId, setReadingSourceId] = useState('');
  const [library, setLibrary] = useState<Library | null>(null);
  const [libraryError, setLibraryError] = useState('');
  const detail = loadedDetail?.chat.id === selected ? loadedDetail : null;
  const [archivedContents, setArchivedContents] = useState<Content[]>([]);
  const [composerDraft] = useState(createComposerDraft);
  const draftIdentity = useRef({ text: '', revision: 0 });
  const requestDraft = useRef<RequestDraft>({ token: '', text: '', images: [] });
  const [draftImages, setDraftImages] = useState<DraftImage[]>([]);
  const [draftRecovery, setDraftRecovery] = useState<RequestDraft | null>(null);
  const draftRecoveryRef = useRef<RequestDraft | null>(null);
  const [draftReady, setDraftReady] = useState(false);
  const [imagesDecoding, setImagesDecoding] = useState(false);
  const decoding = useRef<symbol | null>(null);
  const [errorState, updateError] = useState<{ message: string; code: string | null }>({
    message: '',
    code: null,
  });
  const error = errorState.message;
  const errorCode = errorState.code;
  const setError = useCallback((value: string | Error | ((current: string) => string)) => {
    updateError((old) => {
      if (typeof value === 'function') {
        const message = value(old.message);
        return { message, code: message ? old.code : null };
      }
      return {
        message: value instanceof Error ? errorDescriptor(value) : value,
        code: value instanceof ApiError ? value.code : null,
      };
    });
  }, []);
  const [notice, setNotice] = useState('');
  const [readerTarget, setReaderTarget] = useState<ReaderTarget | null>(() =>
    semanticReaderTarget(location.search)
  );
  const [loreResetDraft, setLoreResetDraft] = useState(false);
  const loreResetDraftRef = useRef(loreResetDraft);
  loreResetDraftRef.current = loreResetDraft;
  const [submitting, setSubmitting] = useState<string[]>([]);
  const submitLocks = useRef(new Set<string>());
  const cancelLocks = useRef(new Set<string>());
  const [cancelling, setCancelling] = useState<string[]>([]);
  const [requestActivities, setRequestActivities] = useState<Record<string, RequestActivity>>({});
  const [queuedRequest, setQueuedRequest] = useState<QueuedRequest | null>(null);
  const queuedRef = useRef<QueuedRequest | null>(null);
  const [queueNotice, setQueueNotice] = useState<{ chatId: string; message: string } | null>(null);
  const queueActions = useRef({
    restoreParked: (_chatId: string) => {},
    leave: (_chatId: string, _destination: string) => {},
  });
  const [connected, setConnected] = useState(false);
  const [nativeInteractionRevision, setNativeInteractionRevision] = useState(0);
  const [profileDirty, setProfileDirty] = useState(false);
  const [quickBusy, setQuickBusy] = useState(false);
  const codexWarning = useCodexContentWarning();
  useEffect(() => {
    if (destination === 'story' && (!selected || !detail)) return;
    writeOptionalStorage(
      'local',
      lastWorkspaceKey,
      JSON.stringify({
        destination,
        chatId: destination === 'story' ? selected : null,
      })
    );
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
  const arrival = useRef<AbortController | null>(null);
  const cancelNavigationScroll = useRef<(() => void) | null>(null);
  const latestIntent = useRef<{ epoch: number; source: string } | null>(null);
  const readerQuery = useRef({ chat: '', source: '', key: '', epoch: 0 });
  const readerCache = useRef<{ key: string; detail: ReaderDetail } | null>(null);
  const readerSync = useRef<ReturnType<typeof createReaderSync> | null>(null);
  const navigate = useCallback((action: ReaderNavigationAction) => {
    const previous = navigation.current;
    const next = transitionReaderNavigation(previous, action);
    navigation.current = next;
    if (next.epoch !== previous.epoch) {
      restoredView.current = '';
    }
    setView(next);
  }, []);
  const savedPosition = readReadingPosition(storageKeys.readingPosition(selected));
  readerQuery.current = {
    chat: selected,
    epoch: view.epoch,
    source:
      !selected && !readSource
        ? ''
        : (savedPosition?.target === readSource ? savedPosition?.source : readSource) ||
          savedPosition?.source ||
          '',
    key: `${selected}:${readSource}`,
  };
  const explicitReadingIntent = useRef<{ chatId: string; sourceId: string } | null>(null);
  const refresh = useCallback(
    async (id: string, incremental = false) => {
      if (
        navigation.current.chat !== id ||
        readerQuery.current.chat !== id ||
        readerQuery.current.epoch !== navigation.current.epoch
      )
        return;
      if (document.hidden || navigation.current.destination !== 'story') {
        readerSync.current?.request(0, true);
        return;
      }
      const version = ++refreshVersion.current;
      const epoch = navigation.current.epoch;
      const query = readerQuery.current;
      const applicable = () => {
        if (
          navigation.current.chat !== id ||
          navigation.current.epoch !== epoch ||
          readerQuery.current.key !== query.key ||
          refreshVersion.current !== version
        )
          return false;
        if (document.hidden || navigation.current.destination !== 'story') {
          readerSync.current?.request(0, true);
          return false;
        }
        return true;
      };
      setReaderLoad((old) => ({
        key: query.key,
        epoch,
        pending: true,
        error: old.key === query.key && old.epoch === epoch ? old.error : '',
      }));
      try {
        const cached = readerCache.current?.key === query.key ? readerCache.current.detail : null;
        const params = new URLSearchParams({ source: cached?.reader?.order[0] || query.source });
        if (incremental && cached?.reader) {
          params.set('since', String(cached.reader.cursor));
          params.set('known', cached.reader.order.join(','));
          if (cached.reader.navigationUnchanged !== undefined)
            params.set('navigationCursor', String(cached.reader.cursor));
        }
        let value: ReaderDetail;
        let replacementSource: string | undefined;
        try {
          value = await readReader(`/chats/${id}/reader?${params}`);
        } catch (error) {
          if (!applicable()) return;
          if (!cached || !(error instanceof ApiError) || error.status !== 404) throw error;
          const rebasedParams = new URLSearchParams();
          value = await readReader(`/chats/${id}/reader?${rebasedParams}`);
          if (!applicable()) return;
          replacementSource =
            value.reader.navigation[
              Math.min(cached.reader.start, value.reader.navigation.length - 1)
            ]?.id ?? '';
          if (replacementSource && !value.reader.order.includes(replacementSource)) {
            rebasedParams.set('source', replacementSource);
            value = await readReader(`/chats/${id}/reader?${rebasedParams}`);
          }
        }
        if (applicable()) {
          const changed = new Set(value.sources.map((source) => source.id));
          const available = new Map(
            [...(cached?.sources ?? []), ...value.sources].map((source) => [source.id, source])
          );
          const merged = {
            ...value,
            reader:
              value.reader.navigationUnchanged && cached
                ? { ...value.reader, navigation: cached.reader.navigation }
                : value.reader,
            assets: value.assets ?? cached?.assets ?? [],
            sources: value.reader!.order.map((id) => available.get(id)!).filter(Boolean),
            jobs: [
              ...(cached?.jobs ?? []).filter(
                (job) =>
                  !changed.has(job.sourceRevision) &&
                  value.reader!.order.includes(job.sourceRevision)
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
            clearReadingPosition(storageKeys.readingPosition(id));
            cacheKey = `${id}:${replacementSource}`;
            readerQuery.current = { ...query, source: replacementSource, key: cacheKey };
            navigate({ kind: 'rebase-source', source: replacementSource });
            const url = new URL(location.href);
            if (replacementSource) url.searchParams.set('source', replacementSource);
            else url.searchParams.delete('source');
            history.replaceState(null, '', url);
          }
          readerCache.current = { key: cacheKey, detail: merged };
          setDetail(merged);
          if (
            value.runs.some(
              (run) =>
                canDismissReaderRun(run) &&
                run.snapshot.replacement &&
                cached?.runs.some(
                  (previous) =>
                    previous.id === run.id && ['queued', 'running'].includes(previous.status)
                )
            )
          )
            setNotice(descriptor('shared.replacementCancelled'));
          setReaderLoad({
            key: cacheKey,
            epoch: navigation.current.epoch,
            pending: false,
            error: '',
          });
          setChats((old) => old.map((chat) => (chat.id === id ? value.chat : chat)));
          return true;
        }
      } catch (error) {
        if (applicable())
          setReaderLoad({
            key: query.key,
            epoch,
            pending: false,
            error: errorDescriptor(error),
          });
        throw error;
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
    forgetMissingChats(new Set(chats.map((chat) => chat.id)));
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
      for (const key of ['chat', 'source']) url.searchParams.delete(key);
      history.replaceState(null, '', url);
    }
  }, [navigate]);
  const libraryRequest = useRef(0);
  const libraryFlight = useRef<Promise<void> | null>(null);
  const libraryDirty = useRef(false);
  const loadLibrary = useCallback((): Promise<void> => {
    libraryDirty.current = true;
    if (libraryFlight.current) return libraryFlight.current;
    setLibraryError('');
    const request = ++libraryRequest.current;
    const work = async () => {
      do {
        libraryDirty.current = false;
        try {
          const value = await api<Library>('/library?view=summary');
          if (libraryRequest.current === request) {
            setLibrary(value);
            setLibraryError('');
            forgetMissingBots(new Set(value.contents.map((item) => item.id)));
          }
        } catch (caught) {
          if (libraryRequest.current === request) setLibraryError((caught as Error).message);
          throw caught;
        }
      } while (libraryDirty.current && libraryRequest.current === request);
    };
    libraryFlight.current = work().finally(() => {
      libraryFlight.current = null;
    });
    return libraryFlight.current;
  }, []);
  const retryLibrary = useCallback(() => {
    setError((current) => (current === libraryError ? '' : current));
    return loadLibrary();
  }, [libraryError, loadLibrary, setError]);
  useEffect(() => {
    const refreshLibrary = () => {
      void loadLibrary().catch((caught) => setError(caught));
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === libraryChangedKey) refreshLibrary();
    };
    addEventListener('storage', onStorage);
    addEventListener('focus', refreshLibrary);
    const live = watchLive({
      match: (frame) => helperDataFrame(frame) || promptWorkspaceFrame(frame),
      refresh: () => loadLibrary().catch((caught) => setError(caught)),
      minIntervalMs: helperRefreshSpacing,
    });
    return () => {
      removeEventListener('storage', onStorage);
      removeEventListener('focus', refreshLibrary);
      live.dispose();
      libraryRequest.current++;
    };
  }, [loadLibrary, setError]);
  useEffect(() => {
    void Promise.all([loadChats(), loadLibrary()]).catch((e) => setError(e));
  }, [loadChats, loadLibrary, setError]);
  useEffect(() => {
    readerCache.current = null;
    setDetail(null);
    setError('');
    setNotice('');
    setConnected(false);
    setProfileDirty(false);
    setArchivedContents([]);
    const live = liveStream();
    if (!selected) return;
    let alive = true;
    const sync = createReaderSync({
      refresh: (incremental) => refresh(selected, incremental),
      cursor: () => readerCache.current?.detail.reader.cursor ?? -1,
      onError: (error) => {
        if (readerCache.current?.key === readerQuery.current.key)
          setError(error instanceof Error ? error : String(error));
      },
      active: navigation.current.destination === 'story' && !document.hidden,
    });
    readerSync.current = sync;
    const visibility = () =>
      sync.setActive(navigation.current.destination === 'story' && !document.hidden);
    document.addEventListener('visibilitychange', visibility);
    const detach = live.attachChat(selected, {
      open() {
        if (alive) setConnected(true);
      },
      error() {
        sync.disconnected();
        if (alive) setConnected(false);
      },
      message(data) {
        if (!alive || navigation.current.chat !== selected) return;
        const message = JSON.parse(data) as { kind: string; seq?: number; entityId?: string };
        if (message.kind === 'illustration-references.updated' || message.kind === 'snapshot')
          dispatchEvent(
            new CustomEvent('uimori-illustration-references-changed', { detail: selected })
          );
        if (
          message.kind === 'native.interaction.requested' ||
          message.kind === 'native.interaction.resolved' ||
          message.kind === 'snapshot' ||
          /^run\.(completed|failed|cancelled|interrupted)$/u.test(message.kind)
        )
          setNativeInteractionRevision((revision) => revision + 1);
        if (message.kind === 'chat.deleted') {
          detach();
          void loadChats().catch((e) => {
            if (alive) setError(e);
          });
          return;
        }
        if (message.kind === 'profile.updated')
          void loadLibrary().catch((e) => {
            if (alive) setError(e);
          });
        sync.request(message.seq ?? 0, message.kind === 'snapshot');
      },
    });
    return () => {
      alive = false;
      sync.dispose();
      if (readerSync.current === sync) readerSync.current = null;
      document.removeEventListener('visibilitychange', visibility);
      detach();
    };
  }, [selected, refresh, loadChats, loadLibrary, setError]);
  useEffect(() => {
    readerSync.current?.setActive(destination === 'story' && !document.hidden);
  }, [destination]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Address changes and committed navigation intents reload the query held by refresh's stable refs.
  useEffect(() => {
    let alive = true;
    const epoch = view.epoch;
    if (selected && destination === 'story') {
      restoredView.current = '';
      if (readerCache.current?.key !== readerQuery.current.key) setDetail(null);
      if (document.hidden) {
        readerSync.current?.request(0, true);
        return;
      }
      const load = refresh(selected);
      readerSync.current?.track(load);
      void load.catch((e) => {
        if (
          alive &&
          navigation.current.epoch === epoch &&
          readerCache.current?.key === readerQuery.current.key
        )
          setError(e);
      });
    }
    return () => {
      alive = false;
    };
  }, [selected, readSource, destination, view.epoch, refresh]);
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
        if (alive) setError(e);
      });
    return () => {
      alive = false;
    };
  }, [attachmentKey, library, selected]);
  const viewKey = selected;
  const draftKey = storageKeys.draft(selected);
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
  const activeReadingSource = useRef<HTMLElement | null>(null);
  const capturePosition = useCallback(
    (target: HTMLElement | null) => {
      const node = reader.current;
      if (!node || !selected || navigation.current.epoch !== view.epoch) return null;
      if (target?.matches(THEME_BODY_SCROLL_SELECTOR))
        activeReadingSource.current = target.closest('[data-source-id][data-representation]');
      else if (target === node) activeReadingSource.current = null;
      const active = activeReadingSource.current;
      const preferred =
        active &&
        node.contains(active) &&
        active.getBoundingClientRect().bottom > node.getBoundingClientRect().top &&
        active.getBoundingClientRect().top < node.getBoundingClientRect().bottom
          ? active
          : undefined;
      const location = readerLocation(node, preferred);
      if (restoredView.current === viewKey) {
        const block = localReadingBlock(node, location);
        const position: Position = {
          target: readSource,
          source: block?.closest<HTMLElement>('[data-source-id]')?.dataset.sourceId ?? '',
          anchor: block?.dataset.blockAnchor?.split(' ')[0] || '',
          offset: block
            ? block.getBoundingClientRect().top -
              (location?.scrollport ?? node).getBoundingClientRect().top
            : 0,
          top: node.scrollTop,
        };
        writeViewCache(storageKeys.readingPosition(viewKey), position);
        setReadingSourceId(location?.source.dataset.sourceId ?? '');
      }
      return targetAtReaderLocation(selected, location);
    },
    [selected, view.epoch, viewKey, readSource]
  );
  const readingSync = useReadingSync({
    chatId: destination === 'story' ? selected : '',
    reader,
    capture: capturePosition,
    storageKey: storageKeys.readingPosition(selected),
    onResume: (target) => openTarget(target),
  });
  const savePosition = useCallback(() => {
    if (!readingSync.flushScroll()) capturePosition(null);
  }, [capturePosition, readingSync.flushScroll]);
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
          const intent = explicitReadingIntent.current;
          if (intent?.chatId === selected) {
            const article = document.getElementById(`source-${intent.sourceId}`);
            if (article && node.contains(article)) {
              explicitReadingIntent.current = null;
              const target = captureReaderLocation(node, selected, article);
              if (target) readingSync.remember(target);
            }
          }
        }
      );
    },
    [selected, viewKey, readingSync.remember]
  );
  useLayoutEffect(() => {
    const text = sessionStorage.getItem(draftKey) || '';
    draftIdentity.current = { text, revision: draftIdentity.current.revision + 1 };
    composerDraft.write(text);
    setDraftImages([]);
    setDraftRecovery(null);
    draftRecoveryRef.current = null;
    setDraftReady(false);
    decoding.current = null;
    setImagesDecoding(false);
    const initialToken = crypto.randomUUID();
    requestDraft.current = { token: initialToken, text, images: [] };
    let alive = true;
    void readRequestDraft(draftKey)
      .then(({ saved, conflict }) => {
        if (!alive || requestDraft.current.token !== initialToken) return;
        if (conflict) {
          draftRecoveryRef.current = conflict;
          setDraftRecovery(conflict);
        }
        if (saved) {
          requestDraft.current = saved;
          draftIdentity.current = {
            text: saved.text,
            revision: draftIdentity.current.revision + 1,
          };
          sessionStorage.setItem(draftKey, saved.text);
          composerDraft.write(saved.text);
          setDraftImages(saved.images);
        }
      })
      .catch(() => {
        if (alive) setError('입력 초안을 복구하지 못했어요. 브라우저 저장 공간을 확인해 주세요.');
      })
      .finally(() => {
        if (!alive) return;
        setDraftReady(true);
        queueActions.current.restoreParked(draftKey.slice('draft:'.length));
      });
    setLoreResetDraft(sessionStorage.getItem(storageKeys.loreReset(draftKey)) === 'true');
    const cursor = readDraftCursor(storageKeys.draftCursor(draftKey));
    const frame = requestAnimationFrame(() => {
      if (cursor && currentDraftKey.current === draftKey)
        input.current?.setSelectionRange(cursor.start, cursor.end);
    });
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
    };
  }, [draftKey, setError, composerDraft]);
  const rememberCursor = useCallback(() => {
    const node = input.current;
    if (node)
      writeViewCache(storageKeys.draftCursor(draftKey), {
        start: node.selectionStart,
        end: node.selectionEnd,
      });
  }, [draftKey]);
  function persistDraft(value: RequestDraft) {
    const key = draftKey;
    requestDraft.current = value;
    if (draftRecoveryRef.current) {
      rememberRequestDraft(key, value);
      return;
    }
    void writeRequestDraft(key, value).catch(() => {
      if (currentDraftKey.current === key)
        setError(
          '입력 초안을 기기에 저장하지 못했어요. 화면을 닫기 전에 전송하거나 파일을 보관해 주세요.'
        );
    });
  }
  function resolveDraftRecovery(restore: boolean) {
    const found = draftRecoveryRef.current;
    if (!found) return;
    draftRecoveryRef.current = null;
    setDraftRecovery(null);
    const images = restore ? found.images : [];
    persistDraft({ ...requestDraft.current, token: crypto.randomUUID(), images });
    setDraftImages(images);
  }
  async function addDraftImages(files: File[]) {
    if (
      !draftReady ||
      draftRecoveryRef.current ||
      decoding.current ||
      submitLocks.current.has(viewKey) ||
      !files.length
    )
      return;
    if (files.some((file) => file.size > IMAGE_INPUT_MAX_BYTES)) {
      setError(descriptor('main.story2'));
      return;
    }
    if (files.some((file) => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))) {
      setError(descriptor('main.story3'));
      return;
    }
    if (requestDraft.current.images.length + files.length > REQUEST_IMAGE_MAX_COUNT) {
      setError(descriptor('main.story4'));
      return;
    }
    const scope = { key: draftKey, epoch: navigation.current.epoch };
    const operation = Symbol();
    decoding.current = operation;
    setImagesDecoding(true);
    try {
      const additions = await Promise.all(
        files.map(async (file) => {
          const bitmap = await createImageBitmap(file);
          const dimensions = { width: bitmap.width, height: bitmap.height };
          bitmap.close();
          return {
            id: crypto.randomUUID(),
            name: file.name || '참고 이미지',
            blob: file,
            ...dimensions,
          };
        })
      );
      if (
        decoding.current !== operation ||
        currentDraftKey.current !== scope.key ||
        navigation.current.epoch !== scope.epoch
      )
        return;
      const images = [...requestDraft.current.images, ...additions];
      persistDraft({ ...requestDraft.current, token: crypto.randomUUID(), images });
      setDraftImages(images);
    } catch {
      if (
        decoding.current === operation &&
        currentDraftKey.current === scope.key &&
        navigation.current.epoch === scope.epoch
      )
        setError(descriptor('main.story5'));
    } finally {
      if (decoding.current === operation) {
        decoding.current = null;
        setImagesDecoding(false);
      }
    }
  }
  function removeDraftImage(id: string) {
    if (!draftReady || submitLocks.current.has(viewKey)) return;
    const images = requestDraft.current.images.filter((image) => image.id !== id);
    persistDraft({ ...requestDraft.current, token: crypto.randomUUID(), images });
    setDraftImages(images);
  }
  function editDraft(value: string) {
    persistDraft({ ...requestDraft.current, token: crypto.randomUUID(), text: value });
    draftIdentity.current = { text: value, revision: draftIdentity.current.revision + 1 };
    composerDraft.write(value);
  }
  function editLoreContextReset(value: boolean) {
    if (readCommand(storageKeys.command(selected))) return;
    setLoreResetDraft(value);
    if (value) sessionStorage.setItem(storageKeys.loreReset(draftKey), 'true');
    else sessionStorage.removeItem(storageKeys.loreReset(draftKey));
  }
  const inputTranslation = useInputTranslation({
    draftKey,
    epoch: view.epoch,
    chatId: selected,
    readDraft: () => ({
      ...draftIdentity.current,
      key: currentDraftKey.current,
      epoch: navigation.current.epoch,
    }),
    writeDraft: editDraft,
    available: () =>
      draftReady &&
      !!detail &&
      navigation.current.destination === 'story' &&
      navigation.current.chat === selected &&
      !submitLocks.current.has(viewKey) &&
      !readCommand(storageKeys.command(selected)) &&
      !sessionStorage.getItem(storageKeys.pendingProfile(selected)),
  });
  const sources = useMemo(() => detail?.sources ?? [], [detail]);
  const visibleRuns = detail?.runs.filter((run) => !run.supersededBy) ?? [];
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
    const saved = readReadingPosition(storageKeys.readingPosition(viewKey));
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
      } else if (
        readerTarget?.chatId === selected &&
        readerTarget.sourceId === readSource &&
        document.getElementById(`source-${readSource}`)
      ) {
        const element = document.getElementById(`source-${readSource}`)!;
        const validHash =
          !readerTarget.contentHash || element.dataset.contentHash === readerTarget.contentHash;
        const changed =
          readerTarget.changedParagraph != null
            ? changedParagraphPosition(detail, readerTarget, readerTarget.changedParagraph)
            : null;
        const anchor = readerTarget.blockAnchor ?? changed?.anchor;
        holdNavigationPosition(node, {
          kind: 'source',
          element,
          ...(validHash && anchor
            ? readerTarget.blockAnchor
              ? { anchor, ratio: readerTarget.offsetRatio ?? 0, fallbackToSource: true }
              : { anchor, ratio: changed?.ratio, share: changed?.share, fallbackToSource: true }
            : {}),
        });
        if (!validHash) setNotice(descriptor('main.story6'));
        if (readerTarget.changedParagraph !== undefined) {
          arrival.current?.abort();
          arrival.current = new AbortController();
          const source = readSource;
          markArrivalWhenShown(
            () =>
              changed
                ? (document.getElementById(`block-${source}-${changed.anchor}`) ??
                  document
                    .getElementById(`source-${source}`)
                    ?.querySelector(`[data-block-anchor~="${CSS.escape(changed.anchor)}"]`) ??
                  null)
                : document.getElementById(`source-${source}`),
            arrival.current.signal,
            false
          );
          setReaderTarget((current) =>
            current === readerTarget ? { ...current, changedParagraph: undefined } : current
          );
        }
      } else if (sourceTarget && node.contains(sourceTarget)) {
        holdNavigationPosition(node, { kind: 'source', element: sourceTarget });
      } else {
        const article = saved?.source ? document.getElementById(`source-${saved.source}`) : null;
        if (saved?.anchor && article && node.contains(article)) {
          holdNavigationPosition(node, {
            kind: 'source',
            element: article,
            anchor: saved.anchor,
            offset: saved.offset,
            outerTop: saved.top,
          });
        } else node.scrollTop = saved?.top || 0;
      }
      restoredView.current = viewKey;
      requestAnimationFrame(() => {
        if (currentView.current === viewKey && reader.current === node)
          setReadingSourceId(readerLocation(node)?.source.dataset.sourceId ?? '');
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [detail, selected, viewKey, readSource, destination, holdNavigationPosition, readerTarget]);
  const setViewUrl = (chat: string, source = '') => {
    const params = new URLSearchParams({ chat });
    if (source) params.set('source', source);
    history.pushState(null, '', `?${params}`);
  };
  const select = (id: string) => {
    explicitReadingIntent.current = null;
    setReaderTarget(null);
    savePosition();
    rememberCursor();
    setViewUrl(id);
    navigate({ kind: 'chat', chat: id });
  };
  const chooseSource = (id: string, toEnd = false) => {
    explicitReadingIntent.current = { chatId: selected, sourceId: id };
    setReaderTarget(null);
    cancelNavigationScroll.current?.();
    savePosition();
    navigate({ kind: 'source', source: id });
    latestIntent.current = toEnd ? { epoch: navigation.current.epoch, source: id } : null;
    setViewUrl(selected, id);
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
  const storyUiFollow = useRef<{ chatId: string; runId: string; epoch: number } | null>(null);
  const beginStoryUiAdmission = () => {
    const { chat: chatId, epoch, destination: target } = navigation.current;
    return (run: RunReceipt) => {
      if (
        target !== 'story' ||
        run.chatId !== chatId ||
        navigation.current.chat !== chatId ||
        navigation.current.epoch !== epoch ||
        navigation.current.destination !== 'story'
      )
        return;
      storyUiFollow.current = null;
      if (run.sourceRevision) {
        chooseSource(run.sourceRevision, true);
      } else {
        chooseSource(run.parentRevision ?? '', true);
        if (run.status === 'queued' || run.status === 'running')
          storyUiFollow.current = { chatId, runId: run.id, epoch: navigation.current.epoch };
      }
    };
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: chooseSource acts on the current navigation after the epoch check.
  useEffect(() => {
    const follow = storyUiFollow.current;
    if (!follow) return;
    if (
      navigation.current.chat !== follow.chatId ||
      navigation.current.epoch !== follow.epoch ||
      navigation.current.destination !== 'story'
    ) {
      storyUiFollow.current = null;
      return;
    }
    const run = detail?.runs.find((entry) => entry.id === follow.runId);
    if (!run) return;
    if (run.sourceRevision) {
      storyUiFollow.current = null;
      chooseSource(run.sourceRevision, true);
    } else if (!['queued', 'running'].includes(run.status)) storyUiFollow.current = null;
  }, [detail, view.epoch]);
  const sceneDeletionCompletion = (chatId: string) => {
    const epoch = navigation.current.epoch;
    return async (result: SceneDeletionResult) => {
      let reportEpoch = epoch;
      const current = () =>
        navigation.current.chat === chatId &&
        navigation.current.epoch === reportEpoch &&
        navigation.current.destination === 'story';
      try {
        if (current() && result.chatId === chatId) {
          chooseSource(result.headRevision ?? '', true);
          reportEpoch = navigation.current.epoch;
        }
        await loadChats();
      } catch (cause) {
        if (current()) setError(cause instanceof Error ? cause : errorDescriptor(cause));
      }
    };
  };
  const openTarget = (target: ReaderTarget, replace = false) => {
    explicitReadingIntent.current = replace
      ? null
      : { chatId: target.chatId, sourceId: target.sourceId };
    cancelNavigationScroll.current?.();
    savePosition();
    rememberCursor();
    setReaderTarget({ ...target });
    writeOptionalStorage('session', storageKeys.readerMode(target.sourceId), target.representation);
    if (replace) history.replaceState(null, '', readerTargetUrl(target));
    else history.pushState(null, '', readerTargetUrl(target));
    navigate({
      kind: 'restore',
      view: {
        chat: target.chatId,
        source: target.sourceId,
        destination: 'story',
      },
    });
  };
  const chooseLatest = () => {
    const last = detail?.reader.navigation.at(-1);
    if (last) chooseSource(last.id, true);
  };
  useEffect(() => {
    const onPop = () => {
      savePosition();
      rememberCursor();
      setReaderTarget(semanticReaderTarget(location.search));
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
      (!!run.request.trim() || !!run.snapshot.requestImages?.length) &&
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
    !!sessionStorage.getItem(storageKeys.pendingProfile(selected)) ||
    !!readCommand(storageKeys.command(selected));
  async function generate(
    retryRunId?: string,
    editedRequest?: string,
    judgmentRecovery = false,
    retryMode?: 'replace' | 'copy',
    queued?: QueuedHandoff
  ): Promise<boolean> {
    if (
      !detail ||
      detail.chat.id !== selected ||
      submitLocks.current.has(viewKey) ||
      sessionStorage.getItem(storageKeys.pendingProfile(selected))
    )
      return false;
    if (editedRequest !== undefined && !retryRunId) return false;
    const retryRun = retryRunId ? visibleRuns.find((run) => run.id === retryRunId)! : undefined;
    const chat = detail.chat;
    const sentKey = draftKey;
    const sentView = viewKey;
    const sentEpoch = navigation.current.epoch;
    const commandKey = storageKeys.command(chat.id);
    const previous = readCommand(commandKey);
    if (queued && previous) return false;
    if ((!previous && activeRun()) || (retryRunId && (reuseBlocked || !canReuseRun(retryRunId))))
      return false;
    if (
      !draftReady ||
      decoding.current ||
      (!previous && !retryRun && !queued && !composerDraft.read().trim() && !draftImages.length)
    )
      return false;
    if (
      editedRequest !== undefined &&
      !editedRequest.trim() &&
      !retryRun?.snapshot.requestImages?.length
    )
      return false;
    const sentDraftToken = queued
      ? ''
      : previous
        ? (previous.record.draftToken ??
          (requestDraft.current.text === previous.payload.request
            ? requestDraft.current.token
            : ''))
        : requestDraft.current.token;
    const sentImages = queued ? [] : requestDraft.current.images;
    const payload: RunPayload = previous?.payload ?? {
      request: editedRequest ?? retryRun?.request ?? queued?.text ?? composerDraft.read(),
      ...(editedRequest !== undefined ? { editedRequest: true } : {}),
      ...(retryRun
        ? {
            retryOf: retryRun.id,
            ...(retryMode ? { retryMode } : {}),
            ...(judgmentRecovery ? { judgmentRecovery: true as const } : {}),
          }
        : {}),
      ...((
        retryRun
          ? retryRun.snapshot.loreContextReset
          : queued
            ? queued.loreContextReset
            : loreResetDraft
      )
        ? { loreContextReset: true }
        : {}),
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      ...(detail.profile ? { expectedProfileRevision: detail.profile.revision } : {}),
    };
    const sentTranslationId = queued ? undefined : inputTranslation.beginSend();
    if (!previous && !payload.judgmentRecovery) {
      const preflightPath = `/chats/${chat.id}/codex-content-preflight`;
      const preflight = {
        role: 'main',
        text: payload.request,
        ...((payload.requestImages?.length ??
        retryRun?.snapshot.requestImages?.length ??
        sentImages.length)
          ? {
              imageCount:
                payload.requestImages?.length ??
                retryRun?.snapshot.requestImages?.length ??
                sentImages.length,
            }
          : {}),
        ...(payload.retryOf ? { retryRunId: payload.retryOf } : {}),
      };
      if (queued) {
        if (await codexWarning.needsConfirmation(preflightPath, preflight)) {
          queued.state = 'confirmation';
          return false;
        }
      } else if (!(await codexWarning.check(preflightPath, preflight, 'main'))) return false;
      const draftChanged =
        !retryRun &&
        !queued &&
        (requestDraft.current.token !== sentDraftToken ||
          draftIdentity.current.text !== payload.request ||
          loreResetDraftRef.current !== (payload.loreContextReset === true));
      if (
        currentView.current !== sentView ||
        (queued ? queued.left : navigation.current.epoch !== sentEpoch) ||
        draftChanged
      )
        return false;
    }
    if (submitLocks.current.has(sentView)) return false;
    const preserveDraft = !!retryRun || !!queued || previous?.record.preserveDraft === true;
    const idempotencyKey = previous?.record.id ?? crypto.randomUUID();
    const startedAt = previous?.record.startedAt ?? new Date().toISOString();
    const track = (
      status: RequestActivity['status'],
      runId?: string,
      confirmationBlocked = false
    ) =>
      setRequestActivities((old) => ({
        ...old,
        [sentView]: { id: idempotencyKey, startedAt, status, runId, confirmationBlocked },
      }));
    submitLocks.current.add(sentView);
    setSubmitting([...submitLocks.current]);
    let uploadingImages = false;
    try {
      if (!previous && !retryRun && sentImages.length) {
        uploadingImages = true;
        payload.requestImages = [];
        for (const image of sentImages) {
          const uploaded = await apiBinary<{ uploadId: string; sha256: string }>(
            '/uploads',
            image.blob
          );
          payload.requestImages.push({
            uploadId: uploaded.uploadId,
            sha256: uploaded.sha256,
            name: image.name,
          });
        }
        if (
          currentView.current !== sentView ||
          navigation.current.epoch !== sentEpoch ||
          requestDraft.current.token !== sentDraftToken
        ) {
          submitLocks.current.delete(sentView);
          setSubmitting([...submitLocks.current]);
          return false;
        }
      }
      uploadingImages = false;
      if (!previous && sessionStorage.getItem(commandKey)) {
        submitLocks.current.delete(sentView);
        setSubmitting([...submitLocks.current]);
        setError(descriptor('main.story7'));
        return false;
      }
      if (!preserveDraft) rememberRequestDraft(sentKey, requestDraft.current);
      sessionStorage.setItem(
        commandKey,
        JSON.stringify({
          payload: JSON.stringify(payload),
          id: idempotencyKey,
          startedAt,
          draftToken: sentDraftToken,
          ...(preserveDraft ? { preserveDraft: true } : {}),
        })
      );
      if (queued) {
        removeOptionalStorage('session', queuedRequestKey(chat.id));
        queued.state = 'committed';
      }
    } catch (cause) {
      submitLocks.current.delete(sentView);
      setSubmitting([...submitLocks.current]);
      if (currentView.current === sentView && navigation.current.epoch === sentEpoch)
        setError(
          uploadingImages
            ? cause instanceof Error
              ? cause.message
              : descriptor('main.story8')
            : descriptor('main.story9')
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
        ? await api<RunReceipt>(
            `/runs/${encodeURIComponent(payload.retryOf)}/${payload.judgmentRecovery ? 'rejudge' : 'retry'}`,
            {
              idempotencyKey,
              ...(payload.editedRequest ? { request: payload.request } : {}),
              ...(payload.retryMode ? { mode: payload.retryMode } : {}),
            }
          )
        : await api<RunReceipt>(`/chats/${chat.id}/runs`, { ...payload, idempotencyKey });
      track('accepted', admitted.id);
      accepted = true;
      clearCommand(commandKey, idempotencyKey);
      if (!preserveDraft) inputTranslation.accepted(sentKey, sentTranslationId);
      if (payload.editedRequest && payload.retryOf)
        sessionStorage.removeItem(storageKeys.requestEdit(payload.retryOf));
      if (!preserveDraft && payload.loreContextReset) {
        sessionStorage.removeItem(storageKeys.loreReset(sentKey));
        if (currentDraftKey.current === sentKey) setLoreResetDraft(false);
      }
      if (!preserveDraft) {
        await clearRequestDraft(sentKey, sentDraftToken).catch(() => {
          if (currentView.current === sentView) setError(descriptor('main.story10'));
        });
        if (currentDraftKey.current === sentKey && requestDraft.current.token === sentDraftToken) {
          sessionStorage.removeItem(sentKey);
          requestDraft.current = { token: crypto.randomUUID(), text: '', images: [] };
          draftIdentity.current = { text: '', revision: draftIdentity.current.revision + 1 };
          composerDraft.write('');
          setDraftImages([]);
        }
      }
      if (currentView.current === sentView)
        setNotice(
          previous
            ? sessionStorage.getItem(sentKey)
              ? descriptor('main.story11')
              : descriptor('main.story12')
            : ''
        );
      if (
        payload.retryOf &&
        admitted.chatId !== chat.id &&
        currentView.current === sentView &&
        navigation.current.epoch === sentEpoch
      ) {
        await loadChats();
        select(admitted.chatId);
      }
    } catch (error) {
      const unresolved = !!previous || !definiteRejection(error);
      track(
        unresolved ? 'uncertain' : 'failed',
        undefined,
        !!previous && error instanceof ApiError && [404, 409].includes(error.status)
      );
      if (!unresolved) clearCommand(commandKey, idempotencyKey);
      if (!unresolved && queued) queued.state = 'rejected';
      if (currentView.current === sentView)
        setError(error instanceof Error ? error : descriptor('main.story13'));
    }
    try {
      await refresh(chat.id);
    } catch {
      if (accepted && currentView.current === sentView) setError(descriptor('main.story14'));
    } finally {
      submitLocks.current.delete(sentView);
      setSubmitting([...submitLocks.current]);
    }
    return accepted;
  }
  const forkLocks = useRef(new Set<string>());
  const [forking, setForking] = useState<string[]>([]);
  const [forkOrigin, setForkOrigin] = useState<{
    id: string;
    title: string | null;
    forkId: string;
  } | null>(null);
  async function fork(sourceId: string) {
    const chatId = selected;
    const epoch = navigation.current.epoch;
    const lock = `${chatId}:${sourceId}`;
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
          title: chats.find((chat) => chat.id === chatId)?.title ?? null,
          forkId: next.id,
        });
        select(next.id);
      }
    } catch (error) {
      if (navigation.current.chat === chatId && navigation.current.epoch === epoch)
        setError(error instanceof Error ? error.message : descriptor('main.story15'));
    } finally {
      forkLocks.current.delete(lock);
      setForking([...forkLocks.current]);
    }
  }
  async function copyChat(chatId: string) {
    const original = chats.find((chat) => chat.id === chatId);
    if (!original || [...forkLocks.current].some((key) => key.startsWith(`${chatId}:`))) return;
    const epoch = navigation.current.epoch;
    const lock = `${chatId}:${original.headRevision ?? 'empty'}`;
    forkLocks.current.add(lock);
    setForking([...forkLocks.current]);
    setError('');
    try {
      const next = await requestChatFork(chatId, original.headRevision);
      setChats((current) => [next, ...current.filter((chat) => chat.id !== next.id)]);
      if (navigation.current.epoch === epoch) {
        setForkOrigin({ id: chatId, title: original.title, forkId: next.id });
        select(next.id);
      }
    } catch (error) {
      if (navigation.current.epoch === epoch)
        setError(error instanceof Error ? error.message : descriptor('recent.copyFailed'));
    } finally {
      forkLocks.current.delete(lock);
      setForking([...forkLocks.current]);
    }
  }
  const quickLock = useRef(false);
  const pinnedPromptId = detail?.profile?.pinned?.mainPromptPresetId;
  const pinnedMetadata = library?.promptPresets?.find(
    (item) => item.id === pinnedPromptId && item.role === 'main'
  );
  const pinId = pinnedMetadata?.id,
    pinRevision = pinnedMetadata?.revision;
  const [loadedPin, setLoadedPin] = useState<PromptPreset | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!pinId || pinRevision === undefined) {
      setLoadedPin(null);
      return;
    }
    void api<PromptPreset>(`/prompt-presets/${encodeURIComponent(pinId)}`)
      .then((value) => {
        if (!cancelled) setLoadedPin(value);
      })
      .catch((cause) => {
        if (!cancelled) {
          setLoadedPin(null);
          setError(cause as Error);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pinId, pinRevision, setError]);
  const pinnedPrompt =
    loadedPin?.id === pinnedPromptId && loadedPin?.revision === pinnedMetadata?.revision
      ? loadedPin
      : null;
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
  async function quickChange(kind: 'combination' | 'persona' | 'module' | 'model', value: string) {
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
    const epoch = navigation.current.epoch;
    quickLock.current = true;
    setQuickBusy(true);
    setError('');
    setNotice('');
    let modelWriteAttempted = false;
    let completion = descriptor('main.story22');
    try {
      if (kind === 'model') {
        const model = library.models.find((item) => item.id === value);
        if (value && (!model || !isModelSelectable(model, library.models, library.connections)))
          throw new UiError(uiMessage('main.modelPickerInvalid'));
        if ((profile.pinned?.mainModel?.id ?? '') === value) return true;
        modelWriteAttempted = true;
        await api(
          `/chats/${chatId}/profile`,
          {
            expectedRevision: profile.revision,
            image: profile.image,
            pinned: {
              ...profile.pinned,
              mainModel: model ? { id: model.id } : undefined,
            },
          },
          'PUT'
        );
        if (navigation.current.chat !== chatId || navigation.current.epoch !== epoch) return false;
        try {
          const refreshed = await refresh(chatId);
          if (refreshed && navigation.current.chat === chatId && navigation.current.epoch === epoch)
            setNotice(descriptor('main.story22'));
        } catch {
          if (navigation.current.chat === chatId && navigation.current.epoch === epoch)
            setError(descriptor('main.modelPickerRefreshFailed'));
        }
        return navigation.current.chat === chatId && navigation.current.epoch === epoch;
      }
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
          throw new UiError(uiMessage('main.story16'));
        {
          const state = await api<ChatOptionState>(`/chats/${chatId}/options`);
          if (
            !matchesPromptCombination(
              preset,
              combinationOwner(currentPrompt, 'main'),
              'main',
              state.program
            )
          )
            throw new UiError(uiMessage('main.story17'));
          await api(`/chats/${chatId}/options/fixed`, {
            expectedRevision: state.revision,
            operationId: crypto.randomUUID(),
            binding: state.binding,
            values: preset.values,
          });
          dispatchEvent(new Event('chat-options-changed'));
          completion = descriptor('main.combinationApplied', { title: preset.title });
        }
      } else if (kind === 'module') {
        const epoch = navigation.current.epoch;
        let module = library.contents.find((item) => refValue(item) === value);
        if (!module) {
          const separator = value.lastIndexOf('@');
          const id = value.slice(0, separator);
          const revision = Number(value.slice(separator + 1));
          if (separator <= 0 || !Number.isSafeInteger(revision) || revision < 1)
            throw new UiError(uiMessage('main.story18'));
          module = await api<Content>(`/content/${encodeURIComponent(id)}`);
        }
        if (navigation.current.chat !== chatId || navigation.current.epoch !== epoch) return false;
        if (!module.package && !module.hasPackage) throw new UiError(uiMessage('main.story19'));
        const existing = profile.packageAttachments ?? [];
        if (existing.some((item) => item.id === module.id && item.role === 'module'))
          throw new UiError(uiMessage('main.story20'));
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
        if (kind === 'persona' && value && !persona) throw new UiError(uiMessage('main.story21'));
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
      if (navigation.current.chat === chatId) setNotice(completion);
      await refresh(chatId);
      return true;
    } catch (error) {
      if (
        navigation.current.chat === chatId &&
        (kind !== 'model' || navigation.current.epoch === epoch)
      )
        setError(
          kind === 'model' && modelWriteAttempted && !definiteRejection(error)
            ? descriptor('main.modelPickerUnknown')
            : error instanceof Error
              ? error
              : descriptor('main.story23')
        );
      await refresh(chatId).catch(() => undefined);
      return false;
    } finally {
      quickLock.current = false;
      setQuickBusy(false);
    }
  }
  const active = visibleRuns.find((run) => run.status === 'queued' || run.status === 'running');
  async function dismissCancelledRun(runId: string) {
    const chatId = selected;
    const epoch = navigation.current.epoch;
    const accepted = await api<{ chatId: string; runId: string; readerDismissed: true }>(
      `/runs/${runId}/dismiss-reader`,
      {}
    );
    if (navigation.current.chat !== chatId || navigation.current.epoch !== epoch) return;
    refreshVersion.current++;
    const cached = readerCache.current;
    if (cached?.key === readerQuery.current.key && cached.detail.chat.id === accepted.chatId) {
      const next: ReaderDetail = {
        ...cached.detail,
        runs: cached.detail.runs.map((run) =>
          run.id === accepted.runId ? { ...run, readerDismissed: true } : run
        ),
        reader: {
          ...cached.detail.reader,
          pendingRunIds: cached.detail.reader.pendingRunIds?.filter((id) => id !== accepted.runId),
        },
      };
      readerCache.current = { ...cached, detail: next };
      setDetail(next);
    }
    setNotice(descriptor('shared.dismissedFromReader'));
    void refresh(chatId).catch(() => undefined);
  }
  async function cancelActive() {
    if (!active || cancelLocks.current.has(active.id)) return;
    const runId = active.id;
    const chatId = selected;
    const epoch = navigation.current.epoch;
    cancelLocks.current.add(runId);
    setCancelling([...cancelLocks.current]);
    try {
      await api(`/runs/${runId}/cancel`, {});
      await refresh(chatId);
    } catch (caught) {
      if (navigation.current.chat === chatId && navigation.current.epoch === epoch)
        setError(caught instanceof Error ? caught : descriptor('main.story24'));
    } finally {
      cancelLocks.current.delete(runId);
      setCancelling([...cancelLocks.current]);
    }
  }

  function returnQueueToDraft(
    chatId: string,
    queue: Pick<ParkedQueue, 'text' | 'loreContextReset'>,
    reason: QueuedReturnReason | null
  ) {
    if (currentDraftKey.current !== storageKeys.draft(chatId)) {
      const parked = parkQueue(chatId, {
        text: queue.text,
        loreContextReset: queue.loreContextReset,
        ...(reason ? { reason } : {}),
      });
      if (!parked) setQueueNotice({ chatId, message: 'chatsettings.m159' });
      return;
    }
    const current = composerDraft.read();
    editDraft(mergeReturnedText(current, queue.text));
    if (queue.loreContextReset) editLoreContextReset(true);
    removeOptionalStorage('session', queuedRequestKey(chatId));
    setQueueNotice(reason ? { chatId, message: `main.queueReturned.${reason}` } : null);
  }
  function takeQueue() {
    const queue = queuedRef.current;
    queuedRef.current = null;
    setQueuedRequest(null);
    return queue;
  }
  queueActions.current = {
    restoreParked: (chatId) => {
      if (queuedRef.current?.chatId === chatId || sendingQueue.current?.chatId === chatId) return;
      const parked = readParkedQueue(chatId);
      if (parked) returnQueueToDraft(chatId, parked, parked.reason ?? 'reload');
    },
    leave: (chatId, target) => {
      const sending = sendingQueue.current;
      if (sending && (sending.chatId !== chatId || target !== 'story')) sending.left = true;
      const queue = queuedRef.current;
      if (!queue || (queue.chatId === chatId && target === 'story')) return;
      takeQueue();
      returnQueueToDraft(queue.chatId, queue, 'left');
    },
  };
  useEffect(() => {
    queueActions.current.leave(selected, destination);
  }, [selected, destination]);
  const queueing = useRef(false);
  const sendingQueue = useRef<QueuedHandoff | null>(null);
  async function queueRequest() {
    const run = activeRun();
    if (
      !detail ||
      detail.chat.id !== selected ||
      !run ||
      !draftReady ||
      decoding.current ||
      queueing.current ||
      submitLocks.current.has(viewKey) ||
      readCommand(storageKeys.command(selected))
    )
      return false;
    if (queuedRef.current) {
      setQueueNotice({ chatId: selected, message: 'main.queueExists' });
      return false;
    }
    if (requestDraft.current.images.length) {
      setQueueNotice({ chatId: selected, message: 'main.queueImages' });
      return false;
    }
    const text = composerDraft.read();
    if (!text.trim()) return false;
    const chatId = selected;
    const token = requestDraft.current.token;
    const loreContextReset = loreResetDraft;
    queueing.current = true;
    let revisions: QueuedRevisions;
    try {
      revisions = await readQueuedRevisions(chatId);
    } catch {
      setQueueNotice({ chatId, message: 'main.queueUnchecked' });
      return false;
    } finally {
      queueing.current = false;
    }
    if (
      navigation.current.chat !== chatId ||
      requestDraft.current.token !== token ||
      loreResetDraftRef.current !== loreContextReset ||
      queuedRef.current
    )
      return false;
    const queue: QueuedRequest = {
      id: crypto.randomUUID(),
      chatId,
      text,
      loreContextReset,
      runId: run.id,
      settingsRevision: detail.chat.settingsRevision,
      ...revisions,
    };
    inputTranslation.accepted(draftKey, inputTranslation.beginSend());
    const parked = parkQueue(chatId, { text, loreContextReset });
    editDraft('');
    if (loreContextReset) editLoreContextReset(false);
    queuedRef.current = queue;
    setQueuedRequest(queue);
    setQueueNotice(parked ? null : { chatId, message: 'chatsettings.m159' });
    return true;
  }
  function cancelQueuedRequest() {
    const queue = takeQueue();
    if (queue) returnQueueToDraft(queue.chatId, queue, null);
  }
  async function sendQueuedRequest(
    blocked: boolean,
    send: (queued: QueuedHandoff) => Promise<boolean>
  ) {
    const queue = takeQueue();
    if (!queue) return;
    const handoff: QueuedHandoff = {
      chatId: queue.chatId,
      text: queue.text,
      loreContextReset: queue.loreContextReset,
      left: false,
      state: 'waiting',
    };
    sendingQueue.current = handoff;
    try {
      await sendQueue(queue, handoff, blocked, send);
    } finally {
      if (sendingQueue.current === handoff) sendingQueue.current = null;
    }
  }
  async function sendQueue(
    queue: QueuedRequest,
    handoff: QueuedHandoff,
    blocked: boolean,
    send: (queued: QueuedHandoff) => Promise<boolean>
  ) {
    await dispatchQueuedRequest(queue, handoff, blocked, {
      here: () =>
        !handoff.left &&
        navigation.current.chat === queue.chatId &&
        navigation.current.destination === 'story',
      readRunStatus: async () =>
        (await api<{ status: string }>(`/runs/${encodeURIComponent(queue.runId)}`)).status,
      currentChat: () => readerCache.current?.detail.chat,
      readRevisions: () => readQueuedRevisions(queue.chatId),
      send,
      giveBack: (reason: QueuedReturnReason) => returnQueueToDraft(queue.chatId, queue, reason),
      committed: (accepted) => {
        if (accepted && navigation.current.chat === queue.chatId)
          setNotice(descriptor('main.queueSent'));
      },
    });
  }

  const allContents = [...(library?.contents ?? []), ...archivedContents];
  const attachmentsReady =
    !!detail?.profile &&
    (detail.profile.packageAttachments ?? []).every((ref) =>
      allContents.some((item) => refValue(item) === refValue(ref))
    );
  const pendingCommand = selected ? readCommand(storageKeys.command(selected)) : null;
  function forgetPendingRequest(expectedId: string) {
    if (!selected || submitLocks.current.has(selected)) return false;
    const key = storageKeys.command(selected);
    try {
      if (readCommand(key)?.record.id !== expectedId) return false;
      clearCommand(key, expectedId);
    } catch {
      setError(descriptor('main.pendingRequestForgetFailed'));
      return false;
    }
    setRequestActivities((old) => {
      if (old[viewKey]?.id !== expectedId) return old;
      const next = { ...old };
      delete next[viewKey];
      return next;
    });
    setError('');
    return true;
  }
  const hasPendingRequest = pendingCommand !== null;
  const pendingRequestText = pendingCommand ? pendingCommand.payload.request : null;
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
  const pendingProfile =
    !!selected && !!sessionStorage.getItem(storageKeys.pendingProfile(selected));
  const trackedRequest = requestActivities[viewKey];
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
    promptWorkspaceError,
    refreshPromptWorkspace,
    currentPrompt,
    pinnedPromptRevision: pinnedPrompt?.revision,
    requestActivity,
    chats,
    selected,
    readSource,
    readingSourceId,
    detail: readerCache.current?.key === readerQuery.current.key ? detail : null,
    readerLoading:
      readerLoad.key === readerQuery.current.key &&
      readerLoad.epoch === view.epoch &&
      readerLoad.pending,
    readerLoadError:
      readerLoad.key === readerQuery.current.key && readerLoad.epoch === view.epoch
        ? readerLoad.error
        : '',
    library,
    libraryError,
    composerDraft,
    draftImages,
    draftReady,
    draftRecovery,
    resolveDraftRecovery,
    imagesDecoding,
    requestImagePreviews: draftImages.map(({ name, width, height }) => ({ name, width, height })),
    addDraftImages,
    removeDraftImage,
    inputTranslation,
    codexWarning,
    error,
    errorCode,
    notice,
    connected,
    nativeInteractionRevision,
    destination,
    profileDirty,
    quickBusy,
    reader,
    input,
    viewKey,
    active,
    cancelling: !!active && cancelling.includes(active.id),
    cancelActive,
    allContents,
    bot,
    persona,
    profileAsset,
    tasks,
    pendingProfile,
    sources,
    visibleRuns,
    conversation,
    submitting,
    attachmentsReady,
    hasPendingRequest,
    pendingRequestText,
    queuedRequest: queuedRequest?.chatId === selected ? queuedRequest : null,
    queueRequest,
    cancelQueuedRequest,
    sendQueuedRequest,
    queueNotice: queueNotice?.chatId === selected ? queueNotice.message : null,
    dismissQueueNotice: () => setQueueNotice(null),
    pendingEditedRunId,
    forgetPendingRequest,
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
    retryLibrary,
    rememberCursor,
    editDraft,
    editLoreContextReset,
    select,
    chooseSource,
    beginStoryUiAdmission,
    sceneDeletionCompletion,
    openTarget,
    readerTarget,
    readingSync,
    chooseLatest,
    showLibrary,
    generate,
    canReuseRun,
    dismissCancelledRun,
    reuseBlocked,
    fork,
    copyChat,
    quickChange,
  };
}
export type StoryState = ReturnType<typeof useStory>;
