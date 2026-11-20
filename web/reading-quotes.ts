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
const word = /[\p{Script=Latin}\p{N}_]/u;

function needsBoundary(text: string, offset: number, direction: -1 | 1): boolean {
  let newlines = 0;
  while (offset >= 0 && offset < text.length) {
    const char = text[offset];
    if (char === '\n') {
      newlines++;
      if (newlines >= 2) return false;
    } else if (char !== '\r' && char !== ' ' && char !== '\t') {
      return true;
    }
    offset += direction;
  }
  return false;
}

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
        if (
          previous?.breakAfter &&
          quote.breakBefore &&
          /^[\t ]*(?:\r?\n[\t ]*)?$/u.test(text.slice(previous.end, quote.start))
        )
          quote.breakBefore = false;
        quotes.push(quote);
      }
      continue;
    }
    const pair = openPairs.get(char);
    if (!pair || (char === "'" && previousIsWord)) continue;
    if (stack.length >= 32) break;
    stack.push({ start: offset, id: pair.id, close: pair.close, children: [] });
  }
  return quotes;
}
