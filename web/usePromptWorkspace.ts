import { useSyncExternalStore } from 'react';
import type { PromptWorkspace } from '../core/product.js';
import { api, libraryChangedKey } from './api.js';
import { createPromptWorkspaceStore } from './prompt-workspace-store.js';

const store = createPromptWorkspaceStore({
  load: (signal) => api<PromptWorkspace>('/prompt-workspace', undefined, 'GET', signal),
  listen: (reload) => {
    const storage = (event: StorageEvent) => {
      if (event.key === libraryChangedKey) reload();
    };
    addEventListener('prompt-workspace-changed', reload);
    addEventListener('focus', reload);
    addEventListener('storage', storage);
    return () => {
      removeEventListener('prompt-workspace-changed', reload);
      removeEventListener('focus', reload);
      removeEventListener('storage', storage);
    };
  },
});

export function usePromptWorkspace() {
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot
  );
  return { ...snapshot, refresh: store.refresh };
}
