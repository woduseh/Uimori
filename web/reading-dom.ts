import { hasReadingQuotes, scanReadingQuotes, type ReadingQuote } from './reading-quotes.js';
import type { ReadabilitySettings } from './reading-preferences.js';

const protectedElements =
  'a, code, pre, ruby, rt, rp, button, input, select, textarea, label, summary, ' +
  'style, script, svg, math, [contenteditable], [risu-trigger], [risu-btn]';
type TextPart = { node: Text; start: number; end: number };

function paragraphText(paragraph: Element): { text: string; parts: TextPart[] } {
  const parts: TextPart[] = [];
  let text = '';
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const start = text.length;
      text += node.textContent ?? '';
      parts.push({ node: node as Text, start, end: text.length });
    } else if (node instanceof Element) {
      if (node.matches(protectedElements)) text += '\u0000';
      else if (node.tagName === 'BR') text += '\n';
      else for (const child of node.childNodes) visit(child);
    }
  };
  for (const child of paragraph.childNodes) visit(child);
  // Preserve offsets while keeping unresolved CBS, anchors and literal URLs out of pairing.
  text = text.replace(
    /\{\{[\s\S]*?\}\}|\[\[p_[a-f0-9]+_\d+\]\]|(?:https?:\/\/|mailto:|www\.)[^\s<>“”‘’「」『』"]+/gu,
    (value) => '\u0000'.repeat(value.length)
  );
  return { text, parts };
}

/** Decorate only renderer-marked prose; never rebuild authored controls or inline elements. */
export function createReadingDecorator(content: HTMLElement) {
  const owned: HTMLElement[] = [];
  let previous = '';
  const clear = () => {
    const parents = new Set<Node>();
    for (const span of owned.reverse()) {
      const parent = span.parentNode;
      if (!parent) continue;
      parents.add(parent);
      span.replaceWith(...span.childNodes);
    }
    owned.length = 0;
    for (const parent of parents) parent.normalize();
  };
  return {
    update(settings: ReadabilitySettings) {
      const key = JSON.stringify([
        settings.emphasis,
        settings.dialogueBreaks,
        settings.thoughtBreaks,
        settings.quoteRoles,
      ]);
      if (key === previous) return;
      previous = key;
      clear();
      if (!hasReadingQuotes(settings)) return;
      for (const paragraph of content.querySelectorAll('[data-uimori-prose]')) {
        // The marker is emitted from Markdown tokens, not guessed from arbitrary <p> tags.
        if (paragraph.closest(protectedElements)) continue;
        const { text, parts } = paragraphText(paragraph);
        const quotes = scanReadingQuotes(text, settings);
        if (!quotes.length) continue;
        for (const part of parts) {
          let changed = false;
          const render = (start: number, end: number, ranges: ReadingQuote[]): DocumentFragment => {
            const result = document.createDocumentFragment();
            const appendText = (from: number, to: number) => {
              if (to > from)
                result.append(part.node.data.slice(from - part.start, to - part.start));
            };
            let low = 0;
            let high = ranges.length;
            while (low < high) {
              const middle = (low + high) >>> 1;
              if (ranges[middle]!.end <= start) low = middle + 1;
              else high = middle;
            }
            let offset = start;
            for (let i = low; i < ranges.length && ranges[i]!.start < end; i++) {
              const quote = ranges[i]!;
              const from = Math.max(start, quote.start);
              const to = Math.min(end, quote.end);
              appendText(offset, from);
              const children = render(from, to, quote.children);
              if (quote.role === 'off' || (settings.emphasis === 'off' && !quote.separate)) {
                result.append(children);
              } else {
                const span = document.createElement('span');
                span.className = 'reading-quote';
                span.dataset.quoteRole = quote.role;
                span.dataset.emphasis = settings.emphasis;
                if (quote.separate) span.classList.add('reading-quote-break');
                if (quote.breakBefore && from === quote.start)
                  span.classList.add('reading-quote-break-before');
                if (quote.breakAfter && to === quote.end)
                  span.classList.add('reading-quote-break-after');
                span.append(children);
                owned.push(span);
                result.append(span);
                changed = true;
              }
              offset = to;
            }
            appendText(offset, end);
            return result;
          };
          const fragment = render(part.start, part.end, quotes);
          if (changed) part.node.replaceWith(fragment);
        }
      }
    },
    clear,
  };
}
