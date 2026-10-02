/** Only an explicitly marked theme body participates in nested reader scrolling. */
export const THEME_BODY_SCROLL_SELECTOR = '[data-uimori-body-scroll][slot="body"]';

export function themeBodyScroll(element: HTMLElement | null): HTMLElement | null {
  if (!element) return null;
  return (
    element.closest<HTMLElement>(THEME_BODY_SCROLL_SELECTOR) ??
    element.querySelector<HTMLElement>(THEME_BODY_SCROLL_SELECTOR)
  );
}

export function readingScrollport(element: HTMLElement | null): HTMLElement | null {
  let current = element;
  while (current) {
    const scrollport = current.closest<HTMLElement>(
      `${THEME_BODY_SCROLL_SELECTOR}, [data-reader-scrollport], .reader-scrollport, .helper-messages`
    );
    if (scrollport) return scrollport;
    const root = current.getRootNode();
    current = root instanceof ShadowRoot ? (root.host as HTMLElement) : null;
  }
  return null;
}

/** Find the passage actually visible through both the scene body and outer reader. */
export function readerLocation(reader: HTMLElement, article?: HTMLElement) {
  const outer = reader.getBoundingClientRect();
  const scenes = article
    ? [article]
    : [...reader.querySelectorAll<HTMLElement>('[data-source-id][data-representation]')];
  const source =
    scenes.find((item) => {
      const body = themeBodyScroll(item);
      const rect = (body ?? item).getBoundingClientRect();
      return rect.bottom > outer.top + 12 && (!body || rect.top < outer.bottom);
    }) ?? (article && article.getBoundingClientRect().bottom > outer.top ? article : undefined);
  if (!source) return null;
  const scrollport = themeBodyScroll(source) ?? reader;
  const viewport = scrollport.getBoundingClientRect();
  // An explicit scene action may remain visible after its whole body scrolls out
  // of the outer viewport. Bookmark that body's own passage, not its clipped tail.
  const clippedBody =
    article &&
    scrollport !== reader &&
    (viewport.bottom <= outer.top || viewport.top >= outer.bottom);
  const top = (clippedBody ? viewport.top : Math.max(outer.top, viewport.top)) + 12;
  const block = [...source.querySelectorAll<HTMLElement>('[data-block-anchor]')].find(
    (item) => item.offsetParent !== null && item.getBoundingClientRect().bottom > top
  );
  return { source, block, scrollport, top };
}
