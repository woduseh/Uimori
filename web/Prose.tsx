import {
  Fragment,
  cloneElement,
  isValidElement,
  memo,
  useContext,
  useMemo,
  type ReactElement,
  type ReactNode,
} from 'react';
import { ReadingPreferencesContext } from './ReadingPreferencesContext.js';
import type { ReadabilitySettings } from './reading-preferences.js';
import { hasReadingQuotes, scanReadingQuotes, type ReadingQuote } from './reading-quotes.js';
import './prose.css';

/**
 * Deliberate Markdown subset for reading saved prose. This produces React nodes,
 * never HTML. Source strings, hashes and translation anchors are not rewritten.
 * Raw HTML and unapproved Markdown images remain literal text. Only attribute-free
 * <ruby>base<rt>reading</rt></ruby> (optional rb/rp) becomes native ruby.
 */
export function safeProseLink(value: string): string | undefined {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject C0 controls and DEL before URL parsing can normalize them away.
  if (!value || /[\u0000-\u0020\u007f\\]/u.test(value)) return;
  if (value.startsWith('#') || (value.startsWith('/') && !value.startsWith('//'))) return value;
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? value : undefined;
  } catch {
    return;
  }
}

/** Index each complete delimiter run once, including unmatched runs kept literal. */
function backtickSpans(text: string) {
  const runs = [...text.matchAll(/`+/gu)];
  const next = new Map<number, number>();
  const spans = new Map<number, { contentStart: number; contentEnd: number; end: number }>();
  const addSpan = (start: number, length: number) => {
    const contentStart = start + length;
    const contentEnd = next.get(length) ?? contentStart;
    spans.set(start, {
      contentStart,
      contentEnd,
      end: contentEnd === contentStart ? contentStart : contentEnd + length,
    });
  };
  for (let index = runs.length - 1; index >= 0; index--) {
    const run = runs[index];
    addSpan(run.index, run[0].length);
    // Inline escaping can consume just the first tick; literal rendering consumes the whole run.
    if (run[0].length > 1) addSpan(run.index + 1, run[0].length - 1);
    next.set(run[0].length, run.index);
  }
  return spans;
}

function inline(
  text: string,
  depth = 0,
  protectQuotes = false,
  imageUrls?: ReadonlySet<string>
): ReactNode[] {
  if (depth > 8) return protectQuotes ? [<Fragment key="literal-depth">{text}</Fragment>] : [text];
  const nodes: ReactNode[] = [];
  // A completed template advances past its closer; unfinished openers must not
  // each search the remaining paragraph for a closer that does not exist.
  const lastTemplateClose = text.lastIndexOf('}}');
  const lastTagClose = text.lastIndexOf('>');
  const codeSpans = backtickSpans(text);
  let plain = '';
  const flush = () => {
    if (plain) {
      nodes.push(plain);
      plain = '';
    }
  };
  let offset = 0;
  while (offset < text.length) {
    const rest = text.slice(offset);
    if (rest[0] === '\\' && /^[\\`*_{}[\]()#+.!>~|-]/u.test(rest[1] ?? '')) {
      plain += rest[1];
      offset += 2;
      continue;
    }
    if (rest[0] === '\n') {
      flush();
      nodes.push(
        <Fragment key={offset}>
          <br />
          {'\n'}
        </Fragment>
      );
      offset++;
      continue;
    }
    const code = codeSpans.get(offset);
    if (code) {
      if (code.contentEnd > code.contentStart) {
        flush();
        nodes.push(<code key={offset}>{text.slice(code.contentStart, code.contentEnd)}</code>);
      } else plain += text.slice(offset, code.end);
      offset = code.end;
      continue;
    }
    const ruby = rest.match(
      /^<ruby>(?:<rb>([^<>\n]+)<\/rb>|([^<>\n]+))(?:<rp>[^<>\n]*<\/rp>)?<rt>([^<>\n]+)<\/rt>(?:<rp>[^<>\n]*<\/rp>)?<\/ruby>/u
    );
    if (ruby) {
      flush();
      nodes.push(
        <ruby key={offset}>
          {ruby[1] ?? ruby[2]}
          <rp>(</rp>
          <rt>{ruby[3]}</rt>
          <rp>)</rp>
        </ruby>
      );
      offset += ruby[0].length;
      continue;
    }
    const protectedToken =
      (offset < lastTemplateClose && rest.startsWith('{{')
        ? text.slice(offset, text.indexOf('}}', offset + 2) + 2)
        : undefined) ?? rest.match(/^\[\[p_[a-f0-9]+_\d+\]\]/u)?.[0];
    if (protectedToken) {
      if (protectQuotes) {
        flush();
        nodes.push(<Fragment key={offset}>{protectedToken}</Fragment>);
      } else plain += protectedToken;
      offset += protectedToken.length;
      continue;
    }
    const link = rest.match(/^(!?)\[([^\]\n]{0,1000})\]\(([^)\s]{1,2000})\)/u);
    if (link) {
      const href = !link[1] ? safeProseLink(link[3]) : undefined;
      if (link[1] && imageUrls?.has(link[3])) {
        flush();
        nodes.push(
          <img
            key={offset}
            className="prose-embedded-image"
            src={link[3]}
            alt={link[2]}
            loading="lazy"
            decoding="async"
          />
        );
      } else if (href) {
        flush();
        nodes.push(
          <a key={offset} href={href} rel="noreferrer noopener">
            {inline(link[2], depth + 1, false, imageUrls)}
          </a>
        );
      } else if (protectQuotes) {
        flush();
        nodes.push(<Fragment key={offset}>{link[0]}</Fragment>);
      } else plain += link[0];
      offset += link[0].length;
      continue;
    }
    const autoLink = rest.match(/^<((?:https?:\/\/|mailto:)[^\s<>]+)>/u);
    if (autoLink) {
      const href = safeProseLink(autoLink[1]);
      if (href) {
        flush();
        nodes.push(
          <a key={offset} href={href} rel="noreferrer noopener">
            {autoLink[1]}
          </a>
        );
        offset += autoLink[0].length;
        continue;
      }
    }
    // Treat tag-shaped text as one literal, including attributes and their Markdown.
    const rawTag = offset < lastTagClose && rest.match(/^<\/?[A-Za-z][^>]*>/u);
    if (rawTag) {
      if (protectQuotes) {
        flush();
        nodes.push(<Fragment key={offset}>{rawTag[0]}</Fragment>);
      } else plain += rawTag[0];
      offset += rawTag[0].length;
      continue;
    }
    const url = protectQuotes && rest.match(/^(?:https?:\/\/|mailto:|www\.)[^\s<>“”‘’「」『』"]+/u);
    if (url) {
      flush();
      nodes.push(<Fragment key={offset}>{url[0]}</Fragment>);
      offset += url[0].length;
      continue;
    }
    const delimiter = ['**', '__', '~~', '*', '_'].find((marker) => rest.startsWith(marker));
    if (delimiter && !(delimiter.includes('_') && /[\p{L}\p{N}_]/u.test(text[offset - 1] ?? ''))) {
      const end = text.indexOf(delimiter, offset + delimiter.length);
      if (
        end > offset + delimiter.length &&
        !/\s/u.test(text[offset + delimiter.length]) &&
        !/\s/u.test(text[end - 1])
      ) {
        const content = inline(
          text.slice(offset + delimiter.length, end),
          depth + 1,
          protectQuotes,
          imageUrls
        );
        flush();
        nodes.push(
          delimiter.length === 2 && delimiter !== '~~' ? (
            <strong key={offset}>{content}</strong>
          ) : delimiter === '~~' ? (
            <del key={offset}>{content}</del>
          ) : (
            <em key={offset}>{content}</em>
          )
        );
        offset = end + delimiter.length;
        continue;
      }
    }
    plain += text[offset++];
  }
  flush();
  return nodes;
}

