import MarkdownIt from 'markdown-it';
import type { Token } from 'markdown-it';

export type ReadingBlock = { anchor: string; start: number; end: number };
function protectTableCodePipes(line: string): string {
  const runs = [...line.matchAll(/`+/gu)];
  const next = new Map<number, number>();
  const closing = new Map<number, number>();
  for (let index = runs.length - 1; index >= 0; index--) {
    const end = next.get(runs[index][0].length);
    if (end !== undefined) closing.set(index, end);
    next.set(runs[index][0].length, index);
  }
  let output = '';
  let offset = 0;
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index];
    const end = closing.get(index);
    let slashes = 0;
    for (let cursor = run.index - 1; cursor >= 0 && line[cursor] === '\\'; cursor--) slashes++;
    if (end === undefined || slashes % 2) continue;
    const finish = runs[end].index + runs[end][0].length;
    output +=
      line.slice(offset, run.index) +
      line.slice(run.index, finish).replace(/(?<!\\)\|/gu, '\u0000');
    offset = finish;
    index = end;
  }
  return output + line.slice(offset);
}
const rubyPattern =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL represents a protected inline token, which cannot belong to validated ruby.
  /^<ruby>((?:(?:<rb>[^<>\n\u0000]+<\/rb>|[^<>\n\u0000]+)(?:<rp>[^<>\n\u0000]*<\/rp>)?<rt>[^<>\n\u0000]+<\/rt>(?:<rp>[^<>\n\u0000]*<\/rp>)?)+)<\/ruby>/u;
const readingTagPattern = /^<(u|sup|sub|mark|small|b|i|s)>([^<>\n]+)<\/\1>/u;
const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/gu,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!
  );

export function safeProseLink(value: string): string | undefined {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject controls before URL normalization.
  if (!value || /[\u0000-\u0020\u007f\\]/u.test(value)) return;
  if (value.startsWith('#') || (value.startsWith('/') && !value.startsWith('//'))) return value;
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(value).protocol) ? value : undefined;
  } catch {
    return;
  }
}

/** Only complete, attribute-free reading markup may opt native prose into decoration. */
function safeInlineHtml(children: Token[]): boolean {
  if (!children.some((token) => token.type === 'html_inline')) return true;
  const markup = children
    .map((token) =>
      token.type === 'html_inline'
        ? token.content
        : token.type === 'text'
          ? escapeHtml(token.content)
          : '\u0000'
    )
    .join('');
  const stack: string[] = [];
  for (let offset = 0; offset < markup.length; ) {
    if (markup[offset] !== '<') {
      offset++;
      continue;
    }
    const rest = markup.slice(offset);
    const ruby = rest.match(rubyPattern);
    if (ruby) {
      offset += ruby[0].length;
      continue;
    }
    const br = rest.match(/^<br\s*\/?>/u);
    if (br) {
      offset += br[0].length;
      continue;
    }
    const tag = rest.match(/^<(\/?)(u|sup|sub|mark|small|b|i|s)>/u);
    if (!tag) return false;
    if (tag[1]) {
      if (stack.pop() !== tag[2]) return false;
    } else stack.push(tag[2]);
    offset += tag[0].length;
  }
  return stack.length === 0;
}

/** Renderer provenance: authored controls never acquire app reading behavior. */
export function markReadingProse(
  md: InstanceType<typeof MarkdownIt>,
  tightParagraphs = false
): void {
  for (const type of [
    'paragraph_open',
    'heading_open',
    ...(tightParagraphs ? [] : ['list_item_open']),
    'th_open',
    'td_open',
  ]) {
    const original = md.renderer.rules[type];
    md.renderer.rules[type] = (tokens, index, options, env, renderer) => {
      const token = tokens[index]!;
      const tightItem =
        type === 'list_item_open' &&
        tokens[index + 1]?.type === 'paragraph_open' &&
        tokens[index + 1]?.hidden &&
        tokens[index + 3]?.type === 'paragraph_close' &&
        tokens[index + 4]?.type === 'list_item_close';
      const inline = tokens[index + (tightItem ? 2 : 1)];
      if (
        (type !== 'list_item_open' || tightItem) &&
        inline?.type === 'inline' &&
        safeInlineHtml(inline.children ?? [])
      )
        token.attrSet('data-uimori-prose', '');
      return original
        ? original(tokens, index, options, env, renderer)
        : renderer.renderToken(tokens, index, options);
    };
  }
}

export function createReadingMarkdown(policy: 'plain' | 'native'): InstanceType<typeof MarkdownIt> {
  const md = new MarkdownIt({
    html: policy === 'native',
    breaks: true,
    linkify: false,
    typographer: false,
  });
  // Authored indented prose/HTML is not an implicit code block in either reader.
  md.disable(['code']);
  // Protect code pipes at the table rule's actual container boundary. A same-length
  // sentinel preserves all token line/offset maps and never rewrites authored HTML.
  const blockRules = md.block.ruler.getRules('');
  md.block.ruler.disable(['table']);
  const withoutTables = new Set(md.block.ruler.getRules(''));
  const tableRule = blockRules.find((rule) => !withoutTables.has(rule))!;
  md.block.ruler.enable(['table']);
  md.block.ruler.at(
    'table',
    (state, startLine, endLine, silent) => {
      if (startLine + 1 >= endLine) return false;
      const delimiter = state.src.slice(
        state.bMarks[startLine + 1] + state.tShift[startLine + 1],
        state.eMarks[startLine + 1]
      );
      if (!/^[\t |:\-]+$/u.test(delimiter)) return false;
      const original = state.src;
      const headerStart = state.bMarks[startLine] + state.tShift[startLine];
      const headerEnd = state.eMarks[startLine];
      state.src =
        original.slice(0, headerStart) +
        protectTableCodePipes(original.slice(headerStart, headerEnd)) +
        original.slice(headerEnd);
      const valid = tableRule(state, startLine, endLine, true);
      state.src = original;
      if (!valid || silent) return valid;
      const firstToken = state.tokens.length;
      const replacements: { start: number; end: number; text: string }[] = [];
      for (let line = startLine; line < endLine; line++) {
        if (state.isEmpty(line) || state.sCount[line] < state.blkIndent) break;
        const start = state.bMarks[line] + state.tShift[line];
        const end = state.eMarks[line];
        const text = state.src.slice(start, end);
        if (text.includes('`') && text.includes('|'))
          replacements.push({ start, end, text: protectTableCodePipes(text) });
      }
      const pieces: string[] = [];
      let offset = 0;
      for (const replacement of replacements) {
        pieces.push(original.slice(offset, replacement.start), replacement.text);
        offset = replacement.end;
      }
      state.src = pieces.join('') + original.slice(offset);
      try {
        const result = tableRule(state, startLine, endLine, silent);
        if (result && !silent)
          for (const token of state.tokens.slice(firstToken))
            token.content = token.content.replaceAll('\u0000', '|');
        return result;
      } finally {
        state.src = original;
      }
    },
    { alt: ['paragraph', 'reference'] }
  );
  markReadingProse(md, policy === 'plain');
  if (policy === 'native') return md;
  md.renderer.rules.s_open = () => '<del>';
  md.renderer.rules.s_close = () => '</del>';
  const paragraph = md.renderer.rules.paragraph_open!;
  md.renderer.rules.paragraph_open = (tokens, index, options, env, renderer) => {
    const result = paragraph(tokens, index, options, env, renderer);
    return tokens[index].hidden ? `<span${renderer.renderAttrs(tokens[index])}>` : result;
  };
  md.renderer.rules.paragraph_close = (tokens, index, options, _env, renderer) =>
    tokens[index].hidden ? '</span>' : renderer.renderToken(tokens, index, options);
  // Capture the builtin rule using the public enabled-rule list, preserving its
  // reference/escape/title grammar and the exact source slice for literal images.
  const rules = md.inline.ruler.getRules('');
  md.inline.ruler.disable(['image']);
  const withoutImages = new Set(md.inline.ruler.getRules(''));
  const imageRule = rules.find((rule) => !withoutImages.has(rule))!;
  md.inline.ruler.enable(['image']);
  md.inline.ruler.at('image', (state, silent) => {
    const start = state.pos;
    const count = state.tokens.length;
    const result = imageRule(state, silent);
    if (result && !silent)
      for (const token of state.tokens.slice(count)) {
        if (token.type === 'image') token.meta = { source: state.src.slice(start, state.pos) };
      }
    return result;
  });
  md.validateLink = (url) => !!safeProseLink(url);
  const closers = new WeakMap<object, { tag: number; template: number }>();
  md.inline.ruler.before('html_inline', 'reading_html', (state, silent) => {
    if (!['<', '{', '['].includes(state.src[state.pos])) return false;
    let last = closers.get(state);
    if (!last) {
      last = { tag: state.src.lastIndexOf('>'), template: state.src.lastIndexOf('}}') };
      closers.set(state, last);
    }
    const rest = state.src.slice(state.pos);
    const ruby = rest.match(rubyPattern);
    const tag = rest.match(readingTagPattern);
    const br = rest.match(/^<br\s*\/?>/u);
    const raw = state.pos < last.tag ? rest.match(/^<\/?[A-Za-z][^>]*>/u) : null;
    const template =
      (state.pos < last.template ? rest.match(/^\{\{[\s\S]*?\}\}/u) : null) ??
      rest.match(/^\[\[p_[a-f0-9]+_\d+\]\]/u);
    const match = ruby ?? tag ?? br ?? raw ?? template;
    if (!match) return false;
    if (!silent) {
      const token = state.push(ruby || tag || br ? 'reading_html' : 'reading_literal', '', 0);
      if (ruby) {
        token.content =
          '<ruby>' +
          [
            ...ruby[1].matchAll(
              /(?:<rb>([^<>\n]+)<\/rb>|([^<>\n]+))(?:<rp>[^<>\n]*<\/rp>)?<rt>([^<>\n]+)<\/rt>(?:<rp>[^<>\n]*<\/rp>)?/gu
            ),
          ]
            .map(
              (part) =>
                `${escapeHtml(part[1] ?? part[2])}<rp>(</rp><rt>${escapeHtml(part[3])}</rt><rp>)</rp>`
            )
            .join('') +
          '</ruby>';
      } else if (tag) token.content = `<${tag[1]}>${escapeHtml(tag[2])}</${tag[1]}>`;
      else token.content = br ? '<br>' : match[0];
    }
    state.pos += match[0].length;
    return true;
  });
  md.renderer.rules.reading_html = (tokens, index) => tokens[index].content;
  md.renderer.rules.reading_literal = (tokens, index) =>
    `<span data-reading-literal>${escapeHtml(tokens[index].content)}</span>`;
  md.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
    tokens[index].attrSet('rel', 'noreferrer noopener');
    return renderer.renderToken(tokens, index, options);
  };
  md.renderer.rules.image = (tokens, index, _options, env) => {
    const token = tokens[index];
    const url = String(token.attrGet('src') ?? '');
    const alt = token.content;
    return (env?.images as Set<string> | undefined)?.has(url)
      ? `<img class="prose-embedded-image" src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async">`
      : `<span data-reading-literal>${escapeHtml((token.meta as { source: string }).source)}</span>`;
  };
  md.renderer.rules.fence = (tokens, index) => {
    const token = tokens[index];
    const mapped = token.meta as { lines: { start: number; end: number }[] } | null;
    const content = token.content.split('\n');
    const code = content
      .map((line, position) => {
        const range = mapped?.lines[position];
        const value = escapeHtml(line) + (position < content.length - 1 ? '\n' : '');
        return range
          ? `<span data-prose-start="${range.start}" data-prose-end="${range.end}">${value}</span>`
          : value;
      })
      .join('');
    return `<pre><code>${code}</code></pre>\n`;
  };
  for (const tag of ['th', 'td']) {
    const original = md.renderer.rules[`${tag}_open`]!;
    md.renderer.rules[`${tag}_open`] = (tokens, index, options, env, renderer) => {
      const token = tokens[index];
      const align = String(token.attrGet('style') ?? '').match(
        /^text-align:(left|right|center)$/u
      )?.[1];
      token.attrs = token.attrs?.filter(([name]) => name !== 'style') ?? null;
      if (tag === 'th') token.attrSet('scope', 'col');
      if (align) token.attrSet('class', `prose-table-${align}`);
      return original(tokens, index, options, env, renderer);
    };
  }
  md.renderer.rules.table_open = () => '<div class="prose-table-wrap"><table>\n';
  md.renderer.rules.table_close = () => '</table></div>\n';
  return md;
}

