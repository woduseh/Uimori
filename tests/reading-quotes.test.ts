import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { PlainProse } from '../web/Prose.js';
import { DEFAULT_READABILITY, type ReadabilitySettings } from '../web/reading-preferences.js';
import { scanReadingQuotes } from '../web/reading-quotes.js';

const reading = (overrides: Partial<ReadabilitySettings> = {}): ReadabilitySettings => ({
  ...DEFAULT_READABILITY,
  emphasis: 'subtle',
  dialogueBreaks: true,
  ...overrides,
});
const render = (text: string, settings = reading()) =>
  renderToStaticMarkup(createElement(PlainProse, { text, reading: settings }));
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
    expect(html).toContain('“대사” ');
  });

  test('the scanner handles long repeated quotes and bounds hostile nesting', () => {
    const flat = '“한 문장” '.repeat(20_000);
    expect(scanReadingQuotes(flat, reading())).toHaveLength(20_000);
    const nested = '“'.repeat(100_000) + '”'.repeat(100_000);
    expect(scanReadingQuotes(nested, reading())).toEqual([]);
    expect(scanReadingQuotes(`“완료” ${nested}`, reading())).toHaveLength(1);
  });

  test('single line boundaries still isolate quotes, while blank lines and adjacent quotes avoid duplicate gaps', () => {
    const existing = scanReadingQuotes('“첫째 줄”\n“둘째 줄”\n마지막 줄.', reading());
    expect(
      existing.map(({ separate, breakBefore, breakAfter }) => [separate, breakBefore, breakAfter])
    ).toEqual([
      [true, false, true],
      [true, false, true],
    ]);
    const adjacent = scanReadingQuotes('“첫 대사”  「둘째 대사」', reading());
    expect(adjacent.map(({ breakBefore, breakAfter }) => [breakBefore, breakAfter])).toEqual([
      [false, true],
      [false, false],
    ]);
    const mixed = scanReadingQuotes('서술 “대사”\n다음 서술', reading());
    expect(mixed[0]).toMatchObject({ breakBefore: true, breakAfter: true });
    const blank = scanReadingQuotes('서술\n\n“대사”\n\n다음 서술', reading());
    expect(blank[0]).toMatchObject({ breakBefore: false, breakAfter: false });
  });
});

describe('literal reading styles', () => {
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
});
