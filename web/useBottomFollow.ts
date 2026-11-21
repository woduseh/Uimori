import { useCallback, useEffect, useRef, type RefObject } from 'react';

const resumeDistance = 80;

export function useBottomFollow(
  scroller: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
  enabled: boolean,
  initial: boolean
) {
  const following = useRef(initial);
  const last = useRef({ top: 0, height: 0 });
  const scrollToEnd = useCallback(() => {
    const node = scroller.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    last.current = { top: node.scrollTop, height: node.scrollHeight };
  }, [scroller]);
  const onScroll = useCallback(() => {
    const node = scroller.current;
    if (!node) return;
    const movedUp =
      node.scrollTop < last.current.top - 1 && node.scrollHeight >= last.current.height;
    if (movedUp) following.current = false;
    else if (node.scrollHeight - node.scrollTop - node.clientHeight < resumeDistance)
      following.current = true;
    last.current = { top: node.scrollTop, height: node.scrollHeight };
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
  return { following, onScroll, follow };
}
