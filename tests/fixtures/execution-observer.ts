import { vi } from 'vitest';
import type { Run, Store } from '../../server/store.js';

export type ExecutionObservation = Pick<Run, 'snapshot' | 'inputs' | 'toolEvents'>;
const observations = new WeakMap<Store, Map<string, ExecutionObservation>>();
const attempts = new WeakMap<Store, Map<string, ReturnType<Store['product']['attempts']>>>();

/**
 * Capture what a synthetic run actually executed before successful completion releases its
 * diagnostic inputs. This is test-only memory, not a historical storage mode or an API mock.
 * Tests about durable state must read store.run()/readStoredRunSnapshot() instead.
 */
export function observeExecutions(store: Store): void {
  if (observations.has(store)) return;
  const captured = new Map<string, ExecutionObservation>();
  observations.set(store, captured);
  attempts.set(store, new Map());
  const complete = store.completeRunInTransaction.bind(store);
  vi.spyOn(store, 'completeRunInTransaction').mockImplementation((...args) => {
    const { snapshot, inputs, toolEvents } = store.run(args[0]);
    const observation = structuredClone({ snapshot, inputs, toolEvents });
    const requests = store.product
      .attempts(store.run(args[0]).chatId)
      .filter((item) => item.runId === args[0]);
    const source = complete(...args);
    attempts.get(store)!.set(args[0], structuredClone(requests));
    captured.set(args[0], observation);
    return source;
  });
}

/** Status, output identity and usage come from storage; request details are observed at execution. */
export function observedExecution(store: Store, id: string): Run {
  const run = store.run(id);
  return { ...run, ...observations.get(store)?.get(id) };
}

export function observedAttempts(store: Store, runId: string) {
  return (
    attempts.get(store)?.get(runId) ??
    store.product.attempts(store.run(runId).chatId).filter((item) => item.runId === runId)
  );
}
