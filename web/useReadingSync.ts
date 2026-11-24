import { t } from './i18n.js';
import { readerLocation, THEME_BODY_SCROLL_SELECTOR } from './theme-body-scroll.js';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { ReaderTarget } from '../core/reader-target.js';
import type { ReadingPosition, ReadingPositions } from '../core/reading-state.js';
import { browserClientId } from './browser-client.js';
import { api } from './api.js';
import { readReadingPosition } from './story-storage.js';
import { readOptionalStorage, writeOptionalStorage } from './optional-storage.js';
import { storageKeys } from './storage-keys.js';

function positionIdentity(position: ReadingPosition): string {
  const target = position.target;
  return JSON.stringify([
    target.chatId,
    target.sourceId,
    target.representation,
    target.contentHash ?? null,
    target.blockAnchor ?? null,
    target.offsetRatio ?? null,
  ]);
}

export function captureReaderLocation(
  reader: HTMLElement,
  chatId: string,
  article?: HTMLElement
): ReaderTarget | null {
  return targetAtReaderLocation(chatId, readerLocation(reader, article));
}

export function targetAtReaderLocation(
  chatId: string,
  location: ReturnType<typeof readerLocation>
): ReaderTarget | null {
  if (!location?.source.dataset.sourceId) return null;
  const { source, block, top } = location;
  const rect = block?.getBoundingClientRect();
  const anchor = block?.dataset.blockAnchor?.split(' ')[0];
  return {
    chatId,
    sourceId: source.dataset.sourceId!,
    representation: source.dataset.representation === 'translation' ? 'translation' : 'original',
    ...(source.dataset.contentHash ? { contentHash: source.dataset.contentHash } : {}),
    ...(anchor
      ? {
          blockAnchor: anchor,
          offsetRatio: rect
            ? Math.max(0, Math.min(1, (top - rect.top) / Math.max(1, rect.height)))
            : 0,
        }
      : {}),
  };
}

