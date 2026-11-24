import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  createLiveRefresh,
  createLiveStream,
  liveDelay,
  type LiveSource,
} from '../web/live-stream.js';

class FakeSource implements LiveSource {
  readyState = 0;
  closed = false;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  private listeners = new Map<string, ((event: MessageEvent) => void)[]>();
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  emit(type: string, data: unknown) {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    if (type === 'message') this.onmessage?.(event);
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  fail(permanently = false) {
    this.readyState = permanently ? 2 : 0;
    this.onerror?.(new Event('error'));
  }
}

function environment() {
  const sources: FakeSource[] = [];
  const page = new EventTarget();
  let hidden = false;
  const stream = createLiveStream({
    connect(url) {
      const source = new FakeSource(url);
      sources.push(source);
      return source;
    },
    hidden: () => hidden,
    online: () => true,
    listen: (event, listener) => page.addEventListener(event, listener),
  });
  return {
    stream,
    sources,
    open: () => sources.filter((source) => !source.closed),
    latest: () => sources.at(-1)!,
    setHidden(value: boolean) {
      hidden = value;
      page.dispatchEvent(new Event('visibilitychange'));
    },
  };
}

const flush = async () => {
  for (let index = 0; index < 5; index++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

test('the tab keeps one connection, follows the selected chat and reports down only after closure or silence', async () => {
  const live = environment();
  await flush();
  expect(live.sources.map((source) => source.url)).toEqual(['/api/events']);
  expect(live.stream.state()).toBe('connecting');
  vi.advanceTimersByTime(liveDelay.downAfterClosed);
  expect(live.stream.state()).toBe('down');
  live.latest().open();
  expect(live.stream.state()).toBe('open');

  const messages: string[] = [];
  const handler = (chatId: string) => ({
    open() {},
    error() {},
    message: (data: string) => messages.push(`${chatId}:${JSON.parse(data).kind}`),
  });
  const detachFirst = live.stream.attachChat('first', handler('first'));
  await flush();
  detachFirst();
  live.stream.attachChat('second', handler('second'));
  await flush();
  expect(live.sources.map((source) => source.url)).toEqual([
    '/api/events',
    '/api/events?chat=first',
    '/api/events?chat=second',
  ]);
  expect(live.open()).toHaveLength(1);
  live.sources[1].emit('message', { kind: 'late' });
  live.latest().open();
  live.latest().emit('message', { kind: 'snapshot' });
  expect(messages).toEqual(['second:snapshot']);

  vi.advanceTimersByTime(liveDelay.downAfterSilence - 1);
  live.latest().emit('keepalive', 0);
  vi.advanceTimersByTime(liveDelay.downAfterSilence - 1);
  expect(live.stream.state()).toBe('open');
  vi.advanceTimersByTime(1);
  expect(live.stream.state()).toBe('down');

  live.latest().fail(true);
  vi.advanceTimersByTime(liveDelay.reopen.first);
  expect(live.sources).toHaveLength(4);
  expect(live.open()).toHaveLength(1);
  expect(live.latest().url).toBe('/api/events?chat=second');
});

test('a refresh runs once per burst of matching signals, polls only while the stream is down and pauses while hidden', async () => {
  const live = environment();
  await flush();
  live.latest().open();
  const settled: (() => void)[] = [];
  let failNext = false;
  const refreshes: number[] = [];
  const tab = { hidden: false };
  const controller = createLiveRefresh({
    stream: live.stream,
    match: (frame) => frame.event === 'helper' && frame.conversationId === 'mine',
    refresh: () => {
      refreshes.push(Date.now());
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error('offline'));
      }
      return new Promise<void>((resolve) => settled.push(resolve));
    },
    fallbackMs: 1000,
    hidden: () => tab.hidden,
  });
  const helper = (conversationId: string, seq: number) =>
    live.latest().emit('helper', { seq, conversationId, taskId: null, kind: 'task.running' });

  helper('other', 1);
  expect(refreshes).toHaveLength(0);
  helper('mine', 2);
  helper('mine', 3);
  live.latest().emit('live', { chatsSeq: 0, helperSeq: 3, instanceId: 'a' });
  expect(refreshes).toHaveLength(1);
  settled.shift()!();
  await flush();
  expect(refreshes).toHaveLength(2);
  settled.shift()!();
  await flush();
  expect(refreshes).toHaveLength(2);

  vi.advanceTimersByTime(10_000);
  expect(refreshes).toHaveLength(2);
  live.latest().emit('keepalive', 0);
  vi.advanceTimersByTime(liveDelay.downAfterSilence);
  expect(live.stream.state()).toBe('down');
  vi.advanceTimersByTime(1000);
  expect(refreshes).toHaveLength(3);
  settled.shift()!();
  await flush();
  tab.hidden = true;
  vi.advanceTimersByTime(3000);
  expect(refreshes).toHaveLength(3);
  tab.hidden = false;
  failNext = true;
  vi.advanceTimersByTime(1000);
  expect(refreshes).toHaveLength(4);
  await flush();
  vi.advanceTimersByTime(100);
  expect(refreshes).toHaveLength(5);
  settled.shift()!();
  await flush();

  live.latest().emit('keepalive', 0);
  expect(live.stream.state()).toBe('open');
  vi.advanceTimersByTime(5000);
  expect(refreshes).toHaveLength(5);
  controller.dispose();
  helper('mine', 4);
  expect(refreshes).toHaveLength(5);
});

test('a degraded poll reads its delay on every tick, and an undefined delay stops polling', async () => {
  const live = environment();
  await flush();
  vi.advanceTimersByTime(liveDelay.downAfterClosed);
  expect(live.stream.state()).toBe('down');
  let delay: number | undefined = 1000;
  let refreshes = 0;
  const controller = createLiveRefresh({
    stream: live.stream,
    match: () => false,
    refresh: async () => {
      refreshes++;
    },
    fallbackMs: () => delay,
    hidden: () => false,
  });
  vi.advanceTimersByTime(1000);
  await flush();
  expect(refreshes).toBe(1);
  delay = 3000;
  vi.advanceTimersByTime(1000);
  await flush();
  expect(refreshes).toBe(2);
  delay = undefined;
  vi.advanceTimersByTime(2999);
  await flush();
  expect(refreshes).toBe(2);
  vi.advanceTimersByTime(1);
  await flush();
  expect(refreshes).toBe(3);
  vi.advanceTimersByTime(30_000);
  await flush();
  expect(refreshes).toBe(3);
  controller.dispose();
});

test('a reconnect resyncs only when the server tail moved, and a visible tab reads only what it skipped while hidden', async () => {
  const live = environment();
  await flush();
  live.latest().open();
  let refreshes = 0;
  const tab = { hidden: false };
  createLiveRefresh({
    stream: live.stream,
    match: (frame) => frame.event === 'invalidate' && frame.name === 'activity',
    refresh: async () => {
      refreshes++;
    },
    hidden: () => tab.hidden,
  });
  const tail = { chatsSeq: 4, helperSeq: 7, invalidations: 1, instanceId: 'a' };
  live.latest().emit('live', tail);
  await flush();
  expect(refreshes).toBe(1);

  live.stream.attachChat('chat', { open() {}, error() {}, message() {} });
  await flush();
  live.latest().open();
  live.latest().emit('live', tail);
  await flush();
  expect(refreshes).toBe(1);

  live.latest().emit('chats', { seq: 5, chatId: 'chat', kind: 'scene.updated', entityId: null });
  live.latest().emit('invalidate', { name: 'helper-list', seq: 2 });
  live.latest().fail(true);
  vi.advanceTimersByTime(liveDelay.reopen.first);
  live.latest().open();
  live.latest().emit('live', { ...tail, chatsSeq: 5, invalidations: 2 });
  await flush();
  expect(refreshes).toBe(1);
  live.latest().emit('live', { ...tail, chatsSeq: 5, invalidations: 3 });
  await flush();
  expect(refreshes).toBe(2);
  live.latest().emit('live', { ...tail, chatsSeq: 5, invalidations: 3, instanceId: 'b' });
  await flush();
  expect(refreshes).toBe(3);

  live.setHidden(true);
  live.setHidden(false);
  await flush();
  expect(refreshes).toBe(3);
  tab.hidden = true;
  live.setHidden(true);
  live.latest().emit('invalidate', { name: 'activity', seq: 4 });
  await flush();
  expect(refreshes).toBe(3);
  tab.hidden = false;
  live.setHidden(false);
  await flush();
  expect(refreshes).toBe(4);
});
