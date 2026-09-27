import { useEffect, useRef, useState, type RefObject } from 'react';
import type { ReaderTarget } from '../core/reader-target.js';
import type { ReadingPosition, ReadingPositions } from '../core/reading-state.js';
import { api } from './api.js';
import { readReadingPosition } from './story-storage.js';

export function readingClientId(): string {
  try {
    const saved = localStorage.getItem('uimori:reading-client');
    if (saved && /^[a-f0-9-]{36}$/i.test(saved)) return saved;
    const id = crypto.randomUUID();
    localStorage.setItem('uimori:reading-client', id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}
/** Source/paragraph identity survives viewport and font-size differences; pixels stay local. */
export function captureReaderLocation(
  reader: HTMLElement,
  chatId: string,
  branchId: string,
  article?: HTMLElement
): ReaderTarget | null {
  const top = reader.getBoundingClientRect().top + 12;
  const scenes = article
    ? [article]
    : [...reader.querySelectorAll<HTMLElement>('[data-source-id][data-representation]')];
  const source = scenes.find((item) => item.getBoundingClientRect().bottom > top);
  if (!source?.dataset.sourceId) return null;
  const block = [...source.querySelectorAll<HTMLElement>('[data-block-anchor]')].find(
    (item) => item.offsetParent !== null && item.getBoundingClientRect().bottom > top
  );
  const rect = block?.getBoundingClientRect();
  const anchor = block?.dataset.blockAnchor?.split(' ')[0];
  return {
    chatId,
    branchId,
    sourceId: source.dataset.sourceId,
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

type Scope = { revision: number; dirty: ReaderTarget | null; busy: boolean; loaded: boolean };
export function useReadingSync(options: {
  chatId: string;
  branchId: string;
  explicitSource: string;
  reader: RefObject<HTMLDivElement | null>;
  storageKey: string;
  onResume: (target: ReaderTarget, replace?: boolean) => void;
  saveLocal: () => void;
}) {
  const [clientId] = useState(readingClientId);
  const key = `${options.chatId}:${options.branchId}`;
  const current = useRef(options);
  current.current = options;
  const [state, setState] = useState<{
    key: string;
    loaded: boolean;
    own: ReadingPosition | null;
    other: ReadingPosition | null;
    error: string;
  }>({ key: '', loaded: false, own: null, other: null, error: '' });
  const records = useRef(new Map<string, Scope>());
  const remoteLoader = useRef<(() => Promise<void>) | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // One activation owns its initial resume decision. Later visibility/online refreshes can only
  // offer a new position, never move the viewport or replay an offline history of scroll events.
  useEffect(() => {
    const { chatId, branchId, storageKey } = current.current;
    if (!chatId) return;
    let alive = true;
    let initial = true;
    let interacted = false;
    let userUntil = 0;
    let resumedOther: string | null = null;
    const scope = records.current.get(key) ?? {
      revision: 0,
      dirty: null,
      busy: false,
      loaded: false,
    };
    records.current.set(key, scope);
    const controller = new AbortController();
    const path = `/chats/${encodeURIComponent(chatId)}/reading-position`;
    const query = new URLSearchParams({ clientId, branchId });
    const load = async () => {
      try {
        const value = await api<ReadingPositions>(
          `${path}?${query}`,
          undefined,
          'GET',
          AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])
        );
        if (!alive) return;
        scope.revision = Math.max(scope.revision, value.own?.revision ?? 0);
        scope.loaded = true;
        const ownLocal = readReadingPosition(storageKey);
        const candidate = value.own ?? value.other;
        if (
          initial &&
          !interacted &&
          !current.current.explicitSource &&
          !ownLocal?.source &&
          candidate &&
          document.visibilityState === 'visible'
        ) {
          if (!value.own) resumedOther = value.other?.updatedAt ?? null;
          current.current.onResume(candidate.target, true);
        }
        initial = false;
        setState({
          key,
          loaded: true,
          own: value.own,
          other: value.other?.updatedAt === resumedOther ? null : value.other,
          error: '',
        });
      } catch {
        if (alive) {
          initial = false;
          scope.loaded = false;
          setState((old) => ({
            key,
            loaded: true,
            own: old.key === key ? old.own : null,
            other: null,
            error: '읽기 위치 연결을 확인하지 못했어요. 이 기기의 위치는 계속 보존해요.',
          }));
        }
      }
    };
    const save = async () => {
      if (!scope.dirty || scope.busy || !scope.loaded) return;
      const target = scope.dirty;
      scope.dirty = null;
      scope.busy = true;
      const revision = scope.revision;
      try {
        const saved = await api<ReadingPosition>(
          path,
          { clientId, expectedRevision: revision, target },
          'PUT'
        );
        scope.revision = saved.revision;
        if (alive && mounted.current)
          setState((old) => (old.key === key ? { ...old, own: saved, error: '' } : old));
      } catch {
        // Refresh CAS state, not the rejected location; another real user scroll is needed to save again.
        if (alive) {
          scope.loaded = false;
          await load();
        }
      } finally {
        scope.busy = false;
      }
    };
    const intent = (event: Event) => {
      const node = current.current.reader.current;
      if (node && event.target instanceof Node && node.contains(event.target)) {
        interacted = true;
        userUntil = performance.now() + 2500;
      }
    };
    const keyboard = (event: KeyboardEvent) => {
      if (
        !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key) ||
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      )
        return;
      interacted = true;
      userUntil = performance.now() + 2500;
    };
    const scroll = (event: Event) => {
      const node = current.current.reader.current;
      if (
        event.target !== node ||
        !node ||
        performance.now() > userUntil ||
        document.visibilityState !== 'visible'
      )
        return;
      scope.dirty = captureReaderLocation(node, chatId, branchId);
      current.current.saveLocal();
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden') void save();
      else void load();
    };
    const online = () => {
      void load();
    };
    const pagehide = () => {
      void save();
    };
    remoteLoader.current = load;
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void save();
    }, 10_000);
    document.addEventListener('scroll', scroll, true);
    for (const type of ['wheel', 'touchstart', 'touchmove', 'pointerdown'])
      document.addEventListener(type, intent, { capture: true, passive: true });
    document.addEventListener('keydown', keyboard, true);
    document.addEventListener('visibilitychange', visibility);
    addEventListener('online', online);
    addEventListener('pagehide', pagehide);
    return () => {
      alive = false;
      controller.abort();
      clearInterval(timer);
      void save();
      if (remoteLoader.current === load) remoteLoader.current = null;
      document.removeEventListener('scroll', scroll, true);
      for (const type of ['wheel', 'touchstart', 'touchmove', 'pointerdown'])
        document.removeEventListener(type, intent, true);
      document.removeEventListener('keydown', keyboard, true);
      document.removeEventListener('visibilitychange', visibility);
      removeEventListener('online', online);
      removeEventListener('pagehide', pagehide);
    };
  }, [key, clientId]);
  const loaded = state.key === key && state.loaded;
  const other =
    loaded && state.other && (!state.own || state.other.updatedAt > state.own.updatedAt)
      ? state.other
      : null;
  return {
    ready: !options.chatId || !!options.explicitSource || loaded,
    other,
    error: state.key === key ? state.error : '',
    resumeOther: () => {
      if (other) {
        current.current.onResume(other.target);
        setState((old) => ({ ...old, other: null }));
      }
    },
    dismiss: () => setState((old) => ({ ...old, other: null, error: '' })),
    refresh: () => {
      void remoteLoader.current?.();
    },
  };
}
