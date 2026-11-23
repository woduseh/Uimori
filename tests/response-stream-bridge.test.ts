import { expect, test } from 'vitest';
import {
  openResponseStreamChannel,
  responseStreamCursors,
  responseStreamIsPushed,
  watchResponseStream,
  type PushedResponsePage,
} from '../web/response-stream-bridge.js';

const page = (taskId: string, after: number): string =>
  JSON.stringify({
    taskKind: 'main',
    taskId,
    status: 'running',
    chunks: [],
    cursor: after,
    hasMore: false,
    after,
  });

function reader(cursor = 0) {
  const received: PushedResponsePage[] = [];
  let disconnects = 0;
  return {
    received,
    disconnects: () => disconnects,
    watch: {
      cursor: () => cursor,
      receive: (pushed: PushedResponsePage) => received.push(pushed),
      disconnected: () => disconnects++,
    },
  };
}

test('pushed pages reach only the readers of their task and mark it as pushed on the open channel', () => {
  const first = reader();
  const other = reader();
  const stopFirst = watchResponseStream('main', 'run:1', first.watch);
  const stopOther = watchResponseStream('helper', 'run:1', other.watch);
  expect(responseStreamIsPushed('main', 'run:1')).toBe(false);
  const channel = openResponseStreamChannel();
  channel.connected();
  expect(responseStreamIsPushed('main', 'run:1')).toBe(false);
  channel.deliver(page('run:1', 3));
  channel.deliver(JSON.stringify({ taskKind: 'main', taskId: 'run:1', chunks: [] }));
  expect(first.received.map((pushed) => pushed.after)).toEqual([3]);
  expect(other.received).toEqual([]);
  expect(responseStreamIsPushed('main', 'run:1')).toBe(true);
  expect(responseStreamIsPushed('helper', 'run:1')).toBe(false);

  channel.disconnected();
  expect(responseStreamIsPushed('main', 'run:1')).toBe(false);
  expect([first.disconnects(), other.disconnects()]).toEqual([1, 1]);
  channel.disconnected();
  expect(first.disconnects()).toBe(1);
  channel.connected();
  expect(responseStreamIsPushed('main', 'run:1')).toBe(false);
  channel.deliver(page('run:1', 4));
  expect(responseStreamIsPushed('main', 'run:1')).toBe(true);

  const replaced = openResponseStreamChannel();
  channel.deliver(page('run:1', 5));
  expect(first.received.map((pushed) => pushed.after)).toEqual([3, 4]);
  expect(responseStreamIsPushed('main', 'run:1')).toBe(false);
  channel.close();
  expect(first.disconnects()).toBe(1);
  replaced.connected();
  replaced.close();
  expect(first.disconnects()).toBe(2);
  stopFirst();
  stopOther();
});

test('reconnect cursors list each watched task once at the lowest cursor its readers hold', () => {
  expect(responseStreamCursors()).toBe('');
  const stops = [
    watchResponseStream('main', 'run/1', reader(12).watch),
    watchResponseStream('main', 'run/1', reader(7).watch),
    watchResponseStream('translation', 'job', reader(0).watch),
  ];
  expect(responseStreamCursors()).toBe('main:run%2F1:7,translation:job:0');
  for (const stop of stops) stop();
  expect(responseStreamCursors()).toBe('');
});
