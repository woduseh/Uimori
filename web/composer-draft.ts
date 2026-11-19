import { useSyncExternalStore } from 'react';

export type ComposerDraft = {
  read: () => string;
  write: (text: string) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createComposerDraft(): ComposerDraft {
  let text = '';
  const listeners = new Set<() => void>();
  return {
    read: () => text,
    write(next) {
      if (next === text) return;
      text = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function useComposerDraftText(draft: ComposerDraft) {
  return useSyncExternalStore(draft.subscribe, draft.read);
}

export function useComposerDraftEmpty(draft: ComposerDraft) {
  return useSyncExternalStore(draft.subscribe, () => !draft.read().trim());
}
