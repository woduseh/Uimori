import { Fragment, memo, useContext, type ReactNode } from 'react';
import { ReadingPreferencesContext } from './ReadingPreferencesContext.js';
import type { ReadabilitySettings } from './reading-preferences.js';
import { hasReadingQuotes, scanReadingQuotes, type ReadingQuote } from './reading-quotes.js';
import './prose.css';

/** Index each complete delimiter run once, including unmatched runs kept literal. */
function backtickSpans(text: string) {
  const runs = [...text.matchAll(/`+/gu)];
  const next = new Map<number, number>();
  const spans = new Map<number, number>();
  for (let index = runs.length - 1; index >= 0; index--) {
    const run = runs[index];
    const start = run.index;
    const length = run[0].length;
    const contentStart = start + length;
    const contentEnd = next.get(length) ?? contentStart;
    spans.set(start, contentEnd === contentStart ? contentStart : contentEnd + length);
    next.set(length, start);
  }
  return spans;
}

type IndexedInline = {
  start: number;
  end: number;
  node: ReactNode;
};

/** Index literal text while keeping protected spans atomic. */
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
  // A quote-heavy paragraph must not rescan all earlier inline nodes per quote.
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

const fencePattern = /^ {0,3}(`{3,}|~{3,})([\s\S]*)$/u;
/** Literal helper/stream content keeps its whitespace and never acquires Markdown semantics. */
function literalFence(text: string, offset: number): string | undefined {
  if (offset && text[offset - 1] !== '\n') return;
  let lineEnd = text.indexOf('\n', offset);
  if (lineEnd === -1) lineEnd = text.length;
  const fence = text.slice(offset, lineEnd).match(fencePattern);
  if (!fence) return;
  let lineStart = lineEnd + 1;
  while (lineStart < text.length) {
    lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = text.length;
    const closing = text.slice(lineStart, lineEnd).match(/^ {0,3}(`{3,}|~{3,})\s*$/u);
    if (closing && closing[1][0] === fence[1][0] && closing[1].length >= fence[1].length)
      return text.slice(offset, lineEnd);
    lineStart = lineEnd + 1;
  }
  return text.slice(offset);
}

function literalNodes(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Successful protected spans advance past their closer. Checking the last
  // closer first also bounds repeated unfinished openers to one linear pass.
  const lastRubyClose = text.lastIndexOf('</ruby>');
  const lastTemplateClose = text.lastIndexOf('}}');
  const lastTagClose = text.lastIndexOf('>');
  const lastLinkClose = text.lastIndexOf('](');
  const codeSpans = backtickSpans(text);
  let plain = '';
  let offset = 0;
  while (offset < text.length) {
    const rest = text.slice(offset);
    const codeEnd = codeSpans.get(offset);
    const ruby =
      offset < lastRubyClose && rest.startsWith('<ruby>')
        ? text.slice(offset, text.indexOf('</ruby>', offset + 6) + 7)
        : undefined;
    const template =
      offset < lastTemplateClose && rest.startsWith('{{')
        ? text.slice(offset, text.indexOf('}}', offset + 2) + 2)
        : undefined;
    const tag =
      offset < lastTagClose && /^<\/?[A-Za-z]/u.test(rest)
        ? text.slice(offset, text.indexOf('>', offset + 1) + 1)
        : undefined;
    const protectedText =
      literalFence(text, offset) ??
      (codeEnd === undefined ? undefined : text.slice(offset, codeEnd)) ??
      ruby ??
      template ??
      rest.match(/^\[\[p_[a-f0-9]+_\d+\]\]/u)?.[0] ??
      (offset < lastLinkClose
        ? rest.match(/^!?\[[^\]\n]{1,1000}\]\([^\s)]{1,2000}\)/u)?.[0]
        : undefined) ??
      tag ??
      rest.match(/^(?:https?:\/\/|mailto:|www\.)[^\s<>“”‘’「」『』"]+/u)?.[0];
    if (protectedText) {
      if (plain) nodes.push(plain);
      plain = '';
      nodes.push(<Fragment key={offset}>{protectedText}</Fragment>);
      offset += protectedText.length;
    } else plain += text[offset++];
  }
  if (plain) nodes.push(plain);
  return nodes;
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
