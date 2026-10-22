import { createHash } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { splitSource } from '../core/auxiliary.js';
import {
  compileReadingMarkdown,
  createReadingMarkdown,
  projectReadingText,
} from '../core/reading-markdown.js';
import { SourceReader } from '../web/SourceReader.js';

function source(text: string) {
  const source = {
    id: 'whole-markdown',
    chatId: 'chat',
    runId: 'run',
    parentRevision: null,
    text,
    hash: createHash('sha256').update(text).digest('hex'),
  };
  return { ...source, blocks: splitSource(source) };
}

test('whole message compilation preserves canonical identity across false fence closers, loose lists and reference definitions', () => {
  for (const text of [
    '```text\nfirst\n```notclose\n\ninside\n```\n\nAfter',
    '- first\n\n- second\n\n[reference][story]\n\n[story]: https://example.com/story',
  ]) {
    const value = source(text);
    const before = structuredClone(value);
    const compiled = compileReadingMarkdown(text, value.blocks);
    const html = renderToStaticMarkup(
      createElement(SourceReader, {
        source: value,
        index: 0,
        jobs: [],
        assets: [],
        refresh: async () => {},
        onError: () => {},
        onFork: async () => {},
      })
    );
    expect(value).toEqual(before);
    for (const block of value.blocks) expect(html).toContain(`data-block-anchor="${block.anchor}"`);
    if (text.startsWith('```')) {
      expect(compiled.html.match(/<pre>/gu)).toHaveLength(1);
      expect(compiled.html).not.toMatch(/<p\b[^>]*>inside/u);
      expect(html.match(/<pre>/gu)).toHaveLength(1);
    } else {
      expect(compiled.html.match(/<ul>/gu)).toHaveLength(1);
      expect(compiled.html).toContain('href="https://example.com/story"');
      expect(html.match(/<ul>/gu)).toHaveLength(1);
      expect(compiled.inlineAnchors).not.toContain(value.blocks[0].anchor);
      expect(compiled.inlineAnchors).toContain(value.blocks[1].anchor);
    }
  }
});

test('display offsets follow length-changing image removal without changing the stored blocks or separators', () => {
  const value = source(
    'first ![image](/api/assets/local)\r\n\r\nsecond\r\n\r\n- third\r\n\r\n- fourth'
  );
  const before = structuredClone(value);
  const projected = projectReadingText(value.text, value.blocks, (text) =>
    text.replace('![image](/api/assets/local)', '')
  );
  expect(projected.text).toBe('first \r\n\r\nsecond\r\n\r\n- third\r\n\r\n- fourth');
  expect(projected.blocks[1].start).toBe(10);
  expect(projected.blocks.map((block) => block.anchor)).toEqual(
    value.blocks.map((block) => block.anchor)
  );
  expect(value).toEqual(before);
  const compiled = compileReadingMarkdown(projected.text, projected.blocks);
  expect(compiled.inlineAnchors).toEqual([
    value.blocks[0].anchor,
    value.blocks[1].anchor,
    value.blocks[3].anchor,
  ]);
});

test('native prose markers admit complete safe reading inline markup, while controls and malformed markup stay author-owned', () => {
  const md = createReadingMarkdown('native');
  for (const text of [
    'before “<ruby>港<rt>‘항구’</rt></ruby>에 가자” after',
    'before “<u>함께</u><br>가자” after',
    '- “<ruby>港<rt>항구</rt></ruby>”',
  ])
    expect(md.render(text)).toContain('data-uimori-prose');
  for (const text of [
    'before <u onclick="x()">“unsafe”</u>',
    'before <button>“action”</button>',
    'before <ruby>missing rt</ruby> “quote”',
    'before <u>unclosed “quote”',
    'before <ruby><rt>no base</rt></ruby>',
  ])
    expect(md.render(text)).not.toContain('data-uimori-prose');
  expect(md.render('`<ruby>港<rt>항구</rt></ruby>`')).toContain('&lt;ruby&gt;');
});

test('unapproved Markdown images preserve their authored title, escapes, angle destination and reference syntax', () => {
  for (const image of [
    '![x](<https://x.test/a> "title")',
    '![\\*x\\*](https://x.test/a "a title")',
    '![x][picture]',
    '![picture][]',
    '![picture]',
  ]) {
    const result = compileReadingMarkdown(
      `${image}\n\n[picture]: https://x.test/a "reference title"`
    );
    const literal = image
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
    expect(result.html).toContain(literal);
    expect(result.html).not.toContain('<img');
  }
});

test('table code uses whole matching backtick runs inside Markdown containers and leaves authored HTML alone', () => {
  const adjacent = compileReadingMarkdown('Before\n| A | B |\n|---|---|\n| `a|b` | c |').html;
  expect(adjacent).toContain('>Before</p>');
  expect(adjacent).toContain('<table>');
  expect(adjacent).toContain('<code>a|b</code>');
  expect(adjacent).toMatch(/>c<\/td>/u);
  for (const size of [1, 2, 3]) {
    const tick = '`'.repeat(size);
    const middle = '`'.repeat(size + 2);
    const row = `| ${tick}a ${middle} b | c${tick} | d | ${tick}z | y${tick} |`;
    for (const prefix of ['', '> ']) {
      const text = ['| A | B | C |', '|---|---|---|', row].map((line) => prefix + line).join('\n');
      const html = compileReadingMarkdown(text).html;
      expect(html.match(/<td\b/gu)).toHaveLength(3);
      expect(html).toContain(`<code>a ${middle} b | c</code>`);
      expect(html).toMatch(/>d<\/td>/u);
      expect(html).toContain('<code>z | y</code>');
    }
  }
  const raw = '<div>\n| A | B |\n|---|---|\n| `a|b` | c |\n</div>';
  expect(createReadingMarkdown('native').render(raw)).toBe(raw);
});
