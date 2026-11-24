import { useSyncExternalStore } from 'react';
import type { PromptWorkspace } from '../core/product.js';
import { api, libraryChangedKey } from './api.js';
import { helperDataFrame, promptWorkspaceFrame } from './live-frames.js';
import { watchLive } from './live-stream.js';
import { helperRefreshSpacing } from './poll-delays.js';
import { createPromptWorkspaceStore } from './prompt-workspace-store.js';

const store = createPromptWorkspaceStore({
  load: (signal) => api<PromptWorkspace>('/prompt-workspace', undefined, 'GET', signal),
  listen: (reload) => {
    const storage = (event: StorageEvent) => {
      if (event.key === libraryChangedKey) reload();
    };
    const live = watchLive({
      match: (frame) => promptWorkspaceFrame(frame) || helperDataFrame(frame),
      refresh: async () => reload(),
      minIntervalMs: helperRefreshSpacing,
    });
    addEventListener('focus', reload);
    addEventListener('storage', storage);
    return () => {
      live.dispose();
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
