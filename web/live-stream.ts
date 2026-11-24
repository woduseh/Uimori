import { useEffect } from 'react';
import { openResponseStreamChannel, responseStreamCursors } from './response-stream-bridge.js';
import { useStableHandler } from './useStableHandler.js';

export type LiveFrame =
  | { event: 'chats'; seq: number; chatId: string | null; kind: string; entityId: string | null }
  | { event: 'helper'; seq: number; conversationId: string; taskId: string | null; kind: string }
  | { event: 'invalidate'; name: string };
export type LiveSignal = LiveFrame | 'resync';
export type LiveState = 'open' | 'connecting' | 'down';

export type LiveSource = {
  readyState?: number;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  close(): void;
};
export type LiveEnvironment = {
  connect(url: string): LiveSource;
  hidden(): boolean;
  online(): boolean;
  listen(event: 'visibilitychange' | 'online' | 'offline', listener: () => void): void;
};
export type LiveChatHandler = { open(): void; error(): void; message(data: string): void };

export const liveDelay = {
  downAfterClosed: 3000,
  downAfterSilence: 40_000,
  reopen: { first: 1000, longest: 30_000 },
};
const CLOSED = 2;
const globalFrames = ['chats', 'helper', 'invalidate'] as const;

export function createLiveStream(environment: LiveEnvironment) {
  let source: LiveSource | undefined;
  let responses: ReturnType<typeof openResponseStreamChannel> | undefined;
  let chat: { chatId: string; handler: LiveChatHandler } | undefined;
  let current: LiveState = 'connecting';
  let queued = false,
    reopenFailures = 0;
  let downTimer: ReturnType<typeof setTimeout> | undefined,
    silenceTimer: ReturnType<typeof setTimeout> | undefined,
    reopenTimer: ReturnType<typeof setTimeout> | undefined;
  const subscribers = new Set<{
    match: (frame: LiveFrame) => boolean;
    onSignal: (signal: LiveSignal) => void;
  }>();
  const stateListeners = new Set<(state: LiveState) => void>();

  const setState = (next: LiveState) => {
    if (current === next) return;
    current = next;
    for (const listener of [...stateListeners]) listener(next);
  };
  const signal = (value: LiveSignal) => {
    for (const subscriber of [...subscribers])
      if (value === 'resync' || subscriber.match(value)) subscriber.onSignal(value);
  };
  const heard = () => {
    clearTimeout(downTimer);
    downTimer = undefined;
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => setState('down'), liveDelay.downAfterSilence);
    reopenFailures = 0;
    setState('open');
  };
  const waiting = () => {
    clearTimeout(silenceTimer);
    silenceTimer = undefined;
    if (current === 'open') setState('connecting');
    downTimer ??= setTimeout(() => setState('down'), liveDelay.downAfterClosed);
  };
  const close = () => {
    const closing = source;
    source = undefined;
    closing?.close();
    responses?.close();
    responses = undefined;
  };
  const scheduleReopen = () => {
    if (reopenTimer) return;
    const delay = Math.min(
      liveDelay.reopen.longest,
      liveDelay.reopen.first * 2 ** Math.min(reopenFailures++, 5)
    );
    reopenTimer = setTimeout(open, delay);
  };
  const open = () => {
    close();
    clearTimeout(reopenTimer);
    reopenTimer = undefined;
    if (!environment.online()) {
      clearTimeout(downTimer);
      downTimer = undefined;
      setState('down');
      return;
    }
    const attached = chat;
    const query = new URLSearchParams();
    if (attached) {
      query.set('chat', attached.chatId);
      const cursors = responseStreamCursors();
      if (cursors) query.set('streamAfter', cursors);
    }
    const own = environment.connect(`/api/events${attached ? `?${query}` : ''}`);
    const pushed = attached ? openResponseStreamChannel() : undefined;
    source = own;
    responses = pushed;
    waiting();
    own.onopen = () => {
      if (source !== own) return;
      heard();
      pushed?.connected();
      attached?.handler.open();
    };
    own.onerror = () => {
      if (source !== own) return;
      pushed?.disconnected();
      attached?.handler.error();
      waiting();
      if (own.readyState === CLOSED) scheduleReopen();
    };
    own.onmessage = (event) => {
      if (source !== own) return;
      heard();
      attached?.handler.message(event.data);
    };
    own.addEventListener('stream', (event) => {
      if (source !== own) return;
      heard();
      pushed?.deliver(event.data);
    });
    own.addEventListener('keepalive', () => {
      if (source === own) heard();
    });
    own.addEventListener('live', () => {
      if (source !== own) return;
      heard();
      signal('resync');
    });
    for (const name of globalFrames)
      own.addEventListener(name, (event) => {
        if (source !== own) return;
        heard();
        signal({ ...JSON.parse(event.data), event: name } as LiveFrame);
      });
  };
  const reconnect = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      open();
    });
  };

  environment.listen('online', reconnect);
  environment.listen('offline', () => {
    const attached = chat;
    close();
    clearTimeout(reopenTimer);
    reopenTimer = undefined;
    attached?.handler.error();
    clearTimeout(silenceTimer);
    clearTimeout(downTimer);
    silenceTimer = downTimer = undefined;
    setState('down');
  });
  environment.listen('visibilitychange', () => {
    if (environment.hidden()) return;
    if (reopenTimer) open();
    signal('resync');
  });
  reconnect();

  return {
    attachChat(chatId: string, handler: LiveChatHandler) {
      const attached = { chatId, handler };
      chat = attached;
      reconnect();
      return () => {
        if (chat !== attached) return;
        chat = undefined;
        reconnect();
      };
    },
    subscribe(match: (frame: LiveFrame) => boolean, onSignal: (signal: LiveSignal) => void) {
      const subscriber = { match, onSignal };
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
    state: () => current,
    watchState(listener: (state: LiveState) => void) {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
  };
}

export type LiveStream = ReturnType<typeof createLiveStream>;

let shared: LiveStream | undefined;
export function liveStream() {
  shared ??= createLiveStream({
    connect: (url) => new EventSource(url),
    hidden: () => document.hidden,
    online: () => navigator.onLine,
    listen: (event, listener) =>
      (event === 'visibilitychange' ? document : window).addEventListener(event, listener),
  });
  return shared;
}

export const liveRefreshRetry = { first: 100, longest: 5000 };

export function createLiveRefresh(options: {
  stream: Pick<LiveStream, 'subscribe' | 'state' | 'watchState'>;
  match: (frame: LiveFrame) => boolean;
  refresh: () => Promise<unknown>;
  fallbackMs: number;
  minIntervalMs?: number;
  hidden: () => boolean;
}) {
  let disposed = false,
    inFlight = false,
    trailing = false,
    failures = 0,
    lastStart = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined,
    fallback: ReturnType<typeof setTimeout> | undefined;
  const start = async () => {
    timer = undefined;
    if (disposed || options.hidden()) return;
    inFlight = true;
    trailing = false;
    lastStart = Date.now();
    try {
      await options.refresh();
      failures = 0;
    } catch {
      failures++;
    } finally {
      inFlight = false;
    }
    if (disposed) return;
    if (failures)
      timer = setTimeout(
        start,
        Math.min(liveRefreshRetry.longest, liveRefreshRetry.first * 2 ** Math.min(failures - 1, 6))
      );
    else if (trailing) request();
  };
  const request = () => {
    if (disposed) return;
    if (inFlight) {
      trailing = true;
      return;
    }
    if (timer) return;
    const wait = lastStart + (options.minIntervalMs ?? 0) - Date.now();
    if (wait > 0) timer = setTimeout(start, wait);
    else void start();
  };
  const poll = () => {
    clearTimeout(fallback);
    fallback = undefined;
    if (disposed || options.stream.state() !== 'down') return;
    fallback = setTimeout(() => {
      fallback = undefined;
      if (!options.hidden()) request();
      poll();
    }, options.fallbackMs);
  };
  const unsubscribe = options.stream.subscribe(options.match, request);
  const unwatch = options.stream.watchState(poll);
  poll();
  return {
    request,
    dispose() {
      disposed = true;
      unsubscribe();
      unwatch();
      clearTimeout(timer);
      clearTimeout(fallback);
    },
  };
}

export function useLiveRefresh(options: {
  enabled: boolean;
  match: (frame: LiveFrame) => boolean;
  refresh: () => Promise<unknown>;
  fallbackMs: number;
  minIntervalMs?: number;
}) {
  const match = useStableHandler(options.match);
  const refresh = useStableHandler(options.refresh);
  const { enabled, fallbackMs, minIntervalMs } = options;
  useEffect(() => {
    if (!enabled) return;
    const controller = createLiveRefresh({
      stream: liveStream(),
      match,
      refresh,
      fallbackMs,
      minIntervalMs,
      hidden: () => document.hidden,
    });
    return controller.dispose;
  }, [enabled, fallbackMs, minIntervalMs, match, refresh]);
}
