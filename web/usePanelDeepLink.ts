import { useEffect, useRef } from 'react';
import { useTestMode } from './useTestMode.js';

type PanelDeepLink = { panel: string; section: string; destination: string; tab: string };

const keys = ['panel', 'section', 'destination', 'tab'] as const;
// Read once at load: useStory rewrites the address to chat/branch/source before any effect runs.
const initial = typeof location === 'undefined' ? null : new URLSearchParams(location.search);
const requested: PanelDeepLink | null =
  initial && keys.some((key) => initial.has(key))
    ? {
        panel: initial.get('panel') ?? '',
        section: initial.get('section') ?? '',
        destination: initial.get('destination') ?? '',
        tab: initial.get('tab') ?? '',
      }
    : null;

/**
 * Test-mode only. `?panel=…&section=…` and `?destination=library&tab=…` open one screen on load so
 * gallery captures and browser specs reach it without a click path. The caller validates the values;
 * the parameters leave the address once applied and are never read again.
 */
export function usePanelDeepLink(ready: boolean, apply: (link: PanelDeepLink) => void) {
  const testMode = useTestMode();
  const latest = useRef(apply);
  latest.current = apply;
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !requested || !testMode || !ready) return;
    done.current = true;
    latest.current(requested);
    const url = new URL(location.href);
    for (const key of keys) url.searchParams.delete(key);
    history.replaceState(history.state, '', url);
  }, [testMode, ready]);
}
