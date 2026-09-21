import { describe, expect, test } from 'vitest';
import MarkdownIt from 'markdown-it';
import { markRisuReadingProse } from '../server/risu-reading-markdown.js';

function render(text: string) {
  const md = new MarkdownIt({ html: true, breaks: true, linkify: false, typographer: false });
  md.disable(['code']);
  markRisuReadingProse(md);
  return md.render(text);
}
describe('Risu reading provenance markers', () => {
  test('ordinary Markdown keeps identical content with display-only markers', () => {
    const text =
      '# Heading\n\n그녀는 “**함께** 가자.”고 말했다.\n\n`“code”` [link](https://example.com)';
    const md = new MarkdownIt({ html: true, breaks: true, linkify: false, typographer: false });
    md.disable(['code']);
    expect(render(text).replaceAll(' data-uimori-prose=""', '')).toBe(md.render(text));
    expect(render(text).match(/data-uimori-prose/g)).toHaveLength(3);
  });
  test('author HTML and fenced code receive no automatic prose marker', () => {
    expect(render('<div class="widget"><p>“Author UI”</p><input></div>')).not.toContain(
      'data-uimori-prose'
    );
    expect(render('Before <button>“Action”</button> after.')).not.toContain('data-uimori-prose');
    expect(render('```html\n<p>“example”</p>\n```')).not.toContain('data-uimori-prose');
  });
  test('tight lists mark only their own text rather than nested lists', () => {
    const simple = render('- First\n- Second');
    expect(simple).toContain('<li data-uimori-prose="">First</li>');
    expect(simple.match(/data-uimori-prose/g)).toHaveLength(2);
    const nested = render('- Parent\n  - Child');
    expect(nested).not.toContain('<li data-uimori-prose="">Parent');
    expect(nested).toContain('<li data-uimori-prose="">Child</li>');
  });
  test('blockquote paragraphs are marked without changing their structure', () => {
    expect(render('> “Quoted paragraph”')).toContain('<blockquote>\n<p data-uimori-prose="">');
  });
});
