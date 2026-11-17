import { describe, expect, it } from 'vitest';
import { compileReadingMarkdown } from '../core/reading-markdown.js';
import { parseStoryUi, projectStoryUiText, validateStoryUiAction } from '../core/story-ui.js';
import { normalizeStoryUiOutput } from '../server/story-ui.js';

describe('story UI', () => {
  it('reads a long valid block after storing both expression and compiled content', () => {
    const expression = `<a2ui>root = Column([${Array.from({ length: 10 }, () => `Text("${'x'.repeat(6000)}")`).join(',')}])</a2ui>`;
    const normalized = normalizeStoryUiOutput(expression);
    expect(normalized.length).toBeGreaterThan(100_000);
    expect(parseStoryUi(normalized)[0].kind).toBe('ui');
  });
  it('compiles independent blocks and preserves prose and the original expression', () => {
    const expression =
      '<a2ui>root = Column([Text("Archive"), BarChart(title="Years", items=[{label: "Spring", value: 12}])])</a2ui>';
    const source = `Before\n${expression}\nAfter`;
    const result = normalizeStoryUiOutput(source);
    const segments = parseStoryUi(result);
    expect(segments.map((segment) => segment.kind)).toEqual(['prose', 'ui', 'prose']);
    expect(segments[1]).toMatchObject({ expression });
    expect(projectStoryUiText(result)).toContain('Spring\n12');
    expect(normalizeStoryUiOutput(result)).toBe(result);
  });
  it('renders an inline expression as a block while preserving surrounding text', () => {
    const source = 'Before <a2ui>root=Text("x")</a2ui> After';
    const result = normalizeStoryUiOutput(source);
    const segments = parseStoryUi(result);
    expect(segments.map((part) => part.kind)).toEqual(['prose', 'ui', 'prose']);
    expect(result.startsWith('Before \n')).toBe(true);
    expect(result.endsWith('\n After')).toBe(true);
    expect(normalizeStoryUiOutput(result)).toBe(result);
    const slots = segments
      .filter((part) => part.kind === 'ui')
      .map(({ id, start }) => ({ id, start }));
    expect(compileReadingMarkdown(result, [], [], slots).html).toContain(
      `data-story-ui-slot="${slots[0].id}"`
    );
  });
  it('preserves Markdown inline code containing expressions', () => {
    for (const source of [
      'Before `<a2ui>root=Text("x")</a2ui>` After',
      'Before ``<a2ui>root=Text("x")</a2ui>`` After',
      'Before `<a2ui>root=Text("x")\n</a2ui>` After',
    ]) {
      expect(normalizeStoryUiOutput(source)).toBe(source);
      expect(parseStoryUi(source).map((part) => part.kind)).toEqual(['prose']);
    }
  });
  it('keeps initialized data and repeated list templates', () => {
    const expression = `<a2ui>
$/people = [{name: "Mira"}, {name: "Sol"}]
item = Text($name)
root = List(_template($/people, item))
</a2ui>`;
    const result = normalizeStoryUiOutput(expression);
    expect(parseStoryUi(result)[0].kind).toBe('ui');
    expect(projectStoryUiText(result)).toContain('"name":"Mira"');
  });
  it('leaves ordinary fenced code as prose', () => {
    const source = '```example\n<a2ui>root = Text("code")</a2ui>\n```';
    expect(normalizeStoryUiOutput(source)).toBe(source);
    expect(parseStoryUi(source)[0].kind).toBe('prose');
  });
  it('keeps invalid and unfinished output visible without losing adjacent text', () => {
    const source = 'A<a2ui>root = Unknown()</a2ui>B<a2ui>root =';
    expect(normalizeStoryUiOutput(source)).toBe(source);
    expect(parseStoryUi(source).map((part) => part.kind)).toEqual([
      'prose',
      'invalid',
      'prose',
      'pending',
    ]);
  });
  it('rejects tampered components and external images', () => {
    const valid = normalizeStoryUiOutput('<a2ui>root = Text("hello")</a2ui>');
    expect(parseStoryUi(valid)[0].kind).toBe('ui');
    expect(parseStoryUi(valid.replace('"component":"Text"', '"component":"Video"'))[0].kind).toBe(
      'invalid'
    );
    expect(
      parseStoryUi(
        normalizeStoryUiOutput('<a2ui>root = Image("https://example.com/a.png")</a2ui>')
      )[0].kind
    ).toBe('invalid');
  });
  it('includes a formatString display template in the story projection', () => {
    const source = normalizeStoryUiOutput(
      `<a2ui>root = Text(formatString("Hello \${/name}"))</a2ui>`
    );
    expect(projectStoryUiText(source)).toContain(`Hello \${/name}`);
  });
  it('accepts resolved function context for a declared button event', () => {
    const source = normalizeStoryUiOutput(`<a2ui>
$/name = "Mira"
root = Button(Text("Greet"), action=Event("greet", {message: formatString("Hello \${/name}")}))
</a2ui>`);
    const segment = parseStoryUi(source)[0];
    expect(segment.kind).toBe('ui');
    expect(
      validateStoryUiAction(source, segment.id, 'greet', { message: 'Hello Mira' }, 'root')
    ).not.toBeNull();
    expect(
      validateStoryUiAction(source, segment.id, 'greet', { message: 'Hello Mira' }, 'other')
    ).toBeNull();
    expect(validateStoryUiAction(source, segment.id, 'greet', { other: 'Hello Mira' })).toBeNull();
    expect(
      validateStoryUiAction(source, segment.id, 'other', { message: 'Hello Mira' })
    ).toBeNull();
  });
  it('requires declared fixed dice dimensions and rejects tampered or out-of-range rolls', () => {
    const source = normalizeStoryUiOutput(
      '<a2ui>root=Button(Text("Roll"), action=Event("roll", {sides: 6, count: 2}))</a2ui>'
    );
    const segment = parseStoryUi(source)[0];
    expect(
      validateStoryUiAction(source, segment.id, 'roll', { sides: 6, count: 2 })
    ).not.toBeNull();
    expect(validateStoryUiAction(source, segment.id, 'roll', { sides: 20, count: 2 })).toBeNull();
    const invalid = normalizeStoryUiOutput(
      '<a2ui>root=Button(Text("Roll"), action=Event("roll", {sides: 1001}))</a2ui>'
    );
    expect(
      validateStoryUiAction(invalid, parseStoryUi(invalid)[0].id, 'roll', { sides: 1001 })
    ).toBeNull();
  });
});
