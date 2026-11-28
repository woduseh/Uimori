import type { FixtureGeneration } from '../core/fixture-provider.js';
export type Barrier = 'run' | 'translation' | 'image' | 'state' | 'illustration';
export const FAILURE_POINTS = [
  'source-transaction',
  'job-transaction',
  'translation',
  'image',
  'illustration',
] as const;
export type FailurePoint = (typeof FAILURE_POINTS)[number];

export class Controls {
  fixture: FixtureGeneration = {};
  readonly held = new Set<Barrier>();
  private readonly failures = new Map<string, { point: FailurePoint; chatId: string }>();
  private waiters = new Map<Barrier, Set<() => void>>();
  crashAfterSourceCommit = false;

  hold(barrier: Barrier) {
    this.held.add(barrier);
  }
  release(barrier: Barrier) {
    this.held.delete(barrier);
    for (const resume of this.waiters.get(barrier) ?? []) resume();
  }
  armFailure(point: FailurePoint, chatId: string) {
    this.failures.set(JSON.stringify([point, chatId]), { point, chatId });
  }
  fail(point: FailurePoint, chatId: string) {
    if (this.failures.delete(JSON.stringify([point, chatId])))
      throw new Error(`Injected failure: ${point}`);
  }
  async wait(barrier: Barrier, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.held.has(barrier)) return;
    await new Promise<void>((resolve, reject) => {
      const waiters = this.waiters.get(barrier) ?? new Set();
      this.waiters.set(barrier, waiters);
      const clean = () => {
        waiters.delete(resume);
        signal.removeEventListener('abort', abort);
      };
      const resume = () => {
        clean();
        resolve();
      };
      const abort = () => {
        clean();
        reject(signal.reason);
      };
      waiters.add(resume);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  snapshot() {
    return {
      held: [...this.held],
      waiting: Object.fromEntries([...this.waiters].map(([key, value]) => [key, value.size])),
      failures: [...this.failures.values()],
    };
  }
}
