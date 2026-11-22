import './arrival-mark.css';

const ARRIVAL_CLASS = 'arrival-mark';
const INSET_ATTRIBUTE = 'data-arrival-inset';

function ringClipped(element: Element) {
  const style = getComputedStyle(element);
  const extent = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
  const ring = element.getBoundingClientRect();
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const clipping = getComputedStyle(parent);
    if (clipping.overflowX === 'visible' && clipping.overflowY === 'visible') continue;
    const box = parent.getBoundingClientRect();
    return (
      ring.left - extent < box.left ||
      ring.top - extent < box.top ||
      ring.right + extent > box.right ||
      ring.bottom + extent > box.bottom
    );
  }
  return false;
}

export function markArrival(element: Element, scroll = true) {
  if (scroll) element.scrollIntoView({ block: 'center', inline: 'nearest' });
  element.classList.remove(ARRIVAL_CLASS);
  element.removeAttribute(INSET_ATTRIBUTE);
  void (element as HTMLElement).offsetWidth;
  element.classList.add(ARRIVAL_CLASS);
  element.toggleAttribute(INSET_ATTRIBUTE, ringClipped(element));
  const clear = () => {
    element.classList.remove(ARRIVAL_CLASS);
    element.removeAttribute(INSET_ATTRIBUTE);
    element.removeEventListener('animationend', ended);
    document.removeEventListener('pointerdown', clear, true);
    document.removeEventListener('keydown', clear, true);
  };
  const ended = (event: Event) => {
    if (event.target === element) clear();
  };
  element.addEventListener('animationend', ended);
  document.addEventListener('pointerdown', clear, true);
  document.addEventListener('keydown', clear, true);
}

export function markArrivalWhenShown(
  find: () => Element | null,
  signal: AbortSignal,
  scroll = true
) {
  let frame = 0;
  let observer: MutationObserver | null = null;
  const stop = () => {
    cancelAnimationFrame(frame);
    observer?.disconnect();
    document.removeEventListener('pointerdown', stop, true);
    document.removeEventListener('keydown', stop, true);
  };
  const attempt = () => {
    if (signal.aborted) return stop();
    const element = find();
    if (!element || !element.getClientRects().length) return;
    stop();
    frame = requestAnimationFrame(() => {
      if (!signal.aborted) markArrival(element, scroll);
    });
  };
  signal.addEventListener('abort', stop, { once: true });
  document.addEventListener('pointerdown', stop, true);
  document.addEventListener('keydown', stop, true);
  observer = new MutationObserver(attempt);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['hidden', 'class'],
  });
  attempt();
}
