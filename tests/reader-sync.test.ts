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