export function useReadingSync(options: {
  chatId: string;
  reader: RefObject<HTMLDivElement | null>;
  storageKey: string;
  capture: (target: HTMLElement | null) => ReaderTarget | null;
  onResume: (target: ReaderTarget) => void;
}) {
  const [clientId] = useState(browserClientId);
  const key = options.chatId;
  const current = useRef(options);
  current.current = options;
  const acknowledged = useRef(new Map<string, string>());
  const [state, setState] = useState<{
    key: string;
    own: ReadingPosition | null;
    other: ReadingPosition | null;
  }>({ key: '', own: null, other: null });
  const actions = useRef<{
    key: string;
    remember: (target: ReaderTarget) => void;
    offer: (target: ReaderTarget, revision: number) => void;
    flushScroll: () => boolean;
  } | null>(null);
  const pending = useRef<ReaderTarget | null>(null);
  const flushScroll = useCallback(() => actions.current?.flushScroll() ?? false, []);
  const remember = useCallback((target: ReaderTarget) => {
    if (actions.current?.key === target.chatId) actions.current.remember(target);
    else pending.current = target;
  }, []);
  useEffect(() => {
    const { chatId } = current.current;
    if (!chatId) return;
    let alive = true,
      loaded = false,
      saving = false,
      revision = 0;
    let dirty: ReaderTarget | null = null;
    let touched = false;
    let userUntil = 0;
    let scrollTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingScroll: { target: HTMLElement; user: boolean } | undefined;
    let loading: Promise<void> | null = null;
    const controller = new AbortController();
    const path = `/chats/${encodeURIComponent(chatId)}/reading-position`;
    const query = new URLSearchParams({ clientId });
    const load = (): Promise<void> => {
      if (loading) return loading;
      loading = (async () => {
        try {
          const value = await api<ReadingPositions>(
            `${path}?${query}`,
            undefined,
            'GET',
            AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])
          );
          if (!alive) return;
          revision = Math.max(revision, value.own?.revision ?? 0);
          loaded = true;
          setState({ key, ...value });
        } catch {}
      })().finally(() => {
        loading = null;
      });
      return loading;
    };
    const save = async () => {
      if (!dirty || saving || !loaded) return;
      const target = dirty;
      dirty = null;
      saving = true;
      let acceptedRevision: number | undefined;
      try {
        const saved = await api<ReadingPosition>(
          path,
          { clientId, expectedRevision: revision, target },
          'PUT',
          AbortSignal.timeout(5000)
        );
        revision = Math.max(revision, saved.revision);
        acceptedRevision = saved.revision;
        if (alive) setState((old) => (old.key === key ? { ...old, own: saved } : old));
      } catch {
        loaded = false;
      } finally {
        saving = false;
        if (
          acceptedRevision !== undefined &&
          dirty &&
          (!alive || document.visibilityState === 'hidden')
        ) {
          if (revision > acceptedRevision) {
            dirty = null;
          } else if (!alive && actions.current?.key === key) {
            actions.current.offer(dirty, acceptedRevision);
            dirty = null;
          } else void save();
        }
      }
    };
    const rememberTarget = (target: ReaderTarget) => {
      touched = true;
      dirty = target;
      if (loaded) void save();
    };
    const offerTarget = (target: ReaderTarget, previousRevision: number) => {
      if (!alive || touched) return;
      const ready = loading ?? (loaded ? Promise.resolve() : load());
      void ready.then(() => {
        if (!alive || touched || !loaded || revision > previousRevision) return;
        revision = previousRevision;
        rememberTarget(target);
      });
    };
    const input = (event: Event) => {
      const node = current.current.reader.current;
      if (node && event.composedPath().includes(node)) userUntil = performance.now() + 2500;
    };
    const keyboard = (event: KeyboardEvent) => {
      if (
        !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key) ||
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      )
        return;
      userUntil = performance.now() + 2500;
    };
    const captureScroll = () => {
      clearTimeout(scrollTimer);
      scrollTimer = undefined;
      if (!pendingScroll) return false;
      const { target, user } = pendingScroll;
      pendingScroll = undefined;
      const { chatId: currentChat, reader, capture } = current.current;
      if (currentChat !== chatId || !reader.current?.contains(target)) return false;
      const captured = capture(target);
      if (user && captured) {
        touched = true;
        dirty = captured;
      }
      return true;
    };
    const scroll = (event: Event) => {
      const node = current.current.reader.current;
      const target = event.target;
      const body =
        target instanceof HTMLElement && target.matches(THEME_BODY_SCROLL_SELECTOR) ? target : null;
      if (!node || (target !== node && (!body || !node.contains(body)))) return;
      pendingScroll = {
        target: body ?? node,
        user: performance.now() <= userUntil && document.visibilityState === 'visible',
      };
      scrollTimer ??= setTimeout(captureScroll, 150);
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden') {
        captureScroll();
        void save();
      } else
        void load().then(() => {
          if (alive) return save();
        });
    };
    const pagehide = () => {
      if (!captureScroll() && current.current.chatId === chatId) current.current.capture(null);
      void save();
    };
    actions.current = {
      key,
      remember: rememberTarget,
      offer: offerTarget,
      flushScroll: captureScroll,
    };
    if (pending.current?.chatId === chatId) {
      touched = true;
      dirty = pending.current;
      pending.current = null;
    }
    void load().then(() => {
      if (alive) return save();
    });
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && loaded && dirty) void save();
    }, 10_000);
    document.addEventListener('scroll', scroll, true);
    for (const type of ['wheel', 'touchmove', 'pointerdown'])
      document.addEventListener(type, input, { capture: true, passive: true });
    document.addEventListener('keydown', keyboard, true);
    document.addEventListener('visibilitychange', visibility);
    addEventListener('pagehide', pagehide);
    return () => {
      captureScroll();
      alive = false;
      controller.abort();
      clearInterval(timer);
      void save();
      if (actions.current?.key === key) actions.current = null;
      document.removeEventListener('scroll', scroll, true);
      for (const type of ['wheel', 'touchmove', 'pointerdown'])
        document.removeEventListener(type, input, true);
      document.removeEventListener('keydown', keyboard, true);
      document.removeEventListener('visibilitychange', visibility);
      removeEventListener('pagehide', pagehide);
    };
  }, [key, clientId]);
  const other =
    state.key === key && state.other && (!state.own || state.other.updatedAt > state.own.updatedAt)
      ? state.other
      : null;
  const candidate =
    other ??
    (state.key === key && !readReadingPosition(options.storageKey)?.source ? state.own : null);
  const acknowledgmentKey = storageKeys.readingSuggestion(key);
  let acknowledgedIdentity = acknowledged.current.get(key);
  if (acknowledgedIdentity === undefined)
    acknowledgedIdentity = readOptionalStorage('session', acknowledgmentKey) ?? undefined;
  const resume =
    candidate && positionIdentity(candidate) !== acknowledgedIdentity ? candidate : null;
  const acknowledge = () => {
    if (!resume) return;
    const identity = positionIdentity(resume);
    acknowledged.current.set(key, identity);
    writeOptionalStorage('session', acknowledgmentKey, identity);
    setState((old) => ({ ...old }));
  };
  return {
    flushScroll,
    remember,
    other: resume,
    resumeOrigin: other ? ('other-device' as const) : ('saved' as const),
    resumeLabel: other ? t('main.resumeOther') : t('main.resumeSaved'),
    resumeOther: () => {
      if (resume) {
        acknowledge();
        current.current.onResume(resume.target);
      }
    },
    dismiss: acknowledge,
  };
}
