import { AsyncLocalStorage } from 'node:async_hooks';
import { isMainThread } from 'node:worker_threads';

type EntropyScope = { used: boolean; parent?: EntropyScope };

const scopes = new AsyncLocalStorage<EntropyScope>();
const workerFlag = Symbol.for('uimori.native-risu.entropy');

export function recordNativeRisuEntropy(): void {
  if (!isMainThread) (globalThis as Record<symbol, unknown>)[workerFlag] = true;
  nativeRisuEntropyMarker()();
}

export function nativeRisuEntropyMarker(): () => void {
  const scope = scopes.getStore();
  return () => {
    for (let current = scope; current; current = current.parent) current.used = true;
  };
}

export async function trackNativeRisuEntropy<T>(
  work: () => Promise<T>
): Promise<{ value: T; entropyUsed: boolean }> {
  const scope: EntropyScope = { used: false, parent: scopes.getStore() };
  const value = await scopes.run(scope, work);
  return { value, entropyUsed: scope.used };
}
