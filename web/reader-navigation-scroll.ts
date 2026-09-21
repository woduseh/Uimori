export type ReaderNavigationPosition =
  | { kind: 'end' }
  | { kind: 'source'; element: HTMLElement; offset?: number };

/** Keep an explicit navigation target through asynchronous layout, until the user takes over. */
export function retainReaderNavigation(
  node: HTMLElement,
  position: ReaderNavigationPosition,
  isCurrent: () => boolean,
  onApplied: () => void = () => {}
): () => void {
  let stopped = false;
  let frame = 0;
  let appliedTop = node.scrollTop;
  const previousAnchor = node.style.getPropertyValue('overflow-anchor');
  const previousPriority = node.style.getPropertyPriority('overflow-anchor');
  // Explicit positioning and the browser's automatic scroll anchoring must not compete.
  node.style.setProperty('overflow-anchor', 'none');
  const movedExternally = () => {
    const clamped = Math.min(appliedTop, Math.max(0, node.scrollHeight - node.clientHeight));
    return Math.abs(node.scrollTop - clamped) > 1;
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    resize.disconnect();
    mutations.disconnect();
    node.removeEventListener('scroll', onScroll);
    document.removeEventListener('wheel', stop, true);
    document.removeEventListener('touchstart', stop, true);
    document.removeEventListener('pointerdown', stop, true);
    document.removeEventListener('keydown', onKey, true);
    if (previousAnchor) node.style.setProperty('overflow-anchor', previousAnchor, previousPriority);
    else node.style.removeProperty('overflow-anchor');
  };
  const apply = () => {
    frame = 0;
    if (stopped) return;
    if (!isCurrent() || !node.isConnected) return stop();
    // Scroll events arrive asynchronously. Check ownership again before a queued resize
    // can overwrite direct scrollbar, accessibility, or another reader control's position.
    if (movedExternally()) return stop();
    if (position.kind === 'end') node.scrollTop = node.scrollHeight;
    else {
      if (!node.contains(position.element)) return stop();
      node.scrollTop +=
        position.element.getBoundingClientRect().top -
        node.getBoundingClientRect().top -
        (position.offset ?? 0);
    }
    appliedTop = node.scrollTop;
    onApplied();
  };
  const schedule = () => {
    if (!stopped && !frame) frame = requestAnimationFrame(apply);
  };
  const onKey = (event: KeyboardEvent) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key))
      stop();
  };
  const onScroll = () => {
    if (Math.abs(node.scrollTop - appliedTop) <= 1) return;
    // Direct scrollbar/accessibility scrolling also yields ownership. A layout clamp is
    // different: resize will apply the target again using the new available height.
    if (movedExternally()) stop();
    else schedule();
  };
  const resize = new ResizeObserver(schedule);
  const observe = () => {
    resize.disconnect();
    resize.observe(node);
    if (node.firstElementChild) resize.observe(node.firstElementChild);
    for (const source of node.querySelectorAll('[data-source-id]')) resize.observe(source);
    schedule();
  };
  const mutations = new MutationObserver(observe);
  mutations.observe(node, { childList: true, subtree: true });
  node.addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('wheel', stop, { capture: true, passive: true });
  document.addEventListener('touchstart', stop, { capture: true, passive: true });
  document.addEventListener('pointerdown', stop, { capture: true, passive: true });
  document.addEventListener('keydown', onKey, true);
  observe();
  return stop;
}
