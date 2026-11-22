import { useLayoutEffect, useRef, type FocusEvent } from 'react';

export function useFocusFallback(candidates: () => (HTMLElement | null)[], state: string) {
  const lastFocused = useRef<HTMLElement | null>(null);
  const latestCandidates = useRef(candidates);
  latestCandidates.current = candidates;
  useLayoutEffect(() => {
    void state;
    const last = lastFocused.current;
    const active = document.activeElement;
    if (!last || (active !== last && active !== document.body && active !== null)) return;
    if (last.isConnected && !last.matches(':disabled')) return;
    latestCandidates
      .current()
      .find((node) => node?.isConnected && !node.matches(':disabled'))
      ?.focus({ preventScroll: true });
  }, [state]);
  return (event: FocusEvent<HTMLElement>) => {
    lastFocused.current = event.target;
  };
}
