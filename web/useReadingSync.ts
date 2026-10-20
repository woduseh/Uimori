import { t } from './i18n.js';
import { readerLocation, THEME_BODY_SCROLL_SELECTOR } from './theme-body-scroll.js';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { ReaderTarget } from '../core/reader-target.js';
import type { ReadingPosition, ReadingPositions } from '../core/reading-state.js';
import { browserClientId } from './browser-client.js';
import { api } from './api.js';
import { readReadingPosition } from './story-storage.js';

function positionIdentity(position: ReadingPosition): string {
  const target = position.target;
  // Saving the same location again changes its revision, but is not a new reading suggestion.
  return JSON.stringify([
    target.chatId,
    target.sourceId,
    target.representation,
    target.contentHash ?? null,
    target.blockAnchor ?? null,
    target.offsetRatio ?? null,
  ]);
}

/** Source/paragraph identity survives viewport and font-size differences; pixels stay local. */
export function captureReaderLocation(
  reader: HTMLElement,
  chatId: string,
  article?: HTMLElement
): ReaderTarget | null {
  const location = readerLocation(reader, article);
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

/** Server checkpoints are optional. Never gate the reader or move an already-open page. */
export function useReadingSync(options: {
  chatId: string;
  reader: RefObject<HTMLDivElement | null>;
  storageKey: string;
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
  } | null>(null);
  const pending = useRef<ReaderTarget | null>(null);
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
    let userUntil = 0;
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
        } catch {
          // A failed refresh does not invalidate an earlier successful read.
          // Save failures still suspend further writes until the next reader check.
        }
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
      try {
        // A stalled best-effort checkpoint must not hold later reading writes forever.
        const saved = await api<ReadingPosition>(
          path,
          { clientId, expectedRevision: revision, target },
          'PUT',
          AbortSignal.timeout(5000)
        );
        revision = Math.max(revision, saved.revision);
        if (alive) setState((old) => (old.key === key ? { ...old, own: saved } : old));
      } catch {
        // Do not blindly replay an uncertain or conflicting write.
        // Refresh the revision when the reader next opens or regains focus.
        loaded = false;
      } finally {
        saving = false;
      }
    };
    const rememberTarget = (target: ReaderTarget) => {
      dirty = target;
      if (loaded) void save();
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
    const scroll = (event: Event) => {
      const node = current.current.reader.current;
      const target = event.target;
      const body =
        target instanceof HTMLElement && target.matches(THEME_BODY_SCROLL_SELECTOR) ? target : null;
      if (
        !node ||
        (target !== node && (!body || !node.contains(body))) ||
        performance.now() > userUntil ||
        document.visibilityState !== 'visible'
      )
        return;
      dirty = captureReaderLocation(
        node,
        chatId,
        body?.closest<HTMLElement>('[data-source-id][data-representation]') ?? undefined
      );
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden') void save();
      else
        void load().then(() => {
          if (alive) return save();
        });
    };
    const pagehide = () => {
      void save();
    };
    actions.current = { key, remember: rememberTarget };
    if (pending.current?.chatId === chatId) {
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
  const acknowledgmentKey = `uimori:reading-suggestion:${key}`;
  let acknowledgedIdentity = acknowledged.current.get(key);
  if (acknowledgedIdentity === undefined) {
    try {
      acknowledgedIdentity = sessionStorage.getItem(acknowledgmentKey) ?? undefined;
    } catch {
      // The mounted reader still remembers acknowledgments when session storage is unavailable.
    }
  }
  const resume =
    candidate && positionIdentity(candidate) !== acknowledgedIdentity ? candidate : null;
  const acknowledge = () => {
    if (!resume) return;
    const identity = positionIdentity(resume);
    acknowledged.current.set(key, identity);
    try {
      sessionStorage.setItem(acknowledgmentKey, identity);
    } catch {
      // Reading and local position preservation never depend on optional session storage.
    }
    setState((old) => ({ ...old }));
  };
  return {
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