/** Display transforms may change lengths; never reuse canonical offsets after transforming. */
export function projectReadingText(
  text: string,
  blocks: readonly ReadingBlock[],
  display: (text: string) => string
): { text: string; blocks: ReadingBlock[] } {
  let output = '';
  let offset = 0;
  const projected: ReadingBlock[] = [];
  for (const block of blocks) {
    output += display(text.slice(offset, block.start));
    const start = output.length;
    output += display(text.slice(block.start, block.end));
    projected.push({ anchor: block.anchor, start, end: output.length });
    offset = block.end;
  }
  output += display(text.slice(offset));
  return { text: output, blocks: projected };
}

const plain = createReadingMarkdown('plain');
export function compileReadingMarkdown(
  text: string,
  blocks: readonly ReadingBlock[] = [],
  imageUrls: readonly string[] = []
) {
  const environment = {
    images: new Set(
      imageUrls.filter((url) =>
        /^\/api\/(?:package-image-blobs\/[a-f0-9]{64}|assets\/[A-Za-z0-9_-]+)$/u.test(url)
      )
    ),
  };
  const tokens = plain.parse(text, environment);
  // markdown-it normalizes line endings, but mappings refer to line numbers, not UTF-16 bytes.
  const lines = text.match(/.*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) ?? [];
  const offsets = [0];
  for (const line of lines) offsets.push(offsets.at(-1)! + line.length);
  const endOffset = (endLine: number, startLine: number) => {
    while (endLine > startLine && !lines[endLine - 1]?.trim()) endLine--;
    return (
      (offsets[endLine] ?? text.length) -
      (lines[endLine - 1]?.match(/(?:\r\n|\n|\r)$/u)?.[0].length ?? 0)
    );
  };
  const inlineAnchors: string[] = [];
  const byEnd = new Map(blocks.map((block) => [block.end, block.anchor]));
  const stack: Token[] = [];
  const chunks: string[] = [];
  let chunkStart = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type === 'fence' && token.map)
      token.meta = {
        lines: lines.slice(token.map[0] + 1, token.map[1]).map((line, position) => ({
          start: offsets[token.map![0] + 1 + position],
          end: offsets[token.map![0] + 1 + position] + line.replace(/(?:\r\n|\n|\r)$/u, '').length,
        })),
      };
    if (
      token.map &&
      token.nesting !== -1 &&
      [
        'paragraph_open',
        'heading_open',
        'list_item_open',
        'fence',
        'hr',
        'tr_open',
        'table_open',
      ].includes(token.type)
    ) {
      token.attrSet('data-prose-start', String(offsets[token.map[0]]));
      token.attrSet('data-prose-end', String(endOffset(token.map[1], token.map[0])));
    }
    if (token.type === 'inline' && tokens[index - 2]?.type === 'list_item_open') {
      const task = token.children?.[0];
      const match = task?.type === 'text' && task.content.match(/^\[([ xX])\] /u);
      if (task && match) {
        tokens[index - 2].attrSet('class', 'prose-task-item');
        task.content = task.content.slice(match[0].length);
        const checkbox = new MarkdownIt.Token('reading_html', '', 0);
        checkbox.content = `<input type="checkbox" disabled${match[1] !== ' ' ? ' checked=""' : ''}>`;
        token.children!.unshift(checkbox);
      }
    }
    if (token.nesting === 1) stack.push(token);
    const opening = token.nesting === -1 ? stack.pop() : token;
    if (stack.length || token.nesting === 1) continue;
    chunks.push(
      plain.renderer.render(tokens.slice(chunkStart, index + 1), plain.options, environment)
    );
    chunkStart = index + 1;
    const anchor = opening?.map && byEnd.get(endOffset(opening.map[1], opening.map[0]));
    if (anchor) {
      inlineAnchors.push(anchor);
      chunks.push(`<div data-prose-slot="${escapeHtml(anchor)}"></div>`);
    }
  }
  if (chunkStart < tokens.length)
    chunks.push(plain.renderer.render(tokens.slice(chunkStart), plain.options, environment));
  return { html: chunks.join(''), inlineAnchors };
}
