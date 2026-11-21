import { createContext, useContext, useEffect, useRef } from 'react';
import type { HelperChangeAnchor } from '../core/helper.js';
import type { ResourceKind } from '../core/resource-editing.js';
import { markArrivalWhenShown } from './arrival-mark.js';

export type ResourceAnchor = Extract<HelperChangeAnchor, { domain: 'resource' }> & {
  epoch: number;
};

export const ResourceAnchorContext = createContext<{
  anchor: ResourceAnchor | null;
  consume: (epoch: number) => void;
}>({ anchor: null, consume: () => {} });

export type ResourceAnchorRequest = ReturnType<typeof useResourceAnchor>;

export function useResourceAnchor(kind: ResourceKind, id: string | null | undefined) {
  const { anchor, consume } = useContext(ResourceAnchorContext);
  return {
    anchor: anchor && id && anchor.kind === kind && anchor.id === id ? anchor : null,
    consume,
  };
}

export function useAnchorArrival(
  target: ResourceAnchorRequest | null | undefined,
  find: (anchor: ResourceAnchor) => Element | null,
  apply: (anchor: ResourceAnchor) => void
) {
  const anchor = target?.anchor ?? null;
  const handled = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const latest = useRef({ find, apply, consume: target?.consume });
  latest.current = { find, apply, consume: target?.consume };
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!anchor || handled.current === anchor.epoch) return;
    handled.current = anchor.epoch;
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    latest.current.apply(anchor);
    markArrivalWhenShown(() => latest.current.find(anchor), current.signal);
    latest.current.consume?.(anchor.epoch);
  }, [anchor]);
}
