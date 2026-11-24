import { useState } from 'react';
import { api } from './api.js';
import { useRetryableEffect } from './useRetryableEffect.js';

export function useApiRecord<T>(path: string, revision: number | string, enabled: boolean) {
  const [record, setRecord] = useState<{ path: string; value: T | null; error: string }>({
    path,
    value: null,
    error: '',
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: The record reloads for the same path when the reader revision changes.
  const retry = useRetryableEffect(() => {
    if (!enabled) return;
    let alive = true;
    setRecord((old) => ({ path, value: old.path === path ? old.value : null, error: '' }));
    void api<T>(path)
      .then((value) => {
        if (alive) setRecord({ path, value, error: '' });
      })
      .catch((error) => {
        if (alive)
          setRecord((old) => ({
            path,
            value: old.path === path ? old.value : null,
            error: (error as Error).message,
          }));
      });
    return () => {
      alive = false;
    };
  }, [path, revision, enabled]);
  const current = record.path === path ? record : { value: null, error: '' };
  return { value: current.value, error: current.error, retry };
}
