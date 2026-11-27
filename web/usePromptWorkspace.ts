import { useSyncExternalStore } from 'react';
import type { PromptWorkspace } from '../core/product.js';
import { promptEndpoints } from '#contracts';
import { callEndpoint, libraryChangedKey } from './api.js';
import { helperDataFrame, promptWorkspaceFrame } from './live-frames.js';
import { watchLive } from './live-stream.js';
import { helperRefreshSpacing } from './poll-delays.js';
import { createPromptWorkspaceStore } from './prompt-workspace-store.js';

const store = createPromptWorkspaceStore({
  load: async (signal) =>
    (await callEndpoint(promptEndpoints.readWorkspace, {}, signal)) as PromptWorkspace,
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
