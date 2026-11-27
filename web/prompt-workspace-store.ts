import type { PromptWorkspace } from '../core/product.js';
import { toUiMessage } from './api-errors.js';
import type { UiMessage } from './ui-message.js';

type Snapshot = Readonly<{ workspace: PromptWorkspace | null; error: UiMessage | null }>;
type Session = { requested: number; controller: AbortController; flight?: Promise<void> };
const empty: Snapshot = { workspace: null, error: null };

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
          next = { workspace: await options.load(owner.controller.signal), error: null };
        } catch (caught) {
          next = {
            workspace: snapshot.workspace,
            error: toUiMessage(caught),
          };
        }
        if (session !== owner) return;
        if (requested !== owner.requested) continue;
        publish(next);
        if (requested === owner.requested) return;
      }
    } finally {
      owner.flight = undefined;
    }
  };
  const refresh = (): Promise<void> => {
    const owner = session;
    if (!owner) return Promise.resolve();
    owner.requested++;
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
      snapshot = empty;
    };
  };
  return { subscribe, getSnapshot: () => snapshot, getServerSnapshot: () => empty, refresh };
}
