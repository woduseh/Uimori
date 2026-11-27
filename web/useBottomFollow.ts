import { useCallback, useEffect, useRef, type RefObject } from 'react';

const resumeDistance = 80;

export type ScrollMark = { top: number; height: number };
export type ScrollSample = ScrollMark & { clientHeight: number };

export function followAfterScroll(
  following: boolean,
  last: ScrollMark,
  now: ScrollSample
): boolean | null {
  if (now.clientHeight === 0) return null;
  if (now.top < last.top - 1 && now.height >= last.height) return false;
  if (now.height - now.top - now.clientHeight < resumeDistance) return true;
  return following;
}

export function useBottomFollow(
  scroller: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
  enabled: boolean,
  initial: boolean
) {
  const following = useRef(initial);
  const last = useRef<ScrollMark>({ top: 0, height: 0 });
  const place = useCallback(
    (top: number) => {
      const node = scroller.current;
      if (!node) return;
      node.scrollTop = top;
      last.current = { top: node.scrollTop, height: node.scrollHeight };
    },
    [scroller]
  );
  const scrollToEnd = useCallback(() => {
    const node = scroller.current;
    if (node) place(node.scrollHeight);
  }, [scroller, place]);
  const onScroll = useCallback(() => {
    const node = scroller.current;
    if (!node) return false;
    const now = {
      top: node.scrollTop,
      height: node.scrollHeight,
      clientHeight: node.clientHeight,
    };
    const next = followAfterScroll(following.current, last.current, now);
    if (next === null) return false;
    following.current = next;
    last.current = { top: now.top, height: now.height };
    return true;
  }, [scroller]);
  const follow = useCallback(() => {
    following.current = true;
    scrollToEnd();
  }, [scrollToEnd]);
  useEffect(() => {
    const node = content.current;
    if (!enabled || !node) return;
    const observer = new ResizeObserver(() => {
      if (following.current) scrollToEnd();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, content, scrollToEnd]);
  return { following, onScroll, follow, place };
}
