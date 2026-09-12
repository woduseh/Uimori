import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { PlainProse, Prose } from '../web/Prose.js';
import { ReadingPreferencesContext } from '../web/ReadingPreferencesContext.js';
import { DEFAULT_READABILITY, type ReadabilitySettings } from '../web/reading-preferences.js';
import { scanReadingQuotes } from '../web/reading-quotes.js';

const reading = (overrides: Partial<ReadabilitySettings> = {}): ReadabilitySettings => ({
  ...DEFAULT_READABILITY,
  emphasis: 'subtle',
  dialogueBreaks: true,
  ...overrides,
});
const render = (text: string, settings = reading()) =>
  renderToStaticMarkup(createElement(Prose, { text, reading: settings }));
const renderPlain = (text: string, settings = reading()) =>
  renderToStaticMarkup(createElement(PlainProse, { text, reading: settings }));
const renderedText = (html: string) =>
  html.replace(/<[^>]*>/gu, '').replace(/&(amp|lt|gt|quot|#x27);/gu, (_, entity: string) => {
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'" } as Record<string, string>)[
      entity
    ];
  });

describe('reading quotation pairing', () => {
  test('maps all six pairs to their selected role and only separates selected roles', () => {
    const text = `"첫 대사" “둘째 대사” '첫 생각' ‘둘째 생각’ 「셋째 대사」 『책 제목』`;
    const quotes = scanReadingQuotes(text, reading());
    expect(quotes.map(({ role }) => role)).toEqual([
      'dialogue',
      'dialogue',
      'thought',
      'thought',
      'dialogue',
      'quote',
    ]);
    expect(quotes.map(({ separate }) => separate)).toEqual([true, true, false, false, true, false]);
    expect(quotes.map(({ start, end }) => text.slice(start, end))).toEqual([
      '"첫 대사"',
      '“둘째 대사”',
      "'첫 생각'",
      '‘둘째 생각’',
      '「셋째 대사」',
      '『책 제목』',
    ]);
  });

  test('pairing is syntactic, including a quote followed by narration', () => {
    const html = render('“괜찮아”라고 그녀는 말했다.');
    expect(html).toContain('reading-quote-break');
    expect(html).toContain('>“괜찮아”</span>라고 그녀는 말했다.');
  });

  test('nested quotations receive roles without inner line breaks', () => {
    const quotes = scanReadingQuotes(
      '「그가 『기다려』라고 말했다. ‘생각이다.’」',
      reading({ thoughtBreaks: true })
    );
    expect(quotes).toHaveLength(1);
    expect(quotes[0].separate).toBe(true);
    expect(quotes[0].children.map(({ role, separate }) => [role, separate])).toEqual([
      ['quote', false],
      ['thought', false],
    ]);
    expect(
      render('「그가 『기다려』라고 말했다. ‘생각이다.’」').match(/reading-quote-break(?=[\s"])/gu)
    ).toHaveLength(1);
  });

  test('unclosed quotation trees stay literal and paragraph boundaries do not invent a pair', () => {
    expect(scanReadingQuotes('“끝나지 않은 「인용」', reading())).toEqual([]);
    expect(render('“끝나지 않은 「인용」')).not.toContain('reading-quote');
    expect(render('“첫 문단\n\n둘째 문단”')).not.toContain('reading-quote');
  });

  test('English contractions and basic possessives do not become thoughts', () => {
    const text = `I'm sure you don't need James' book or the writers' notes. It’s mine. 'A thought' ‘Another thought’`;
    const quotes = scanReadingQuotes(text, reading());
    expect(quotes.map(({ start, end }) => text.slice(start, end))).toEqual([
      "'A thought'",
      '‘Another thought’',
    ]);
    expect(scanReadingQuotes(`“I'm sure you don't need it.”`, reading())).toHaveLength(1);
  });

  test('Korean particles do not turn closing single quotes into apostrophes', () => {
    const text = "'약속'이라는 말과 ‘생각’이라고 쓴다. I don’t know.";
    expect(
      scanReadingQuotes(text, reading()).map(({ start, end }) => text.slice(start, end))
    ).toEqual(["'약속'", '‘생각’']);
    expect(
      render(text, reading({ thoughtBreaks: true })).match(/reading-quote-break(?=[\s"])/gu)
    ).toHaveLength(2);
  });

  test('role overrides, disabled pairs and thought breaks work independently of emphasis', () => {
    const settings = reading({
      emphasis: 'off',
      dialogueBreaks: false,
      thoughtBreaks: true,
      quoteRoles: {
        ...DEFAULT_READABILITY.quoteRoles,
        doubleCorner: 'thought',
        curlyDouble: 'off',
      },
    });
    const html = render('“대사” 『생각』 ‘속마음’', settings);
    expect(html.match(/reading-quote-break(?=[\s"])/gu)).toHaveLength(2);
    expect(html.match(/data-emphasis="off"/gu)).toHaveLength(2);
    expect(html).not.toContain('data-quote-role="off"');
    expect(html).toContain('<p>“대사” ');
  });

  test('the scanner handles long repeated quotes and bounds hostile nesting', () => {
    const flat = '“한 문장” '.repeat(20_000);
    expect(scanReadingQuotes(flat, reading())).toHaveLength(20_000);
    const nested = '“'.repeat(100_000) + '”'.repeat(100_000);
    expect(scanReadingQuotes(nested, reading())).toEqual([]);
    expect(scanReadingQuotes(`“완료” ${nested}`, reading())).toHaveLength(1);
  });

  test('existing line boundaries need no new breaks and adjacent quotes share one break', () => {
    const existing = scanReadingQuotes('“첫째 줄”\n“둘째 줄”\n마지막 줄.', reading());
    expect(
      existing.map(({ separate, breakBefore, breakAfter }) => [separate, breakBefore, breakAfter])
    ).toEqual([
      [true, false, false],
      [true, false, false],
    ]);
    const adjacent = scanReadingQuotes('“첫 대사”  「둘째 대사」', reading());
    expect(adjacent.map(({ breakBefore, breakAfter }) => [breakBefore, breakAfter])).toEqual([
      [false, true],
      [false, false],
    ]);
    const mixed = scanReadingQuotes('서술 “대사”\n다음 서술', reading());
    expect(mixed[0]).toMatchObject({ breakBefore: true, breakAfter: false });
  });
});

describe('render-only reading styles', () => {
  test('default settings leave the existing Markdown markup unchanged', () => {
    expect(render('**서술** “대사”\n다음 줄.', DEFAULT_READABILITY)).toBe(
      '<p><strong>서술</strong> “대사”<br/>\n다음 줄.</p>\n\n'
    );
    expect(render('“대사”', reading({ emphasis: 'strong', dialogueBreaks: false }))).toContain(
      'class="reading-quote" data-quote-role="dialogue" data-emphasis="strong"'
    );
  });

  test('quotations span Markdown emphasis and preserve emphasis crossing quotation boundaries', () => {
    const text = '서술. “정말 **괜찮아**?” *그녀는 「네」라고 답했다.*';
    const html = render(text);
    expect(html).toContain('>“정말 <strong>괜찮아</strong>?”</span>');
    expect(html).toContain('<em>그녀는 </em>');
    expect(html).toContain('<em>「네」</em>');
    expect(html).toContain('<em>라고 답했다.</em>');
    expect(renderedText(html)).toBe(renderedText(render(text, DEFAULT_READABILITY)));
  });

  test('code, ruby, links, URLs, HTML attributes and protected tokens remain outside quote analysis', () => {
    const text = [
      '```json\n{"말": "값"}\n```',
      '`“inline code”` {{"값": "원본"}} [[p_ab12_1]]',
      '<ruby>“漢字”<rt>‘읽기’</rt></ruby>',
      '<x-note title="대사처럼 보여도 속성" data-state=\'off\'>태그</x-note>',
      "[“링크 제목”](https://example.com/'quoted') ![“이미지 제목”](https://example.com/image.png)",
      "https://example.com/'literal' mailto:writer@example.com",
    ].join('\n\n');
    const html = render(text);
    expect(html).not.toContain('reading-quote');
    expect(renderedText(html)).toBe(renderedText(render(text, DEFAULT_READABILITY)));
    expect(html).toContain('<code>“inline code”</code>');
  });

  test('settings affect only React presentation and preserve quoted characters and visible text', () => {
    const source = {
      text: '서술. “첫 대사”라고 말했다.\n「두 번째 『중첩』 대사」 ‘생각’',
      hash: 'unchanged',
    };
    const original = structuredClone(source);
    const before = render(source.text, DEFAULT_READABILITY);
    const after = render(source.text, reading({ thoughtBreaks: true }));
    expect(renderedText(after)).toBe(renderedText(before));
    expect(source).toEqual(original);
  });

  test('context supplies browser settings and an explicit preview override takes precedence', () => {
    const html = renderToStaticMarkup(
      createElement(
        ReadingPreferencesContext.Provider,
        { value: reading() },
        createElement(Prose, { text: '“첫 대사”' }),
        createElement(Prose, { text: '“기본 예문”', reading: DEFAULT_READABILITY })
      )
    );
    expect(html.match(/reading-quote-break(?=[\s"])/gu)).toHaveLength(1);
    expect(html).toContain('<p>“기본 예문”</p>');
  });

  test('PlainProse preserves literal Markdown, all whitespace and original newline characters', () => {
    const text = '  **서술**\r\n“**대사**”  \r\n\r\n\t「둘째 대사」\n\n마지막\n';
    expect(renderPlain(text, DEFAULT_READABILITY)).toBe(text);
    const html = renderPlain(text);
    expect(renderedText(html)).toBe(text);
    expect(html).not.toContain('<strong>');
    expect(html).not.toContain('<br');
    expect(html.match(/reading-plain-paragraph/gu)).toHaveLength(3);
    expect(html.match(/reading-quote-break(?=[\s"])/gu)).toHaveLength(2);
  });

  test('PlainProse protects complete and unfinished code fences across blank lines', () => {
    const text = '“대사”\n\n```json\n{"quoted": "code"}\n\n“코드”\n```\n\n~~~\n“미완료 코드”';
    const html = renderPlain(text);
    expect(renderedText(html)).toBe(text);
    expect(html.match(/reading-quote-break(?=[\s"])/gu)).toHaveLength(1);
    expect(html).not.toContain('<code>');
  });

  test('PlainProse uses paragraph wrappers for spacing without enabling quotations', () => {
    const text = '“첫 문단”\n\n‘둘째 문단’';
    const html = renderPlain(text, { ...DEFAULT_READABILITY, paragraphSpacing: 1 });
    expect(html.match(/reading-plain-paragraph/gu)).toHaveLength(2);
    expect(html).not.toContain('reading-quote');
    expect(renderedText(html)).toBe(text);
  });

  test('existing Prose br and PlainProse newlines remain without extra visual breaks', () => {
    for (const text of ['“첫째 줄”\n“둘째 줄”\n마지막 줄.', '서술\n“대사”\n다음 서술']) {
      const prose = render(text);
      const plain = renderPlain(text);
      expect(prose.match(/<br\/>/gu)).toHaveLength(2);
      for (const html of [prose, plain]) {
        expect(html).toContain('reading-quote-break');
        expect(html).not.toContain('reading-quote-break-before');
        expect(html).not.toContain('reading-quote-break-after');
      }
      expect(renderedText(prose)).toBe(renderedText(render(text, DEFAULT_READABILITY)));
      expect(renderedText(plain)).toBe(text);
    }
    expect(render('서술\n“대사” 다음 서술')).toContain('reading-quote-break-after');
    expect(render('서술\n“대사” 다음 서술')).not.toContain('reading-quote-break-before');
  });

  test('PlainProse bounds repeated unfinished ruby, templates, tags and backtick runs', () => {
    const samples = [
      '<ruby>'.repeat(120_000),
      '{{'.repeat(120_000),
      '<script'.repeat(120_000),
      '['.repeat(120_000),
      `prefix ${'`'.repeat(120_000)}`,
    ];
    const started = performance.now();
    for (const text of samples) expect(renderedText(renderPlain(text))).toBe(text);
    // This generous budget guards synchronous UI stalls from rescanning every
    // suffix. Linear parsing and server rendering of all samples is subsecond
    // locally; the former repeated-ruby scan alone takes many seconds.
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test('quote-heavy styled paragraphs retain all visible text', () => {
    const text = '서술. “**대사**” 「*짧은 대사*」 '.repeat(2_000);
    const html = render(text);
    expect(html.match(/reading-quote-break(?=[\s"])/gu)).toHaveLength(4_000);
    expect(renderedText(html)).toBe(renderedText(render(text, DEFAULT_READABILITY)));
  });
});
