import {
  QUOTE_PAIRS,
  type QuotePairId,
  type QuoteRole,
  type ReadabilitySettings,
} from './reading-preferences.js';

export type ReadingQuote = {
  start: number;
  end: number;
  role: QuoteRole;
  separate: boolean;
  breakBefore: boolean;
  breakAfter: boolean;
  children: ReadingQuote[];
};

type OpenQuote = {
  start: number;
  id: QuotePairId;
  close: string;
  children: ReadingQuote[];
};

export function hasReadingQuotes(settings: ReadabilitySettings): boolean {
  return settings.emphasis !== 'off' || settings.dialogueBreaks || settings.thoughtBreaks;
}

const openPairs = new Map<string, (typeof QUOTE_PAIRS)[number]>(
  QUOTE_PAIRS.map((pair) => [pair.open, pair])
);
// Contraction/possessive heuristics apply to Latin words, not Korean particles
// attached to a closing quote (for example, '약속'이라는 or ‘생각’이라고).
const word = /[\p{Script=Latin}\p{N}_]/u;

function needsBoundary(text: string, offset: number, direction: -1 | 1): boolean {
  while (offset >= 0 && offset < text.length) {
    const char = text[offset];
    if (char === '\r' || char === '\n') return false;
    if (char !== ' ' && char !== '\t') return true;
    offset += direction;
  }
  return false;
}

/**
 * A linear, display-only pairing pass. Callers replace protected render nodes
 * with a single sentinel, so markup attributes and code never become quotes.
 * Unfinished nesting stays literal. Excessive nesting ends the pass safely;
 * already completed top-level quotes remain available to the renderer.
 */
export function scanReadingQuotes(text: string, settings: ReadabilitySettings): ReadingQuote[] {
  const quotes: ReadingQuote[] = [];
  if (!hasReadingQuotes(settings)) return quotes;
  const stack: OpenQuote[] = [];
  for (let offset = 0; offset < text.length; offset++) {
    const char = text[offset];
    const previousIsWord = (char === "'" || char === '’') && word.test(text[offset - 1] ?? '');
    if ((char === "'" || char === '’') && previousIsWord && word.test(text[offset + 1] ?? ''))
      continue;
    const current = stack.at(-1);
    if (current?.close === char) {
      stack.pop();
      const role = settings.quoteRoles[current.id];
      const separate =
        stack.length === 0 &&
        ((role === 'dialogue' && settings.dialogueBreaks) ||
          (role === 'thought' && settings.thoughtBreaks));
      const quote: ReadingQuote = {
        start: current.start,
        end: offset + 1,
        role,
        separate,
        breakBefore: separate && needsBoundary(text, current.start - 1, -1),
        breakAfter: separate && needsBoundary(text, offset + 1, 1),
        children: current.children,
      };
      const parent = stack.at(-1);
      if (parent) parent.children.push(quote);
      else {
        const previous = quotes.at(-1);
        // Two neighboring quotes share one inserted line break. Keeping both
        // would turn preserved spaces into an extra line under pre-wrap.
        if (
          previous?.breakAfter &&
          quote.breakBefore &&
          /^[\t ]*$/u.test(text.slice(previous.end, quote.start))
        )
          quote.breakBefore = false;
        quotes.push(quote);
      }
      continue;
    }
    const pair = openPairs.get(char);
    // A trailing straight apostrophe in James' or writers' is not an opener.
    if (!pair || (char === "'" && previousIsWord)) continue;
    if (stack.length >= 32) break;
    stack.push({ start: offset, id: pair.id, close: pair.close, children: [] });
  }
  return quotes;
}
