import { useCallback, useRef } from 'react';

export function useStableHandler<Args extends unknown[], Result>(
  handler: (...args: Args) => Result
): (...args: Args) => Result {
  const latest = useRef(handler);
  latest.current = handler;
  return useCallback((...args: Args) => latest.current(...args), []);
}
