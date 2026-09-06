export type Barrier = 'run' | 'translation' | 'status';
export type FailurePoint = 'source-transaction' | 'job-transaction' | 'translation' | 'status';

/** Explicit deterministic controls. Never registered outside NR_TEST_MODE. */
export class Controls {
  readonly held = new Set<Barrier>();
  readonly failures = new Set<FailurePoint>();
  private waiters = new Map<Barrier, Set<() => void>>();
  crashAfterSourceCommit = false;

  hold(barrier: Barrier) { this.held.add(barrier); }
  release(barrier: Barrier) {
    this.held.delete(barrier);
    for (const resume of this.waiters.get(barrier) ?? []) resume();
  }
  fail(point: FailurePoint) {
    if (this.failures.delete(point)) throw new Error(`Injected failure: ${point}`);
  }
  async wait(barrier: Barrier, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.held.has(barrier)) return;
    await new Promise<void>((resolve, reject) => {
      const waiters = this.waiters.get(barrier) ?? new Set();
      this.waiters.set(barrier, waiters);
      const clean = () => { waiters.delete(resume); signal.removeEventListener('abort', abort); };
      const resume = () => { clean(); resolve(); };
      const abort = () => { clean(); reject(signal.reason); };
      waiters.add(resume);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  snapshot() {
    return { held: [...this.held], waiting: Object.fromEntries([...this.waiters].map(([key, value]) => [key, value.size])), failures: [...this.failures] };
  }
}
