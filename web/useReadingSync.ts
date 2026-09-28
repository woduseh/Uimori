import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { ReaderTarget } from '../core/reader-target.js';
import type { ReadingPosition, ReadingPositions } from '../core/reading-state.js';
import { browserClientId } from './browser-client.js';
import { api } from './api.js';
import { readReadingPosition } from './story-storage.js';

/** Source/paragraph identity survives viewport and font-size differences; pixels stay local. */
export function captureReaderLocation(
  reader: HTMLElement,
  chatId: string,
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

/** Server checkpoints are optional. Never gate the reader or move an already-open page. */
export function useReadingSync(options: {
  chatId: string;
  reader: RefObject<HTMLDivElement | null>;
  storageKey: string;
  onResume: (target: ReaderTarget) => void;
  saveLocal: () => void;
}) {
  const [clientId] = useState(browserClientId);
  const key = options.chatId;
  const current = useRef(options);
  current.current = options;
  const [state, setState] = useState<{
    key: string;
    own: ReadingPosition | null;
    other: ReadingPosition | null;
    error: string;
  }>({ key: '', own: null, other: null, error: '' });
  const actions = useRef<{
    key: string;
    remember: (target: ReaderTarget) => void;
    load: () => Promise<void>;
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
          setState({ key, ...value, error: '' });
        } catch {
          if (alive)
            setState((old) => ({
              key,
              own: old.key === key ? old.own : null,
              other: null,
              error: '읽기 위치 연결을 확인하지 못했어요. 이 기기의 위치는 계속 보존해요.',
            }));
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
        if (alive) setState((old) => (old.key === key ? { ...old, own: saved, error: '' } : old));
      } catch {
        // Unknown/CAS outcomes are reread, not blindly replayed. Keep only a newer user location.
        loaded = false;
        if (alive) await load();
      } finally {
        saving = false;
      }
    };
    const rememberTarget = (target: ReaderTarget) => {
      dirty = target;
      void (loaded
        ? save()
        : load().then(() => {
            if (alive) return save();
          }));
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
      if (
        event.target !== node ||
        !node ||
        performance.now() > userUntil ||
        document.visibilityState !== 'visible'
      )
        return;
      dirty = captureReaderLocation(node, chatId);
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
    actions.current = { key, remember: rememberTarget, load };
    if (pending.current?.chatId === chatId) {
      dirty = pending.current;
      pending.current = null;
    }
    void load().then(() => {
      if (alive) return save();
    });
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible' || !dirty) return;
      if (loaded) void save();
      else
        void load().then(() => {
          if (alive) return save();
        });
    }, 10_000);
    document.addEventListener('scroll', scroll, true);
    for (const type of ['wheel', 'touchmove', 'pointerdown'])
      document.addEventListener(type, input, { capture: true, passive: true });
    document.addEventListener('keydown', keyboard, true);
    document.addEventListener('visibilitychange', visibility);
    addEventListener('online', online);
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
      removeEventListener('online', online);
      removeEventListener('pagehide', pagehide);
    };
  }, [key, clientId]);
  const other =
    state.key === key && state.other && (!state.own || state.other.updatedAt > state.own.updatedAt)
      ? state.other
      : null;
  const resume =
    other ??
    (state.key === key && !readReadingPosition(options.storageKey)?.source ? state.own : null);
  return {
    remember,
    other: resume,
    resumeLabel: other ? '다른 기기에서 이어 읽기' : '저장된 위치에서 이어 읽기',
    error: state.key === key ? state.error : '',
    resumeOther: () => {
      if (resume) {
        current.current.onResume(resume.target);
        setState((old) => ({ ...old, other: null }));
      }
    },
    dismiss: () => setState((old) => ({ ...old, own: null, other: null, error: '' })),
    refresh: () => {
      void actions.current?.load();
    },
  };
}
