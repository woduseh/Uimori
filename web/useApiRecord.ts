import { useState } from 'react';
import { api } from './api.js';
import { toUiMessage } from './api-errors.js';
import type { UiMessage } from './ui-message.js';
import { useRetryableEffect } from './useRetryableEffect.js';

export function useApiRecord<T>(path: string, revision: number | string, enabled: boolean) {
  const [record, setRecord] = useState<{ path: string; value: T | null; error: UiMessage | null }>({
    path,
    value: null,
    error: null,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: The record reloads for the same path when the reader revision changes.
  const retry = useRetryableEffect(() => {
    if (!enabled) return;
    let alive = true;
    setRecord((old) => ({ path, value: old.path === path ? old.value : null, error: null }));
    void api<T>(path)
      .then((value) => {
        if (alive) setRecord({ path, value, error: null });
      })
      .catch((error) => {
        if (alive)
          setRecord((old) => ({
            path,
            value: old.path === path ? old.value : null,
            error: toUiMessage(error),
          }));
      });
    return () => {
      alive = false;
    };
  }, [path, revision, enabled]);
  const current = record.path === path ? record : { value: null, error: null };
  return { value: current.value, error: current.error, retry };
}
