import type { Store } from '../../server/store.js';
import type { HelperWorkspace } from '../../server/helper-workspace.js';
import type { SynchronousResult } from '../../server/synchronous-transaction.js';

/** A generic caller can forward an already synchronous callback without losing T. */
export function forwardSynchronousOperation<T>(
  store: Store,
  workspace: HelperWorkspace,
  apply: () => SynchronousResult<T>
): T {
  return store.transaction<T>(() => workspace.operation<T>('task', 'operation', {}, apply));
}

/** Compiler-only contract; these calls never execute against a database. */
export function synchronousTransactionTypeContract(
  store: Store,
  workspace: HelperWorkspace,
  thenable: PromiseLike<number>,
  maybeAsync: () => number | Promise<number>
): void {
  const number: number = store.transaction(() => 1);
  const text: string = workspace.operation('task', 'operation', {}, () => 'saved');
  const empty: ReturnType<() => void> = store.transaction(() => {});
  const emptyOperation: ReturnType<() => void> = workspace.operation(
    'task',
    'operation',
    {},
    () => {}
  );
  const nested: number = store.transaction(() => store.transaction(() => 1));
  const nullable: number | null = store.transaction(() => (number ? number : null));
  const metadata: { then: string } = store.transaction(() => ({ then: 'label' }));
  void [text, empty, emptyOperation, nested, nullable, metadata];

  // @ts-expect-error An async callback would outlive the SQLite transaction.
  store.transaction(async () => 1);
  // @ts-expect-error Async callbacks returning no value still return a Promise.
  store.transaction(async () => {});
  // @ts-expect-error A returned Promise is asynchronous even without async syntax.
  store.transaction(() => Promise.resolve(1));
  // @ts-expect-error PromiseLike returns have the same lifetime problem.
  store.transaction(() => thenable);
  // @ts-expect-error Every possible return must finish synchronously.
  store.transaction(maybeAsync);

  // @ts-expect-error An async operation cannot atomically save its receipt.
  workspace.operation('task', 'operation', {}, async () => 1);
  // @ts-expect-error An async void callback cannot atomically save its receipt.
  workspace.operation('task', 'operation', {}, async () => {});
  // @ts-expect-error Returning a Promise cannot atomically save its receipt.
  workspace.operation('task', 'operation', {}, () => Promise.resolve(1));
  // @ts-expect-error PromiseLike results cannot be saved as completed receipts.
  workspace.operation('task', 'operation', {}, () => thenable);
  // @ts-expect-error Mixed synchronous/asynchronous results are not safe receipts.
  workspace.operation('task', 'operation', {}, maybeAsync);
}
