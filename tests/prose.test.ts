import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { Prose, safeProseLink } from '../web/Prose.js';
import { webCitationLinks } from '../core/helper-web-search.js';

// Compare semantic HTML independently of app-owned provenance/geometry and host wrappers.
const render = (text: string) =>
  renderToStaticMarkup(createElement(Prose, { text }))
    .replace(
      /^<div class="reading-markdown"><div class="reading-markdown-content">|<\/div><\/div>$/gu,
      ''
    )
    .replace(/ data-(?:prose-start|prose-end|uimori-prose)="[^"]*"/gu, '')
    .replace(/<span(?: data-reading-literal)?(?:="")?>|<\/span>/gu, '')
    .replace(/>\n(?=<(?:li|\/ul|\/ol))/gu, '>');

describe('safe prose rendering', () => {
  test('renders provider search citations as safe clickable links, including URL parentheses', () => {
    const html = render(
      webCitationLinks([
        { title: '공식 요금', url: 'https://example.com/pricing_(standard)?version=1' },
        { title: '위험', url: 'javascript:alert(1)' },
      ])
    );
    expect(html).toContain(
      '<a href="https://example.com/pricing_(standard)?version=1" rel="noreferrer noopener">공식 요금</a>'
    );
    expect(html).not.toContain('위험');
    expect(render('[실행](<javascript:alert(1)>)')).not.toContain('<a ');
  });
  test('renders only explicitly registered local images and keeps code and external images literal', () => {
    const local = `/api/package-image-blobs/${'a'.repeat(64)}`;
    const other = `/api/package-image-blobs/${'b'.repeat(64)}`;
    const external = 'https://example.com/tracking.png';
    const text = `![등록 이미지](${local})\n![](${local})\n![다른 이미지](${other})\n![외부](${external})\n\n\`![코드](${local})\`\n\n\`\`\`\n![블록 코드](${local})\n\`\`\``;
    const html = renderToStaticMarkup(
      createElement(Prose, { text, allowedImageUrls: [local, external] })
    );
    expect(html.match(/<img /gu)).toHaveLength(2);
    expect(html).toContain(`src="${local}"`);
    expect(html).not.toContain(`src="${other}"`);
    expect(html).not.toContain(`src="${external}"`);
    expect(html).toContain(`![다른 이미지](${other})`);
    expect(html).toContain(`<code>![코드](${local})</code>`);
  });
  test('renders headings, emphasis, quotes, lists and line breaks with semantic elements', () => {
    const html = render(
      '# 실제 원고 제목\n\n**강조**와 *기울임*\n다음 줄\n\n> 인용한 문장\n> 이어지는 문장\n\n- 하나\n- 둘\n\n3. 셋\n4. 넷'
    );
    expect(html).toContain('<h1>실제 원고 제목</h1>');
    expect(html).toContain('<strong>강조</strong>');
    expect(html).toContain('<em>기울임</em>');
    expect(html).toContain('<br>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<ul><li>하나</li><li>둘</li></ul>');
    expect(html).toContain('<ol start="3"><li>셋</li><li>넷</li></ol>');
  });

  test('renders common assistant Markdown including tables, tasks, setext headings and autolinks', () => {
    const html = render(
      '점검 결과\n---\n\n| 영향 | 이전 동작 | 변경 후 |\n| :--- | :---: | ---: |\n| 표 | \\| 원문 \\| | **정상** |\n| 코드 | `a|b` | ~~제거~~ |\n\n- [x] 완료\n- [ ] 남음\n\n<https://example.com/report>'
    );
    expect(html).toContain('<h2>점검 결과</h2>');
    expect(html).toContain('<table>');
    expect(html).toContain('<th scope="col" class="prose-table-left">영향</th>');
    expect(html).toContain('<th scope="col" class="prose-table-center">이전 동작</th>');
    expect(html).toContain('<th scope="col" class="prose-table-right">변경 후</th>');
    expect(html).toContain('<td class="prose-table-center">| 원문 |</td>');
    expect(html).toContain('<code>a|b</code>');
    expect(html).toContain('<del>제거</del>');
    expect(html.match(/class="prose-task-item"/gu)).toHaveLength(2);
    expect(html.match(/type="checkbox"/gu)).toHaveLength(2);
    expect(html).toContain('checked=""');
    expect(html).toContain(
      '<a href="https://example.com/report" rel="noreferrer noopener">https://example.com/report</a>'
    );
  });

  test('escapes raw HTML, blocks executable links and never requests Markdown images', () => {
    const html = render(
      '<script>window.pwned=true</script>\n<img src=x onerror=alert(1)>\n<svg onload=alert(1)></svg>\n\n[실행](javascript:alert) ![외부 이미지](https://example.com/track.png)\n[안전한 링크](https://example.com/story)'
    );
    expect(html).not.toMatch(/<(?:script|img|svg)\b/u);
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('![외부 이미지](https://example.com/track.png)');
    expect(html).toContain(
      '<a href="https://example.com/story" rel="noreferrer noopener">안전한 링크</a>'
    );
  });

  test('allows only attribute-free ruby and keeps other HTML literal', () => {
    const html = render(
      '<ruby>物語<rt>이야기</rt></ruby>\n<ruby><rb>港</rb><rp>(</rp><rt>항구</rt><rp>)</rp></ruby>\n<ruby onclick="alert(1)">위험<rt>표기</rt></ruby>'
    );
    expect(html).toContain('<ruby>物語<rp>(</rp><rt>이야기</rt><rp>)</rp></ruby>');
    expect(html).toContain('<ruby>港<rp>(</rp><rt>항구</rt><rp>)</rp></ruby>');
    expect(html.match(/<ruby>/gu)).toHaveLength(2);
    expect(html).toContain('&lt;ruby onclick=&quot;alert(1)&quot;&gt;');
  });

  test('supports safe reading HTML in completed prose without executing arbitrary HTML', () => {
    const html = render(
      'Han Byeol touched her <ruby>Runtime Overlay<rt>runtime overlay</rt></ruby>.\n' +
        '<ruby><rb>漢</rb><rt>かん</rt><rb>字</rb><rt>じ</rt></ruby> ' +
        '<u>underline</u> <sup>2</sup> <sub>i</sub> <mark>highlight</mark> ' +
        '<small>aside</small> <b>bold</b> <i>italic</i> <s>obsolete</s><br>next<br />line'
    );
    expect(html).toContain('<ruby>Runtime Overlay<rp>(</rp><rt>runtime overlay</rt>');
    expect(html).toContain('<ruby>漢<rp>(</rp><rt>かん</rt><rp>)</rp>字<rp>(</rp><rt>じ</rt>');
    for (const fragment of [
      '<u>underline</u>',
      '<sup>2</sup>',
      '<sub>i</sub>',
      '<mark>highlight</mark>',
      '<small>aside</small>',
      '<b>bold</b>',
      '<i>italic</i>',
      '<s>obsolete</s>',
    ])
      expect(html).toContain(fragment);
    expect(html).toContain('<br>next<br>line');
    const unsafe = render(
      '<mark onclick="alert(1)">unsafe</mark> ' +
        '<ruby style="color:red">危険<rt>きけん</rt></ruby> ' +
        '<img src=x onerror=alert(1)> ' +
        '<script>alert(1)</script> ' +
        '<mark><img src=x onerror=alert(1)></mark>'
    );
    expect(unsafe).not.toMatch(/<(?:img|script)\b/u);
    expect(unsafe).not.toContain('<mark onclick');
    expect(unsafe).not.toContain('<ruby style=');
    expect(unsafe).toContain('&lt;mark onclick=');
    expect(unsafe).toContain('&lt;ruby style=');
  });

  test('keeps fenced code, protected placeholders, template syntax and machine identifiers literal', () => {
    const html = render(
      '```json\n{"assetRef":"harbor_01","mode":"READY"}\n\n<script>literal</script>\n```\n\n`**literal**` {{**user**}} [[p_ab12_1]] asset:harbor_01 SOME_ENUM'
    );
    expect(html).toContain(
      '<pre><code>{&quot;assetRef&quot;:&quot;harbor_01&quot;,&quot;mode&quot;:&quot;READY&quot;}\n\n&lt;script&gt;literal&lt;/script&gt;\n</code></pre>'
    );
    expect(html).toContain('<code>**literal**</code>');
    expect(html).toContain('{{**user**}} [[p_ab12_1]] asset:harbor_01 SOME_ENUM');
    expect(html).not.toContain('<strong>');
  });

  test('preserves long unfinished templates after a completed token without swallowing later Markdown', () => {
    const unfinished = '{{'.repeat(40_000);
    expect(render(`{{**user**}} ${unfinished} **서술** [[p_ab12_1]]`)).toBe(
      `<p>{{**user**}} ${unfinished} <strong>서술</strong> [[p_ab12_1]]</p>\n`
    );
  });

  test('matches whole code delimiters and keeps unmatched runs literal', () => {
    expect(render('`a` ``b ` c``')).toContain('<code>a</code> <code>b ` c</code>');
    expect(render('\\``foo`')).toContain('`<code>foo</code>');
    expect(render('\\```foo``')).toContain('`<code>foo</code>');
    expect(render('prefix ``unfinished` **next**')).toContain(
      'prefix ``unfinished` <strong>next</strong>'
    );
  });

  test('preserves pathological unfinished code and tags without repeated suffix searches', () => {
    const ticks = '`'.repeat(40_000);
    expect(render(`prefix ${ticks} **next**`)).toBe(
      `<p>prefix ${ticks} <strong>next</strong></p>\n`
    );
    const tags = '<script'.repeat(20_000);
    expect(render(`${tags} **next**`)).toBe(
      `<p>${tags.replaceAll('<', '&lt;')} <strong>next</strong></p>\n`
    );
  });

  test('rejects unsafe and ambiguous URL schemes without accepting control-character obfuscation', () => {
    for (const value of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'java\nscript:alert(1)',
      'data:text/html,hi',
      '//example.com',
      '/\\example.com',
      'https:\\example.com',
    ])
      expect(safeProseLink(value)).toBeUndefined();
    for (const value of [
      'https://example.com',
      'http://example.com/story',
      'mailto:writer@example.com',
      '/help',
      '#scene',
    ])
      expect(safeProseLink(value)).toBe(value);
  });

  test('renders a long source without interpreting unsupported syntax as HTML', () => {
    const html = render(
      Array.from(
        { length: 300 },
        (_, index) =>
          `문단 ${index}: **기억**과 바람을 따라 걷는다. <x-state mode="READY">asset:harbor_01</x-state>`
      ).join('\n\n')
    );
    expect(html.match(/<p>/gu)).toHaveLength(300);
    expect(html).not.toContain('<x-state');
  });
});
