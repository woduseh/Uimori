import { useCallback, useEffect, useRef, useState } from 'react';
import type { PromptWorkspace } from '../core/product.js';
import { api, libraryChangedKey } from './api.js';

export function usePromptWorkspace() {
  const [workspace, setWorkspace] = useState<PromptWorkspace | null>(null);
  const [error, setError] = useState('');
  const version = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++version.current;
    try {
      const value = await api<PromptWorkspace>('/prompt-workspace');
      if (request === version.current) {
        setWorkspace(value);
        setError('');
      }
    } catch (caught) {
      if (request === version.current) setError((caught as Error).message);
    }
  }, []);
  useEffect(() => {
    const reload = () => {
      void refresh();
    };
    const storage = (event: StorageEvent) => {
      if (event.key === libraryChangedKey) reload();
    };
    reload();
    addEventListener('prompt-workspace-changed', reload);
    addEventListener('focus', reload);
    addEventListener('storage', storage);
    return () => {
      version.current++;
      removeEventListener('prompt-workspace-changed', reload);
      removeEventListener('focus', reload);
      removeEventListener('storage', storage);
    };
  }, [refresh]);
  return { workspace, error, refresh };
}
