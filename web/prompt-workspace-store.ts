import type { PromptWorkspace } from '../core/product.js';

type Snapshot = Readonly<{ workspace: PromptWorkspace | null; error: string }>;
type Session = { requested: number; controller: AbortController; flight?: Promise<void> };
const empty: Snapshot = { workspace: null, error: '' };

/** One read owner per open workspace, not one request/listener set per mounted consumer. */
export function createPromptWorkspaceStore(options: {
  load: (signal: AbortSignal) => Promise<PromptWorkspace>;
  listen: (invalidate: () => void) => () => void;
}) {
  let snapshot = empty;
  let session: Session | undefined;
  let unlisten: (() => void) | undefined;
  const subscriptions = new Set<{ notify: () => void }>();
  const publish = (next: Snapshot) => {
    snapshot = next;
    for (const subscription of [...subscriptions]) subscription.notify();
  };
  const drain = async (owner: Session) => {
    try {
      while (session === owner) {
        const requested = owner.requested;
        let next: Snapshot;
        try {
          next = { workspace: await options.load(owner.controller.signal), error: '' };
        } catch (caught) {
          next = {
            workspace: snapshot.workspace,
            error: caught instanceof Error ? caught.message : String(caught),
          };
        }
        if (session !== owner) return;
        // An invalidation during a read owes another read. Never publish the superseded answer.
        if (requested !== owner.requested) continue;
        publish(next);
        // A subscriber may invalidate synchronously while observing this result.
        if (requested === owner.requested) return;
      }
    } finally {
      // Release before the drain resolves, so a delivery-time invalidation cannot be lost.
      owner.flight = undefined;
    }
  };
  const refresh = (): Promise<void> => {
    const owner = session;
    if (!owner) return Promise.resolve();
    owner.requested++;
    // Defer starting until flight is installed; synchronous invalidations share this drain.
    owner.flight ??= Promise.resolve().then(() => drain(owner));
    return owner.flight;
  };
  const subscribe = (notify: () => void) => {
    const subscription = { notify };
    subscriptions.add(subscription);
    if (subscriptions.size === 1) {
      session = { requested: 0, controller: new AbortController() };
      unlisten = options.listen(() => {
        void refresh();
      });
      void refresh();
    }
    return () => {
      if (!subscriptions.delete(subscription) || subscriptions.size) return;
      const previous = session;
      session = undefined;
      previous?.controller.abort();
      unlisten?.();
      unlisten = undefined;
      // Closing the workspace/session releases both cached data and any in-flight answer.
      snapshot = empty;
    };
  };
  return { subscribe, getSnapshot: () => snapshot, getServerSnapshot: () => empty, refresh };
}