type IndexedInline = {
  start: number;
  end: number;
  node: ReactNode;
  children?: IndexedInline[];
};

/** Index visible text across emphasis nodes while treating other nodes atomically. */
function indexInline(nodes: ReactNode[]): { nodes: IndexedInline[]; text: string } {
  const parts: string[] = [];
  let offset = 0;
  const visit = (items: ReactNode[]): IndexedInline[] =>
    items.map((node) => {
      const start = offset;
      let children: IndexedInline[] | undefined;
      if (typeof node === 'string') {
        parts.push(node);
        offset += node.length;
      } else if (
        isValidElement<{ children: ReactNode[] }>(node) &&
        (node.type === 'strong' || node.type === 'em' || node.type === 'del')
      ) {
        children = visit(node.props.children);
      } else {
        const children = isValidElement<{ children?: ReactNode[] }>(node)
          ? node.props.children
          : undefined;
        const isLineBreak =
          Array.isArray(children) &&
          children.length === 2 &&
          isValidElement(children[0]) &&
          children[0].type === 'br' &&
          children[1] === '\n';
        parts.push(isLineBreak ? '\n' : '\u0000');
        offset++;
      }
      return { start, end: offset, node, children };
    });
  return { nodes: visit(nodes), text: parts.join('') };
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
    } else if (item.children) {
      result.push(
        cloneElement(
          item.node as ReactElement<{ children: ReactNode }>,
          { key: `${item.start}:${start}:${end}` },
          sliceInline(item.children, start, end)
        )
      );
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

function readableInline(
  text: string,
  settings: ReadabilitySettings,
  imageUrls?: ReadonlySet<string>
): ReactNode[] {
  return applyReading(inline(text, 0, hasReadingQuotes(settings), imageUrls), settings);
}

const fencePattern = /^ {0,3}(`{3,}|~{3,})([\s\S]*)$/u;
const listPattern = /^ {0,3}([-+*]|\d+[.)])\s+(.+)$/u;
const quotePattern = /^ {0,3}>\s?(.*)$/u;
const headingPattern = /^ {0,3}(#{1,6})\s+(.+)$/u;
const setextPattern = /^ {0,3}(=+|-+)\s*$/u;
const rulePattern = /^ {0,3}(?:\*\s*){3,}$|^ {0,3}(?:-\s*){3,}$|^ {0,3}(?:_\s*){3,}$/u;
type TableAlignment = 'left' | 'center' | 'right' | null;

function splitTableRow(line: string): string[] {
  let value = line.trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|') && !value.endsWith('\\|')) value = value.slice(0, -1);

  const cells: string[] = [];
  let current = '';
  let codeTicks = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === '\\' && index + 1 < value.length) {
      current += value[index] + value[++index];
      continue;
    }
    if (value[index] === '`') {
      let end = index + 1;
      while (value[end] === '`') end++;
      const run = end - index;
      if (codeTicks === 0) codeTicks = run;
      else if (codeTicks === run) codeTicks = 0;
      current += value.slice(index, end);
      index = end - 1;
      continue;
    }
    if (value[index] === '|' && codeTicks === 0) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += value[index];
  }
  cells.push(current.trim());
  return cells;
}

