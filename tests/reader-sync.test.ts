import { afterEach, expect, test, vi } from 'vitest';
import { createReaderSync } from '../web/reader-sync.js';

afterEach(() => vi.useRealTimers());

test('the final event retries a failed GET without another event or reconnect', async () => {
  vi.useFakeTimers();
  let cursor = 41;
  const refresh = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockImplementation(async () => {
      cursor = 42;
      return true;
    });
  const onError = vi.fn();
  const sync = createReaderSync({ refresh, cursor: () => cursor, onError });
  sync.request(42);
  await vi.advanceTimersByTimeAsync(1000);
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(cursor).toBe(42);
  expect(onError).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  sync.dispose();
});

test('failed and superseded full refreshes remain pending, including reconnect during a GET', async () => {
  vi.useFakeTimers();
  let complete!: (value: boolean) => void;
  const refresh = vi
    .fn()
    .mockRejectedValueOnce(new Error('failed'))
    .mockResolvedValueOnce(undefined)
    .mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          complete = resolve;
        })
    )
    .mockResolvedValue(true);
  const sync = createReaderSync({ refresh, cursor: () => 42, onError: () => {} });
  sync.request(42, true);
  await vi.advanceTimersByTimeAsync(1000);
  sync.request(42, true);
  complete(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(refresh.mock.calls).toEqual([[false], [false], [false], [false]]);
  expect(vi.getTimerCount()).toBe(0);
  sync.dispose();
});

test('navigation disposes retries and ignores the late failure of an in-flight GET', async () => {
  vi.useFakeTimers();
  let reject!: (error: Error) => void;
  const onError = vi.fn();
  const refresh = vi.fn(
    () =>
      new Promise<boolean>((_resolve, fail) => {
        reject = fail;
      })
  );
  const sync = createReaderSync({ refresh, cursor: () => 1, onError });
  sync.request(2);
  await vi.advanceTimersByTimeAsync(100);
  sync.dispose();
  reject(new Error('late'));
  await vi.advanceTimersByTimeAsync(10000);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(onError).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test('a hidden reader retains event and reconnect targets without reads or retry timers', async () => {
  vi.useFakeTimers();
  let cursor = 10;
  let complete!: (applied: boolean) => void;
  const refresh = vi.fn().mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        complete = resolve;
      })
  );
  const sync = createReaderSync({
    refresh,
    cursor: () => cursor,
    onError: () => {},
    active: false,
  });
  sync.request(11);
  sync.request(12, true);
  await vi.advanceTimersByTimeAsync(60000);
  expect(refresh).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);

  sync.setActive(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(refresh.mock.calls).toEqual([[false]]);
  sync.setActive(false);
  sync.request(13, true);
  complete(true);
  await vi.advanceTimersByTimeAsync(60000);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);

  refresh.mockImplementation(async () => {
    cursor = 13;
    return true;
  });
  sync.setActive(true);
  await vi.advanceTimersByTimeAsync(10000);
  expect(refresh.mock.calls).toEqual([[false], [false]]);
  expect(cursor).toBe(13);
  expect(vi.getTimerCount()).toBe(0);
  sync.dispose();
});

test('the stream snapshot after a fresh full load reads only what the load missed', async () => {
  vi.useFakeTimers();
  let cursor = -1;
  let finishLoad!: (applied: boolean) => void;
  const refresh = vi.fn(async () => {
    cursor = 9;
    return true;
  });
  const sync = createReaderSync({ refresh, cursor: () => cursor, onError: () => {} });
  sync.track(
    new Promise<boolean>((resolve) => {
      finishLoad = resolve;
    })
  );
  sync.request(7, true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(refresh).not.toHaveBeenCalled();
  cursor = 7;
  finishLoad(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(refresh).not.toHaveBeenCalled();

  sync.track(Promise.resolve(true));
  await vi.advanceTimersByTimeAsync(0);
  sync.request(9, true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(refresh.mock.calls).toEqual([[true]]);
  expect(vi.getTimerCount()).toBe(0);
  sync.dispose();
});

test('a snapshot after a disconnect or a failed full load still reloads in full', async () => {
  vi.useFakeTimers();
  const refresh = vi.fn().mockResolvedValue(true);
  const sync = createReaderSync({ refresh, cursor: () => 5, onError: () => {} });
  sync.track(Promise.resolve(true));
  await vi.advanceTimersByTimeAsync(0);
  sync.disconnected();
  sync.request(5, true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(refresh.mock.calls).toEqual([[false]]);

  sync.track(Promise.reject(new Error('offline')));
  sync.request(5, true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(refresh.mock.calls).toEqual([[false], [false]]);
  expect(vi.getTimerCount()).toBe(0);
  sync.dispose();
});

test('a new event during the first load refreshes at once while its snapshot waits for the load', async () => {
  vi.useFakeTimers();
  let cursor = -1;
  let finishLoad!: (applied: boolean | undefined) => void;
  const refresh = vi.fn(async () => {
    cursor = 8;
    return true;
  });
  const sync = createReaderSync({ refresh, cursor: () => cursor, onError: () => {} });
  sync.track(
    new Promise<boolean | undefined>((resolve) => {
      finishLoad = resolve;
    })
  );
  sync.request(7, true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(refresh).not.toHaveBeenCalled();

  sync.request(8);
  await vi.advanceTimersByTimeAsync(100);
  expect(refresh.mock.calls).toEqual([[true]]);

  finishLoad(undefined);
  await vi.advanceTimersByTimeAsync(1000);
  expect(refresh.mock.calls).toEqual([[true], [false]]);
  expect(vi.getTimerCount()).toBe(0);
  sync.dispose();
});
