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
// The store treats the server payload as opaque; these tests exercise ownership, not validation.
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

test('idle store does not fetch, and unchanged snapshots retain their identity', async () => {
  const f = setup();
  const initial = f.store.getSnapshot();
  await f.store.refresh();
  expect(f.load).not.toHaveBeenCalled();
  expect(f.listen).not.toHaveBeenCalled();
  expect(f.store.getSnapshot()).toBe(initial);
  expect(initial).toEqual({ workspace: null, error: '' });
});

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

test.each(['success', 'failure'] as const)(
  'invalidation during %s discards the old answer and coalesces a trailing read',
  async (kind) => {
    const f = setup();
    const notify = vi.fn();
    const unsubscribe = f.store.subscribe(notify);
    const done = f.store.refresh();
    await Promise.resolve();
    f.invalidate();
    f.invalidate();
    expect(f.store.refresh()).toBe(done);
    if (kind === 'success') f.reads[0].resolve(workspace(1));
    else f.reads[0].reject(new Error('superseded failure'));
    await Promise.resolve();
    expect(f.reads).toHaveLength(2);
    expect(notify).not.toHaveBeenCalled();
    expect(f.store.getSnapshot()).toEqual({ workspace: null, error: '' });
    f.reads[1].resolve(workspace(2));
    await done;
    expect(f.store.getSnapshot()).toEqual({ workspace: workspace(2), error: '' });
    expect(notify).toHaveBeenCalledTimes(1);
    unsubscribe();
  }
);

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

test.each(['success', 'failure'] as const)(
  'last unsubscribe rejects late %s even after another session mounts',
  async (kind) => {
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
    if (kind === 'success') f.reads[0].resolve(workspace(1));
    else f.reads[0].reject(new Error('old session error'));
    await old;
    expect(notify).not.toHaveBeenCalled();
    f.reads[1].resolve(workspace(2));
    await current;
    expect(f.store.getSnapshot()).toEqual({ workspace: workspace(2), error: '' });
    second();
  }
);

test('mount cleanup and immediate remount do not start a cancelled initial request', async () => {
  const f = setup();
  const first = f.store.subscribe(() => {});
  first();
  const second = f.store.subscribe(() => {});
  const done = f.store.refresh();
  await Promise.resolve();
  expect(f.reads).toHaveLength(1);
  expect(f.listen).toHaveBeenCalledTimes(2);
  f.reads[0].resolve(workspace(1));
  await done;
  second();
  expect(f.stop).toHaveBeenCalledTimes(2);
});

test('subscriber invalidation while an answer is published is not lost', async () => {
  const f = setup();
  const unsubscribe = f.store.subscribe(() => {
    if (f.store.getSnapshot().workspace?.revision === 1) f.invalidate();
  });
  const done = f.store.refresh();
  await Promise.resolve();
  f.reads[0].resolve(workspace(1));
  await Promise.resolve();
  expect(f.reads).toHaveLength(2);
  f.reads[1].resolve(workspace(2));
  await done;
  expect(f.store.getSnapshot().workspace?.revision).toBe(2);
  unsubscribe();
});

test('synchronous loading failure becomes a recoverable snapshot error', async () => {
  const store = createPromptWorkspaceStore({
    load: () => {
      throw new Error('Synthetic immediate failure');
    },
    listen: () => () => {},
  });
  const unsubscribe = store.subscribe(() => {});
  await store.refresh();
  expect(store.getSnapshot()).toEqual({ workspace: null, error: 'Synthetic immediate failure' });
  unsubscribe();
});

test('invalidation after delivery but before promise settlement starts another read', async () => {
  const f = setup();
  const unsubscribe = f.store.subscribe(() => {});
  const initial = f.store.refresh();
  await Promise.resolve();
  f.reads[0].resolve(workspace(1));
  await Promise.resolve();
  const followup = f.store.refresh();
  await Promise.resolve();
  await Promise.resolve();
  expect(f.reads).toHaveLength(2);
  f.reads[1].resolve(workspace(2));
  await Promise.all([initial, followup]);
  expect(f.store.getSnapshot().workspace?.revision).toBe(2);
  unsubscribe();
});

test('server rendering keeps an empty, stable snapshot without fetching', async () => {
  const f = setup();
  const server = f.store.getServerSnapshot();
  expect(f.load).not.toHaveBeenCalled();
  const unsubscribe = f.store.subscribe(() => {});
  const done = f.store.refresh();
  await Promise.resolve();
  f.reads[0].resolve(workspace(1));
  await done;
  expect(f.store.getServerSnapshot()).toBe(server);
  expect(server).toEqual({ workspace: null, error: '' });
  unsubscribe();
});
