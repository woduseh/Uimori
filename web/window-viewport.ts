import { useSyncExternalStore } from 'react';

type Viewport = { width: number; height: number };
let viewport: Viewport | null = null;
const listeners = new Set<() => void>();
let resizeTimer: ReturnType<typeof setTimeout> | undefined;

function readViewport(): Viewport {
  return { width: window.innerWidth, height: window.innerHeight };
}
function updateViewport() {
  const next = readViewport();
  if (next.width === viewport?.width && next.height === viewport?.height) return;
  viewport = next;
  for (const listener of listeners) listener();
}
// Mobile browsers change only the height when the on-screen keyboard or the address bar
// shows or hides, so a height change alone is not a new display size.
function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (window.innerWidth !== viewport?.width) updateViewport();
  }, 150);
}
function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    updateViewport();
    window.addEventListener('resize', onResize);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener('resize', onResize);
      clearTimeout(resizeTimer);
    }
  };
}
const serverSnapshot = () => null;
const inactiveSubscribe = () => () => {};
function snapshot() {
  if (typeof window !== 'undefined' && listeners.size === 0) updateViewport();
  return viewport;
}

/** One resize listener serves every displayed card; inactive readers do not subscribe. */
export function useWindowViewport(enabled = true): Viewport | null {
  return useSyncExternalStore(
    enabled ? subscribe : inactiveSubscribe,
    enabled ? snapshot : serverSnapshot,
    serverSnapshot
  );
}
