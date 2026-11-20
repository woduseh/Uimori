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
  const clippedBody =
    article &&
    scrollport !== reader &&
    (viewport.bottom <= outer.top || viewport.top >= outer.bottom);
  const top = (clippedBody ? viewport.top : Math.max(outer.top, viewport.top)) + 12;
  const block = firstReadingBlock(source, top);
  return { source, block, scrollport, top };
}

export function localReadingBlock(
  reader: HTMLElement,
  location: ReturnType<typeof readerLocation>
) {
  if (location?.block || reader.querySelector(THEME_BODY_SCROLL_SELECTOR)) return location?.block;
  return firstReadingBlock(reader, reader.getBoundingClientRect().top + 12, true);
}

function firstReadingBlock(scope: HTMLElement, top: number, ordered = false) {
  const blocks = scope.querySelectorAll<HTMLElement>('[data-block-anchor]');
  const markers = blocks[0]?.parentElement;
  if (
    ordered ||
    (markers?.classList.contains('reading-markdown') &&
      blocks[blocks.length - 1]?.parentElement === markers)
  ) {
    let low = 0;
    let high = blocks.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (blocks[mid].offsetParent === null) break;
      if (blocks[mid].getBoundingClientRect().bottom <= top) low = mid + 1;
      else high = mid;
    }
    if (low === high) return blocks[low] as HTMLElement | undefined;
  }
  for (const item of blocks) {
    if (item.offsetParent !== null && item.getBoundingClientRect().bottom > top) return item;
  }
}
