import { type DependencyList, type EffectCallback, useCallback, useEffect, useState } from 'react';

export function useRetryableEffect(effect: EffectCallback, deps: DependencyList) {
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: biome.json checks callers' deps against their effect; attempt reruns it on retry.
  useEffect(effect, [...deps, attempt]);
  return useCallback(() => setAttempt((value) => value + 1), []);
}