function tableDelimiter(line: string): TableAlignment[] | null {
  if (!line.includes('|')) return null;
  const cells = splitTableRow(line);
  if (!cells.length) return null;
  const alignments: TableAlignment[] = [];
  for (const cell of cells) {
    const marker = cell.replace(/\s/gu, '');
    if (!/^:?-{3,}:?$/u.test(marker)) return null;
    alignments.push(
      marker.startsWith(':') && marker.endsWith(':')
        ? 'center'
        : marker.endsWith(':')
          ? 'right'
          : marker.startsWith(':')
            ? 'left'
            : null
    );
  }
  return alignments;
}

function tableStart(lines: string[], index: number) {
  if (!lines[index]?.includes('|') || index + 1 >= lines.length) return null;
  const alignments = tableDelimiter(lines[index + 1]);
  if (!alignments) return null;
  const header = splitTableRow(lines[index]);
  return header.length === alignments.length ? { header, alignments } : null;
}

function beginsBlock(line: string): boolean {
  return (
    !line.trim() ||
    fencePattern.test(line) ||
    headingPattern.test(line) ||
    quotePattern.test(line) ||
    listPattern.test(line) ||
    rulePattern.test(line)
  );
}

function renderBlocks(
  text: string,
  settings: ReadabilitySettings,
  depth = 0,
  imageUrls?: ReadonlySet<string>
): ReactNode[] {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  const output: ReactNode[] = [];
  let index = 0;
  const push = (node: ReactNode, key: number) =>
    output.push(
      <Fragment key={key}>
        {node}
        {'\n\n'}
      </Fragment>
    );
  while (index < lines.length) {
    if (!lines[index].trim()) {
      index++;
      continue;
    }
    const start = index;
    const fence = lines[index].match(fencePattern);
    if (fence) {
      const content: string[] = [];
      index++;
      while (index < lines.length) {
        const closing = lines[index].match(/^ {0,3}(`{3,}|~{3,})\s*$/u);
        if (closing && closing[1][0] === fence[1][0] && closing[1].length >= fence[1].length) {
          index++;
          break;
        }
        content.push(lines[index++]);
      }
      push(
        <pre>
          <code>{content.join('\n')}</code>
        </pre>,
        start
      );
      continue;
    }
    const table = tableStart(lines, index);
    if (table) {
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        const cells = splitTableRow(lines[index++]).slice(0, table.header.length);
        while (cells.length < table.header.length) cells.push('');
        rows.push(cells);
      }
      const cellClass = (alignment: TableAlignment) =>
        alignment ? `prose-table-${alignment}` : undefined;
      push(
        <div className="prose-table-wrap">
          <table>
            <thead>
              <tr>
                {table.header.map((cell, column) => (
                  <th key={column} scope="col" className={cellClass(table.alignments[column])}>
                    {readableInline(cell, settings, imageUrls)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, column) => (
                    <td key={column} className={cellClass(table.alignments[column])}>
                      {readableInline(cell, settings, imageUrls)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
        start
      );
      continue;
    }
    const setext =
      index + 1 < lines.length && lines[index].trim()
        ? lines[index + 1].match(setextPattern)
        : null;
    if (setext && !beginsBlock(lines[index])) {
      const Tag = setext[1][0] === '=' ? 'h1' : 'h2';
      push(<Tag>{readableInline(lines[index], settings, imageUrls)}</Tag>, start);
      index += 2;
      continue;
    }
    const heading = lines[index].match(headingPattern);
    if (heading) {
      const content = readableInline(heading[2].replace(/\s+#+\s*$/u, ''), settings, imageUrls);
      const Tag = `h${heading[1].length}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      push(<Tag>{content}</Tag>, start);
      index++;
      continue;
    }
    if (rulePattern.test(lines[index])) {
      push(<hr />, start);
      index++;
      continue;
    }
    if (quotePattern.test(lines[index]) && depth < 8) {
      const quoted: string[] = [];
      while (index < lines.length && quotePattern.test(lines[index]))
        quoted.push(lines[index++].match(quotePattern)![1]);
      push(
        <blockquote>{renderBlocks(quoted.join('\n'), settings, depth + 1, imageUrls)}</blockquote>,
        start
      );
      continue;
    }
    const firstItem = lines[index].match(listPattern);
    if (firstItem) {
      const ordered = /^\d/u.test(firstItem[1]);
      const items: ReactNode[] = [];
      while (index < lines.length) {
        const item = lines[index].match(listPattern);
        if (!item || /^\d/u.test(item[1]) !== ordered) break;
        const at = index++;
        const content = [item[2]];
        while (
          index < lines.length &&
          /^ {4,}\S/u.test(lines[index]) &&
          !listPattern.test(lines[index])
        )
          content.push(lines[index++].trimStart());
        const task = content[0].match(/^\[([ xX])\]\s+(.*)$/u);
        if (task) content[0] = task[2];
        items.push(
          <li key={at} className={task ? 'prose-task-item' : undefined}>
            {task && (
              <input
                type="checkbox"
                checked={task[1].toLowerCase() === 'x'}
                disabled
                readOnly
                aria-hidden="true"
              />
            )}
            {task ? (
              <span>{readableInline(content.join('\n'), settings, imageUrls)}</span>
            ) : (
              readableInline(content.join('\n'), settings, imageUrls)
            )}
          </li>
        );
      }
      push(
        ordered ? <ol start={Number.parseInt(firstItem[1], 10)}>{items}</ol> : <ul>{items}</ul>,
        start
      );
      continue;
    }
    const paragraph = [lines[index++]];
    while (index < lines.length && !beginsBlock(lines[index]) && !tableStart(lines, index))
      paragraph.push(lines[index++]);
    push(<p>{readableInline(paragraph.join('\n'), settings, imageUrls)}</p>, start);
  }
  return output;
}

/** Render-only input: callers keep the canonical source and anchor mapping. */
export const Prose = memo(function Prose({
  text,
  reading,
  allowedImageUrls,
}: {
  text: string;
  reading?: ReadabilitySettings;
  allowedImageUrls?: readonly string[];
}) {
  const preferences = useContext(ReadingPreferencesContext);
  const images = useMemo(
    () =>
      new Set(
        (allowedImageUrls ?? []).filter((url) =>
          /^\/api\/package-image-blobs\/[a-f0-9]{64}$/u.test(url)
        )
      ),
    [allowedImageUrls]
  );
  return <>{renderBlocks(text, reading ?? preferences, 0, images)}</>;
});

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
    const codeEnd = codeSpans.get(offset)?.end;
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
