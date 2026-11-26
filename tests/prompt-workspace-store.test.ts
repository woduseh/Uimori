import { expect, test, vi } from 'vitest';
import type { PromptWorkspace } from '../core/product.js';
import { createPromptWorkspaceStore } from '../web/prompt-workspace-store.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const workspace = (revision: number) => ({ revision }) as PromptWorkspace;
function setup() {
  const reads: (ReturnType<typeof deferred<PromptWorkspace>> & { signal: AbortSignal })[] = [];
  let invalidate = () => {};
  const stop = vi.fn();
  const listen = vi.fn((callback: () => void) => {
    invalidate = callback;
    return stop;
  });
  const load = vi.fn((signal: AbortSignal) => {
    const read = { ...deferred<PromptWorkspace>(), signal };
    reads.push(read);
    return read.promise;
  });
  const store = createPromptWorkspaceStore({ load, listen });
  return { store, reads, load, listen, stop, invalidate: () => invalidate() };
}

test('multiple consumers share one initial request, answer and listener lifecycle', async () => {
  const f = setup();
  const notify = vi.fn();
  const first = f.store.subscribe(notify);
  const second = f.store.subscribe(notify);
  const done = f.store.refresh();
  await Promise.resolve();
  expect(f.reads).toHaveLength(1);
  expect(f.listen).toHaveBeenCalledTimes(1);
  const value = workspace(1);
  f.reads[0].resolve(value);
  await done;
  expect(f.store.getSnapshot().workspace).toBe(value);
  expect(notify).toHaveBeenCalledTimes(2);
  const snapshot = f.store.getSnapshot();
  const third = f.store.subscribe(() => {});
  expect(f.store.getSnapshot()).toBe(snapshot);
  expect(f.reads).toHaveLength(1);
  first();
  first();
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.reads[0].signal.aborted).toBe(false);
  second();
  third();
  expect(f.stop).toHaveBeenCalledTimes(1);
  expect(f.reads[0].signal.aborted).toBe(true);
  expect(f.store.getSnapshot()).toEqual({ workspace: null, error: '' });
});

test('invalidation during a failing read discards the old answer and coalesces a trailing read', async () => {
  const f = setup();
  const notify = vi.fn();
  const unsubscribe = f.store.subscribe(notify);
  const done = f.store.refresh();
  await Promise.resolve();
  f.invalidate();
  f.invalidate();
  expect(f.store.refresh()).toBe(done);
  f.reads[0].reject(new Error('superseded failure'));
  await Promise.resolve();
  expect(f.reads).toHaveLength(2);
  expect(notify).not.toHaveBeenCalled();
  expect(f.store.getSnapshot()).toEqual({ workspace: null, error: '' });
  f.reads[1].resolve(workspace(2));
  await done;
  expect(f.store.getSnapshot()).toEqual({ workspace: workspace(2), error: '' });
  expect(notify).toHaveBeenCalledTimes(1);
  unsubscribe();
});

test('latest failure keeps the last value and recovery clears its error', async () => {
  const f = setup();
  const unsubscribe = f.store.subscribe(() => {});
  let done = f.store.refresh();
  await Promise.resolve();
  const value = workspace(1);
  f.reads[0].resolve(value);
  await done;
  done = f.store.refresh();
  await Promise.resolve();
  f.reads[1].reject(new Error('Synthetic read failure'));
  await done;
  expect(f.store.getSnapshot()).toEqual({ workspace: value, error: 'Synthetic read failure' });
  done = f.store.refresh();
  await Promise.resolve();
  f.reads[2].resolve(workspace(3));
  await done;
  expect(f.store.getSnapshot()).toEqual({ workspace: workspace(3), error: '' });
  unsubscribe();
});

test('last unsubscribe rejects a late success even after another session mounts', async () => {
  const f = setup();
  const first = f.store.subscribe(() => {});
  const old = f.store.refresh();
  await Promise.resolve();
  first();
  const notify = vi.fn();
  const second = f.store.subscribe(notify);
  const current = f.store.refresh();
  await Promise.resolve();
  expect(f.reads).toHaveLength(2);
  expect(f.reads[0].signal.aborted).toBe(true);
  expect(f.reads[1].signal.aborted).toBe(false);
  f.reads[0].resolve(workspace(1));
  await old;
  expect(notify).not.toHaveBeenCalled();
  f.reads[1].resolve(workspace(2));
  await current;
  expect(f.store.getSnapshot()).toEqual({ workspace: workspace(2), error: '' });
  second();
});
