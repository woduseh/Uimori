import { validRevisionRange } from '../core/selection-revision.js';
import { readerContains } from './reader-dom.js';
import { THEME_BODY_SCROLL_SELECTOR } from './theme-body-scroll.js';

export type TextRange = { start: number; end: number };

function lineFeeds(text: string) {
  if (!text.includes('\r')) return { text, offsets: null };
  let normalized = '';
  const offsets: number[] = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\r' && text[index + 1] === '\n') continue;
    offsets.push(index);
    normalized += text[index] === '\r' ? '\n' : text[index];
  }
  offsets.push(text.length);
  return { text: normalized, offsets };
}

export function uniqueTextRange(stored: string, selected: string): TextRange | null {
  const needle = lineFeeds(selected.trim()).text;
  if (!needle) return null;
  const haystack = lineFeeds(stored);
  const first = haystack.text.indexOf(needle);
  if (first < 0 || haystack.text.indexOf(needle, first + 1) >= 0) return null;
  const end = first + needle.length;
  const range = haystack.offsets
    ? { start: haystack.offsets[first], end: haystack.offsets[end - 1] + 1 }
    : { start: first, end };
  return validRevisionRange(stored, range.start, range.end) ? range : null;
}

const EXCLUDED =
  'input, textarea, select, button, [contenteditable]:not([contenteditable="false"]), dialog, .story-ui-block';

function closestComposed(node: Node, selector: string, boundary: HTMLElement) {
  let current: Node | null = node;
  while (current && current !== boundary) {
    const element: Element | null = current instanceof Element ? current : current.parentElement;
    const match = element?.closest(selector);
    if (match) return readerContains(boundary, match) ? match : null;
    const root: Node = (element ?? current).getRootNode();
    current = root instanceof ShadowRoot ? root.host : null;
  }
  return null;
}

export type SceneSelection = { range: Range; text: string };

export function sceneSelection(body: HTMLElement): SceneSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  if (!readerContains(body, selection.anchorNode)) return null;
  const shadowRoots = [...body.querySelectorAll('.risu-message-surface')]
    .map((host) => host.shadowRoot)
    .filter((root): root is ShadowRoot => root !== null);
  const [composed] = selection.getComposedRanges({ shadowRoots });
  if (!composed || composed.collapsed) return null;
  const { startContainer, endContainer } = composed;
  if (
    startContainer.getRootNode() !== endContainer.getRootNode() ||
    !readerContains(body, startContainer) ||
    !readerContains(body, endContainer) ||
    closestComposed(startContainer, EXCLUDED, body) ||
    closestComposed(endContainer, EXCLUDED, body)
  )
    return null;
  const range = document.createRange();
  range.setStart(startContainer, composed.startOffset);
  range.setEnd(endContainer, composed.endOffset);
  const text = selection.toString();
  return text.trim() ? { range, text } : null;
}

export function visibleArea(element: HTMLElement): DOMRect {
  let top = 0;
  let left = 0;
  let bottom = innerHeight;
  let right = innerWidth;
  for (const clip of [
    element.closest<HTMLElement>('[data-reader-scrollport], .reader-scrollport'),
    element.closest<HTMLElement>(THEME_BODY_SCROLL_SELECTOR),
  ]) {
    if (!clip) continue;
    const rect = clip.getBoundingClientRect();
    top = Math.max(top, rect.top);
    left = Math.max(left, rect.left);
    bottom = Math.min(bottom, rect.bottom);
    right = Math.min(right, rect.right);
  }
  return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
}

const GAP = 8;

export function placeBeside(
  range: Range,
  area: DOMRect,
  size: { width: number; height: number },
  prefer: 'above' | 'below'
): { top: number; left: number } | null {
  const rects = [...range.getClientRects()].filter(
    (rect) => rect.width > 0 && rect.bottom > area.top && rect.top < area.bottom
  );
  if (!rects.length) return null;
  const first = rects[0];
  const last = rects[rects.length - 1];
  const left = (anchor: DOMRect) =>
    Math.round(
      Math.min(
        Math.max(anchor.left + anchor.width / 2 - size.width / 2, area.left + GAP),
        area.right - size.width - GAP
      )
    );
  const above =
    first.top - size.height - GAP >= area.top
      ? { top: Math.round(first.top - size.height - GAP), left: left(first) }
      : null;
  const below =
    last.bottom + size.height + GAP <= area.bottom
      ? { top: Math.round(last.bottom + GAP), left: left(last) }
      : null;
  if (above || below) return prefer === 'above' ? (above ?? below) : (below ?? above);
  if (area.height < size.height + GAP * 2 || area.width < size.width + GAP * 2) return null;
  return {
    top: Math.round(prefer === 'above' ? area.top + GAP : area.bottom - size.height - GAP),
    left: left(prefer === 'above' ? first : last),
  };
}
