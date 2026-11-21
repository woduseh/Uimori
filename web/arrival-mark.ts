import './arrival-mark.css';

const ARRIVAL_CLASS = 'arrival-mark';

export function markArrival(element: Element, scroll = true) {
  if (scroll) element.scrollIntoView({ block: 'center', inline: 'nearest' });
  element.classList.remove(ARRIVAL_CLASS);
  void (element as HTMLElement).offsetWidth;
  element.classList.add(ARRIVAL_CLASS);
  const clear = () => {
    element.classList.remove(ARRIVAL_CLASS);
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
