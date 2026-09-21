/** Check declarations, not just today's layout: a media query or checkbox can enable fixed UI. */
function canFixPosition(style: CSSStyleDeclaration): boolean {
  const position = style.getPropertyValue('position');
  return position === 'fixed' || position.includes('var(');
}
function hasFixedRule(rules: CSSRuleList): boolean {
  for (const rule of rules) {
    if ('style' in rule && canFixPosition((rule as CSSStyleRule).style)) return true;
    if ('cssRules' in rule && hasFixedRule((rule as CSSGroupingRule).cssRules)) return true;
  }
  return false;
}

/** Messages without fixed-position declarations install no layout observer or listeners. */
export function reserveFixedControls(host: HTMLElement, content: HTMLElement): () => void {
  const candidates = new Set<Element>();
  for (const control of content.querySelectorAll(
    '[risu-trigger],[risu-btn],button,label[for],a[href],input,select,textarea,summary,[role="button"],[tabindex]'
  )) {
    for (let node: Element | null = control; node && node !== content; node = node.parentElement)
      candidates.add(node);
  }
  if (!candidates.size) return () => {};
  const inlineFixed = [...candidates].some(
    (node) => node instanceof HTMLElement && canFixPosition(node.style)
  );
  if (
    !inlineFixed &&
    ![...host.shadowRoot!.styleSheets].some((sheet) => hasFixedRule(sheet.cssRules))
  )
    return () => {};

  let disposed = false;
  let frame = 0;
  let width = -1;
  let fixed = new Set<Element>();
  const update = () => {
    frame = 0;
    if (disposed || !host.isConnected) return;
    const bounds = host.getBoundingClientRect();
    const next = new Set<Element>();
    let floor = 0;
    for (const node of candidates) {
      const style = getComputedStyle(node);
      if (style.position !== 'fixed') continue;
      next.add(node);
      const rect = node.getBoundingClientRect();
      if (
        !rect.height ||
        rect.right <= bounds.left ||
        rect.left >= bounds.right ||
        style.visibility === 'hidden' ||
        style.opacity === '0'
      )
        continue;
      const top = Number.parseFloat(style.top);
      const bottom = Number.parseFloat(style.bottom);
      const inset =
        style.top !== 'auto' && Number.isFinite(top)
          ? Math.max(0, top)
          : Number.isFinite(bottom)
            ? Math.max(0, bottom)
            : 0;
      floor = Math.max(floor, rect.height + inset);
    }
    for (const node of fixed) if (!next.has(node)) observer.unobserve(node);
    for (const node of next) if (!fixed.has(node)) observer.observe(node, { box: 'border-box' });
    fixed = next;
    const value = floor ? `${Math.ceil(Math.min(30000, floor))}px` : '';
    if (host.style.minHeight !== value) host.style.minHeight = value;
  };
  const schedule = () => {
    if (!frame && !disposed) frame = requestAnimationFrame(update);
  };
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (entry.target !== host || entry.contentRect.width !== width) schedule();
      if (entry.target === host) width = entry.contentRect.width;
    }
  });
  // The host width can change without a window resize (for example when the sidebar opens).
  observer.observe(host);
  const events = ['change', 'toggle', 'load', 'transitionend', 'animationend'] as const;
  for (const type of events) content.addEventListener(type, schedule, true);
  window.addEventListener('resize', schedule);
  update();
  return () => {
    disposed = true;
    cancelAnimationFrame(frame);
    observer.disconnect();
    for (const type of events) content.removeEventListener(type, schedule, true);
    window.removeEventListener('resize', schedule);
    host.style.removeProperty('min-height');
  };
}
