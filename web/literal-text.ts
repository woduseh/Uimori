export type LiteralTextSpan = { start: number; end: number; literal: boolean };

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

const fencePattern = /^ {0,3}(`{3,}|~{3,})([\s\S]*)$/u;
function literalFenceEnd(text: string, offset: number): number | undefined {
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
      return lineEnd;
    lineStart = lineEnd + 1;
  }
  return text.length;
}

const placeholderPattern = /\[\[p_[a-f0-9]+_\d+\]\]/uy;
const linkPattern = /!?\[[^\]\n]{1,1000}\]\([^\s)]{1,2000}\)/uy;
const urlPattern = /(?:https?:\/\/|mailto:|www\.)[^\s<>“”‘’「」『』"]+/uy;

function matchEnd(pattern: RegExp, text: string, offset: number) {
  pattern.lastIndex = offset;
  return pattern.test(text) ? pattern.lastIndex : undefined;
}

function tagNameStarts(text: string, offset: number) {
  const code = text.charCodeAt(text[offset] === '/' ? offset + 1 : offset) | 32;
  return code >= 97 && code <= 122;
}

function literalEnd(
  text: string,
  offset: number,
  codeSpans: Map<number, number>,
  last: { ruby: number; template: number; tag: number; link: number }
): number | undefined {
  switch (text[offset]) {
    case ' ':
    case '~':
      return literalFenceEnd(text, offset);
    case '`':
      return literalFenceEnd(text, offset) ?? codeSpans.get(offset);
    case '<':
      if (offset < last.ruby && text.startsWith('<ruby>', offset))
        return text.indexOf('</ruby>', offset + 6) + 7;
      return offset < last.tag && tagNameStarts(text, offset + 1)
        ? text.indexOf('>', offset + 1) + 1
        : undefined;
    case '{':
      return offset < last.template && text[offset + 1] === '{'
        ? text.indexOf('}}', offset + 2) + 2
        : undefined;
    case '[':
      return (
        matchEnd(placeholderPattern, text, offset) ??
        (offset < last.link ? matchEnd(linkPattern, text, offset) : undefined)
      );
    case '!':
      return offset < last.link ? matchEnd(linkPattern, text, offset) : undefined;
    case 'h':
    case 'm':
    case 'w':
      return matchEnd(urlPattern, text, offset);
    default:
      return undefined;
  }
}

export function literalTextSpans(text: string): LiteralTextSpan[] {
  const spans: LiteralTextSpan[] = [];
  const last = {
    ruby: text.lastIndexOf('</ruby>'),
    template: text.lastIndexOf('}}'),
    tag: text.lastIndexOf('>'),
    link: text.lastIndexOf(']('),
  };
  const codeSpans = backtickSpans(text);
  let plainStart = 0;
  let offset = 0;
  while (offset < text.length) {
    const end = literalEnd(text, offset, codeSpans, last);
    if (end === undefined) {
      offset++;
      continue;
    }
    if (plainStart < offset) spans.push({ start: plainStart, end: offset, literal: false });
    spans.push({ start: offset, end, literal: true });
    offset = end;
    plainStart = end;
  }
  if (plainStart < text.length) spans.push({ start: plainStart, end: text.length, literal: false });
  return spans;
}
