import { themeBodyScroll, THEME_BODY_SCROLL_SELECTOR } from './theme-body-scroll.js';
export type ReaderNavigationPosition =
  | { kind: 'end' }
  | {
      kind: 'source';
      element: HTMLElement;
      anchor?: string;
      offset?: number;
      ratio?: number;
      fallbackToSource?: boolean;
      outerTop?: number;
      bodyTop?: number;
    };

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
  let body: HTMLElement | null = null;
  let appliedBodyTop = 0;
  const previousAnchor = node.style.getPropertyValue('overflow-anchor');
  const previousPriority = node.style.getPropertyPriority('overflow-anchor');
  // Explicit positioning and the browser's automatic scroll anchoring must not compete.
  node.style.setProperty('overflow-anchor', 'none');
  const movedExternally = () => {
    const clamped = Math.min(appliedTop, Math.max(0, node.scrollHeight - node.clientHeight));
    const bodyClamped = body
      ? Math.min(appliedBodyTop, Math.max(0, body.scrollHeight - body.clientHeight))
      : 0;
    return (
      Math.abs(node.scrollTop - clamped) > 1 ||
      !!(body && Math.abs(body.scrollTop - bodyClamped) > 1)
    );
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    resize.disconnect();
    mutations.disconnect();
    node.removeEventListener('scroll', onScroll, true);
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
    if (position.kind === 'end') {
      const last = [
        ...node.querySelectorAll<HTMLElement>('[data-source-id][data-representation]'),
      ].at(-1);
      body = last ? themeBodyScroll(last) : null;
      if (body) body.scrollTop = body.scrollHeight;
      node.scrollTop = node.scrollHeight;
    } else {
      if (!node.contains(position.element)) return stop();
      const anchored = position.anchor
        ? [...position.element.querySelectorAll<HTMLElement>('[data-block-anchor]')].find(
            (item) =>
              item.offsetParent !== null &&
              item.dataset.blockAnchor?.split(' ').includes(position.anchor!)
          )
        : position.element;
      const target = anchored ?? (position.fallbackToSource ? position.element : undefined);
      // A saved anchor can arrive after the surrounding article during native HTML projection.
      if (!target) return;
      body = target.closest<HTMLElement>(THEME_BODY_SCROLL_SELECTOR);
      if (body) {
        const source = body.closest<HTMLElement>('[data-source-id][data-representation]');
        if (position.outerTop !== undefined) node.scrollTop = position.outerTop;
        else if (source)
          node.scrollTop += source.getBoundingClientRect().top - node.getBoundingClientRect().top;
        body.scrollTop +=
          target.getBoundingClientRect().top -
          body.getBoundingClientRect().top -
          (position.offset ?? 0) +
          (position.ratio ?? 0) * target.getBoundingClientRect().height;
      } else {
        node.scrollTop +=
          target.getBoundingClientRect().top -
          node.getBoundingClientRect().top -
          (position.offset ?? 0) +
          (anchored ? (position.ratio ?? 0) : 0) * target.getBoundingClientRect().height;
        // A scene jump starts its passage; restoring an action button must not reset it.
        if (target.matches('[data-source-id][data-representation]')) {
          body = themeBodyScroll(target);
          if (body) body.scrollTop = 0;
        }
      }
      if (position.bodyTop !== undefined) {
        body = themeBodyScroll(
          position.element.closest<HTMLElement>('[data-source-id][data-representation]')
        );
        if (body) body.scrollTop = position.bodyTop;
      }
    }
    appliedTop = node.scrollTop;
    appliedBodyTop = body?.scrollTop ?? 0;
    onApplied();
  };
  const schedule = () => {
    if (!stopped && !frame) frame = requestAnimationFrame(apply);
  };
  const onKey = (event: KeyboardEvent) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key))
      stop();
  };
  const onScroll = (event: Event) => {
    if (event.target !== node && event.target !== body) return;
    if (
      Math.abs(node.scrollTop - appliedTop) <= 1 &&
      (!body || Math.abs(body.scrollTop - appliedBodyTop) <= 1)
    )
      return;
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
    for (const scrollport of node.querySelectorAll(THEME_BODY_SCROLL_SELECTOR)) {
      resize.observe(scrollport);
      for (const content of scrollport.children) resize.observe(content);
    }
    schedule();
  };
  const mutations = new MutationObserver(observe);
  mutations.observe(node, { childList: true, subtree: true });
  node.addEventListener('scroll', onScroll, { passive: true, capture: true });
  document.addEventListener('wheel', stop, { capture: true, passive: true });
  document.addEventListener('touchstart', stop, { capture: true, passive: true });
  document.addEventListener('pointerdown', stop, { capture: true, passive: true });
  document.addEventListener('keydown', onKey, true);
  observe();
  return stop;
}
