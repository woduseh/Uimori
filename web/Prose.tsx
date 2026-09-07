import { Fragment, type ReactNode } from 'react';

/**
 * Deliberate Markdown subset for reading saved prose. This produces React nodes,
 * never HTML. Source strings, hashes and translation anchors are not rewritten.
 * Raw HTML and Markdown images remain literal text. Only attribute-free
 * <ruby>base<rt>reading</rt></ruby> (optional rb/rp) becomes native ruby.
 */
export function safeProseLink(value: string): string | undefined {
  if (!value || /[\u0000-\u0020\u007f\\]/u.test(value)) return;
  if (value.startsWith('#') || (value.startsWith('/') && !value.startsWith('//'))) return value;
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? value : undefined;
  } catch { return; }
}

function inline(text: string, depth = 0): ReactNode[] {
  if (depth > 8) return [text];
  const nodes: ReactNode[] = [];
  let plain = '';
  const flush = () => { if (plain) { nodes.push(plain); plain = ''; } };
  let offset = 0;
  while (offset < text.length) {
    const rest = text.slice(offset);
    if (rest[0] === '\\' && /^[\\`*_{}[\]()#+.!>~-]/u.test(rest[1] ?? '')) { plain += rest[1]; offset += 2; continue; }
    if (rest[0] === '\n') { flush(); nodes.push(<Fragment key={offset}><br/>{'\n'}</Fragment>); offset++; continue; }
    const code = rest.match(/^(`+)([^]*?)\1(?!`)/u);
    if (code && code[2] && !code[2].startsWith('`')) {
      flush(); nodes.push(<code key={offset}>{code[2]}</code>); offset += code[0].length; continue;
    }
    const ruby = rest.match(/^<ruby>(?:<rb>([^<>\n]+)<\/rb>|([^<>\n]+))(?:<rp>[^<>\n]*<\/rp>)?<rt>([^<>\n]+)<\/rt>(?:<rp>[^<>\n]*<\/rp>)?<\/ruby>/u);
    if (ruby) {
      flush(); nodes.push(<ruby key={offset}>{ruby[1] ?? ruby[2]}<rp>(</rp><rt>{ruby[3]}</rt><rp>)</rp></ruby>); offset += ruby[0].length; continue;
    }
    const protectedToken = rest.match(/^(?:\{\{[^]*?\}\}|\[\[p_[a-f0-9]+_\d+\]\])/u);
    if (protectedToken) { plain += protectedToken[0]; offset += protectedToken[0].length; continue; }
    const link = rest.match(/^(!?)\[([^\]\n]{1,1000})\]\(([^)\s]{1,2000})\)/u);
    if (link) {
      const href = !link[1] ? safeProseLink(link[3]) : undefined;
      if (href) { flush(); nodes.push(<a key={offset} href={href} rel="noreferrer noopener">{inline(link[2], depth + 1)}</a>); }
      else plain += link[0];
      offset += link[0].length; continue;
    }
    // Treat tag-shaped text as one literal, including attributes and their Markdown.
    const rawTag = rest.match(/^<\/?[A-Za-z][^>]*>/u);
    if (rawTag) { plain += rawTag[0]; offset += rawTag[0].length; continue; }
    const delimiter = ['**', '__', '~~', '*', '_'].find(marker => rest.startsWith(marker));
    if (delimiter && !(delimiter.includes('_') && /[\p{L}\p{N}_]/u.test(text[offset - 1] ?? ''))) {
      const end = text.indexOf(delimiter, offset + delimiter.length);
      if (end > offset + delimiter.length && !/\s/u.test(text[offset + delimiter.length]) && !/\s/u.test(text[end - 1])) {
        const content = inline(text.slice(offset + delimiter.length, end), depth + 1);
        flush();
        nodes.push(delimiter.length === 2 && delimiter !== '~~' ? <strong key={offset}>{content}</strong> : delimiter === '~~' ? <del key={offset}>{content}</del> : <em key={offset}>{content}</em>);
        offset = end + delimiter.length; continue;
      }
    }
    plain += text[offset++];
  }
  flush();
  return nodes;
}

const fencePattern = /^ {0,3}(`{3,}|~{3,})([^]*)$/u;
const listPattern = /^ {0,3}([-+*]|\d+[.)])\s+(.+)$/u;
const quotePattern = /^ {0,3}>\s?(.*)$/u;
const headingPattern = /^ {0,3}(#{1,6})\s+(.+)$/u;
const rulePattern = /^ {0,3}(?:\*\s*){3,}$|^ {0,3}(?:-\s*){3,}$|^ {0,3}(?:_\s*){3,}$/u;
function beginsBlock(line: string): boolean {
  return !line.trim() || fencePattern.test(line) || headingPattern.test(line) || quotePattern.test(line) || listPattern.test(line) || rulePattern.test(line);
}

function renderBlocks(text: string, depth = 0): ReactNode[] {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  const output: ReactNode[] = [];
  let index = 0;
  const push = (node: ReactNode, key: number) => output.push(<Fragment key={key}>{node}{'\n\n'}</Fragment>);
  while (index < lines.length) {
    if (!lines[index].trim()) { index++; continue; }
    const start = index;
    const fence = lines[index].match(fencePattern);
    if (fence) {
      const content: string[] = []; index++;
      while (index < lines.length) {
        const closing = lines[index].match(/^ {0,3}(`{3,}|~{3,})\s*$/u);
        if (closing && closing[1][0] === fence[1][0] && closing[1].length >= fence[1].length) { index++; break; }
        content.push(lines[index++]);
      }
      push(<pre><code>{content.join('\n')}</code></pre>, start); continue;
    }
    const heading = lines[index].match(headingPattern);
    if (heading) {
      const content = inline(heading[2].replace(/\s+#+\s*$/u, ''));
      const Tag = `h${heading[1].length}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      push(<Tag>{content}</Tag>, start); index++; continue;
    }
    if (rulePattern.test(lines[index])) { push(<hr/>, start); index++; continue; }
    if (quotePattern.test(lines[index]) && depth < 8) {
      const quoted: string[] = [];
      while (index < lines.length && quotePattern.test(lines[index])) quoted.push(lines[index++].match(quotePattern)![1]);
      push(<blockquote>{renderBlocks(quoted.join('\n'), depth + 1)}</blockquote>, start); continue;
    }
    const firstItem = lines[index].match(listPattern);
    if (firstItem) {
      const ordered = /^\d/u.test(firstItem[1]);
      const items: ReactNode[] = [];
      while (index < lines.length) {
        const item = lines[index].match(listPattern);
        if (!item || /^\d/u.test(item[1]) !== ordered) break;
        const at = index++; const content = [item[2]];
        while (index < lines.length && /^ {4,}\S/u.test(lines[index]) && !listPattern.test(lines[index])) content.push(lines[index++].trimStart());
        items.push(<li key={at}>{inline(content.join('\n'))}</li>);
      }
      push(ordered ? <ol start={Number.parseInt(firstItem[1], 10)}>{items}</ol> : <ul>{items}</ul>, start); continue;
    }
    const paragraph = [lines[index++]];
    while (index < lines.length && !beginsBlock(lines[index])) paragraph.push(lines[index++]);
    push(<p>{inline(paragraph.join('\n'))}</p>, start);
  }
  return output;
}

/** Render-only input: callers keep the canonical source and anchor mapping. */
export function Prose({ text }: { text: string }) {
  return <>{renderBlocks(text)}</>;
}

