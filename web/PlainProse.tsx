import { Fragment, memo, useContext, type ReactNode } from 'react';
import { ReadingPreferencesContext } from './ReadingPreferencesContext.js';
import type { ReadabilitySettings } from './reading-preferences.js';
import { hasReadingQuotes, scanReadingQuotes, type ReadingQuote } from './reading-quotes.js';
import { literalTextSpans } from './literal-text.js';
import './prose.css';

type IndexedInline = {
  start: number;
  end: number;
  node: ReactNode;
};

function indexInline(nodes: ReactNode[]): { nodes: IndexedInline[]; text: string } {
  const parts: string[] = [];
  let offset = 0;
  const indexed = nodes.map((node) => {
    const start = offset;
    if (typeof node === 'string') {
      parts.push(node);
      offset += node.length;
    } else {
      parts.push('\u0000');
      offset++;
    }
    return { start, end: offset, node };
  });
  return { nodes: indexed, text: parts.join('') };
}

function sliceInline(nodes: IndexedInline[], start: number, end: number): ReactNode[] {
  if (start >= end) return [];
  let low = 0;
  let high = nodes.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (nodes[middle].end <= start) low = middle + 1;
    else high = middle;
  }
  const result: ReactNode[] = [];
  for (let index = low; index < nodes.length && nodes[index].start < end; index++) {
    const item = nodes[index];
    if (typeof item.node === 'string') {
      result.push(item.node.slice(Math.max(start - item.start, 0), end - item.start));
    } else result.push(item.node);
  }
  return result;
}

function applyReading(nodes: ReactNode[], settings: ReadabilitySettings): ReactNode[] {
  if (!hasReadingQuotes(settings)) return nodes;
  const indexed = indexInline(nodes);
  const quotes = scanReadingQuotes(indexed.text, settings);
  if (!quotes.length) return nodes;
  const renderRange = (start: number, end: number, ranges: ReadingQuote[]): ReactNode[] => {
    const result: ReactNode[] = [];
    let offset = start;
    for (const quote of ranges) {
      result.push(...sliceInline(indexed.nodes, offset, quote.start));
      const content = renderRange(quote.start, quote.end, quote.children);
      result.push(
        quote.role === 'off' || (settings.emphasis === 'off' && !quote.separate) ? (
          <Fragment key={`quote:${quote.start}`}>{content}</Fragment>
        ) : (
          <span
            key={`quote:${quote.start}`}
            className={[
              'reading-quote',
              quote.separate && 'reading-quote-break',
              quote.breakBefore && 'reading-quote-break-before',
              quote.breakAfter && 'reading-quote-break-after',
            ]
              .filter(Boolean)
              .join(' ')}
            data-quote-role={quote.role}
            data-emphasis={settings.emphasis}
          >
            {content}
          </span>
        )
      );
      offset = quote.end;
    }
    result.push(...sliceInline(indexed.nodes, offset, end));
    return result;
  };
  return renderRange(0, indexed.text.length, quotes);
}

function literalNodes(text: string): ReactNode[] {
  return literalTextSpans(text).map(({ start, end, literal }) =>
    literal ? <Fragment key={start}>{text.slice(start, end)}</Fragment> : text.slice(start, end)
  );
}

export const PlainProse = memo(function PlainProse({
  text,
  reading,
}: {
  text: string;
  reading?: ReadabilitySettings;
}) {
  const preferences = useContext(ReadingPreferencesContext);
  const settings = reading ?? preferences;
  const quotesEnabled = hasReadingQuotes(settings);
  if (!quotesEnabled && settings.paragraphSpacing === null) return <>{text}</>;
  const indexed = indexInline(literalNodes(text));
  const paragraphs: ReactNode[] = [];
  const pushParagraph = (start: number, end: number) => {
    if (start >= end) return;
    const content = sliceInline(indexed.nodes, start, end);
    paragraphs.push(
      <span className="reading-plain-paragraph" key={start}>
        {quotesEnabled ? applyReading(content, settings) : content}
      </span>
    );
  };
  let start = 0;
  for (const separator of indexed.text.matchAll(/\r?\n[\t ]*\r?\n(?:[\t ]*\r?\n)*/gu)) {
    pushParagraph(start, separator.index);
    paragraphs.push(separator[0]);
    start = separator.index + separator[0].length;
  }
  pushParagraph(start, indexed.text.length);
  return <>{paragraphs}</>;
});
