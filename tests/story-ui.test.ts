import { describe, expect, it } from 'vitest';
import { compileReadingMarkdown } from '../core/reading-markdown.js';
import { parseStoryUi, projectStoryUiText, validateStoryUiAction } from '../core/story-ui.js';
import { resolveStoryUiPresentation, resolveStoryUiStyle } from '../core/story-ui-style.js';
import { prepareStoryUiTranslation } from '../core/story-ui-translation.js';
import {
  defaultThemePreferences,
  emptyTheme,
  type Theme,
  type ThemeCatalog,
} from '../core/themes.js';
import { normalizeStoryUiOutput, storyUiPrompt } from '../server/story-ui.js';

describe('story UI', () => {
  it('teaches placement with examples that compile, without form-assistant boilerplate', () => {
    const prompt = storyUiPrompt();
    const examples = parseStoryUi(
      normalizeStoryUiOutput(
        prompt.slice(prompt.indexOf('## Examples'), prompt.indexOf('## Rules'))
      )
    );
    const kinds = examples.map((part) => part.kind);
    expect(kinds.filter((kind) => kind === 'ui').length).toBeGreaterThanOrEqual(4);
    expect(kinds).not.toContain('invalid');
    expect(kinds).not.toContain('pending');
    // The first example shows blocks inside a scene: prose, block, prose, block, prose.
    expect(kinds.slice(0, 5)).toEqual(['prose', 'ui', 'prose', 'ui', 'prose']);
    for (const noise of ['dummy click', 'Surface targeting', '- weight:'])
      expect(prompt).not.toContain(noise);
    expect(prompt).toContain('- Description: One chat bubble.');
    expect(prompt.indexOf('## Where it goes')).toBeLessThan(prompt.indexOf('## Block syntax'));
  });
  it('keeps decoration and block CSS out of wording and translation, and images on stored paths', () => {
    const block = (frame: string) => `<a2ui>
$/_uimori/css = r"""& { --story-paper: #101018; } .look-plate { letter-spacing: .2em; }"""
root = Frame(body, "관제실", ${frame})
body = Column([
  Hero("제7구역", "접근 제한", "/api/assets/city", "LOCATION"),
  Dialogue("돌아보지 마.", "레이", "/api/assets/ray", "낮게"),
  Ring("동기화", 72, 0, 100, "%"),
  Text("판정", variant="display", look="plate")
])
</a2ui>`;
    const stored = normalizeStoryUiOutput(
      block('surface="glow", ornament="corners", backdrop="/api/assets/city"')
    );
    expect(parseStoryUi(stored)[0].kind).toBe('ui');
    const wording = projectStoryUiText(stored);
    for (const value of ['관제실', '제7구역', 'LOCATION', '레이', '돌아보지 마.', '낮게', '72'])
      expect(wording).toContain(value);
    for (const hidden of ['story-paper', 'look-plate', 'glow', 'corners', '/api/assets'])
      expect(wording).not.toContain(hidden);
    const translation = prepareStoryUiTranslation(stored);
    expect(translation.text).toContain('레이');
    expect(translation.text).not.toContain('story-paper');
    expect(translation.text).not.toContain('plate');
    for (const invalid of [
      'backdrop="https://outside.invalid/a.png"',
      'surface="lava"',
      'look="Not Valid!"',
    ])
      expect(parseStoryUi(normalizeStoryUiOutput(block(invalid)))[0].kind).toBe('invalid');
  });
  it('reads composed media as wording, or as the expression a writer continues from', () => {
    const expression = `<a2ui>
root = Frame(chat, "한서윤", kind="app", accent="amber")
chat = Column([
  Message("어디야", "한서윤", "23:41"),
  Post("본문", "익명", "제목", tag="목격"),
  Stat("상태", "양호"),
  Gauge("체력", 64, 0, 120),
  KeyValue([{label: "종족", value: "엘프"}]),
  ChoicePicker("진입로", "mutuallyExclusive", [{label: "북쪽 능선", value: "north"}], $/route)
])
</a2ui>`;
    const stored = normalizeStoryUiOutput(`앞
${expression}
뒤`);
    expect(parseStoryUi(stored)[1].kind).toBe('ui');
    const wording = projectStoryUiText(stored);
    for (const value of [
      '한서윤',
      '23:41',
      '어디야',
      '목격',
      '제목',
      '양호',
      '64',
      '엘프',
      '북쪽 능선',
    ])
      expect(wording).toContain(value);
    for (const hidden of ['amber', 'app', 'north', 'Frame']) expect(wording).not.toContain(hidden);
    expect(wording.indexOf('한서윤')).toBeLessThan(wording.indexOf('어디야'));
    expect(projectStoryUiText(stored, 'expression')).toBe(`앞
${expression}
뒤`);
    const prepared = prepareStoryUiTranslation(stored);
    expect(prepared.text).toContain('양호');
    expect(prepared.text).toContain('엘프');
    for (const hidden of ['amber', 'north', '"64"']) expect(prepared.text).not.toContain(hidden);
  });
  it('accepts only stored images as portraits', () => {
    const block = (avatar: string) =>
      parseStoryUi(
        normalizeStoryUiOutput(`<a2ui>root = Message("안녕", "미라", avatar="${avatar}")</a2ui>`)
      )[0].kind;
    expect(block('/api/assets/mira')).toBe('ui');
    expect(block('https://example.com/mira.png')).toBe('invalid');
  });
  it('accepts ordinary event data whose field names resemble function metadata', () => {
    const source = normalizeStoryUiOutput(
      '<a2ui>root = Button(Text("Call"), action=Event("contact", {call: "Mira", functionCall: "phone"}))</a2ui>'
    );
    const segment = parseStoryUi(source)[0];
    expect(segment.kind).toBe('ui');
    expect(
      validateStoryUiAction(source, segment.id, 'contact', { call: 'Mira', functionCall: 'phone' })
    ).not.toBeNull();
  });
  it('persists a model-selected style through translation and honors the chat override', () => {
    const expression = '<a2ui>\n$/_uimori/style = "blue-archive"\nroot = Text("Hello")\n</a2ui>';
    const stored = normalizeStoryUiOutput(expression);
    const segment = parseStoryUi(stored)[0];
    expect(segment.kind).toBe('ui');
    if (segment.kind !== 'ui') throw new Error('UI missing');
    expect(resolveStoryUiStyle(undefined, segment.messages)).toBe('blue-archive');
    expect(resolveStoryUiStyle('auto', segment.messages)).toBe('blue-archive');
    expect(resolveStoryUiStyle('default', segment.messages)).toBe('default');
    expect(resolveStoryUiStyle('modern', segment.messages)).toBe('modern');
    expect(projectStoryUiText(stored)).not.toContain('blue-archive');
    const prepared = prepareStoryUiTranslation(stored);
    expect(prepared.text).not.toContain('blue-archive');
    const restored = prepared.restore(prepared.text.replace('Hello', '안녕'));
    const translated = parseStoryUi(restored)[0];
    if (translated.kind !== 'ui') throw new Error('Translated UI missing');
    expect(resolveStoryUiStyle(undefined, translated.messages)).toBe('blue-archive');
    expect(projectStoryUiText(restored)).toContain('안녕');
    const unknown = normalizeStoryUiOutput(expression.replace('blue-archive', 'unknown'));
    const fallback = parseStoryUi(unknown)[0];
    if (fallback.kind !== 'ui') throw new Error('UI missing');
    expect(resolveStoryUiStyle(undefined, fallback.messages)).toBe('default');
  });
  it('resolves story UI themes in chat, bot and model order', () => {
    const botTheme: Theme = {
      ...emptyTheme('Bot theme'),
      id: 'bot-theme',
      revision: 1,
      storyUi: { baseStyle: 'fantasy', css: ':host { color: red; }' },
    };
    const chatTheme: Theme = {
      ...emptyTheme('Chat theme'),
      id: 'chat-theme',
      revision: 2,
      storyUi: { baseStyle: 'east-asian', css: ':host { color: blue; }' },
    };
    const catalog: ThemeCatalog = {
      themes: [botTheme, chatTheme],
      preferences: { ...defaultThemePreferences(), botStoryUiThemes: { bot: botTheme.id } },
    };
    const [segment] = parseStoryUi(
      normalizeStoryUiOutput(
        '<a2ui>\n$/_uimori/style = "theme:chat-theme"\nroot = Text("Hello")\n</a2ui>'
      )
    );
    if (segment.kind !== 'ui') throw new Error('UI missing');
    const { messages } = segment;
    expect(resolveStoryUiPresentation('modern', messages, catalog, 'bot')).toEqual({
      style: 'modern',
    });
    expect(resolveStoryUiPresentation('theme:chat-theme', [], catalog, 'bot')).toEqual({
      style: 'east-asian',
      theme: chatTheme,
    });
    for (const setting of ['auto', undefined] as const)
      expect(resolveStoryUiPresentation(setting, messages, catalog, 'bot')).toEqual({
        style: 'fantasy',
        theme: botTheme,
      });
    expect(resolveStoryUiPresentation('auto', messages, catalog, 'another-bot')).toEqual({
      style: 'east-asian',
      theme: chatTheme,
    });
    expect(resolveStoryUiPresentation('theme:deleted', messages, catalog, 'bot')).toEqual({
      style: 'east-asian',
      theme: chatTheme,
    });
    expect(resolveStoryUiPresentation('auto', messages, { ...catalog, themes: [] }, 'bot')).toEqual(
      {
        style: 'default',
      }
    );
  });
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
  it('preserves Markdown inline and fenced code containing expressions', () => {
    for (const source of [
      'Before `<a2ui>root=Text("x")</a2ui>` After',
      'Before ``<a2ui>root=Text("x")</a2ui>`` After',
      'Before `<a2ui>root=Text("x")\n</a2ui>` After',
      '```example\n<a2ui>root = Text("code")</a2ui>\n```',
    ]) {
      expect(normalizeStoryUiOutput(source)).toBe(source);
      expect(parseStoryUi(source).map((part) => part.kind)).toEqual(['prose']);
    }
  });
  it('keeps repeated list data and accepts bound images and icons', () => {
    const expression = `<a2ui>
$/people = [{name: "Mira", portrait: "/api/assets/mira", icon: "person"}, {name: "Sol", portrait: "/api/assets/sol", icon: "person"}]
item = Row([Image($portrait, description=$name), Icon($icon), Text($name)])
root = List(_template($/people, item))
</a2ui>`;
    const result = normalizeStoryUiOutput(expression);
    expect(parseStoryUi(result)[0].kind).toBe('ui');
    expect(projectStoryUiText(result)).toContain('"name":"Mira"');
    expect(projectStoryUiText(result)).toContain('"name":"Sol"');
    const party = normalizeStoryUiOutput(`<a2ui>
$/party = [{name: "Mira", hp: 30, state: "Hurt"}]
row = Row([Stat($name, $state), Gauge($name, $hp, 0, 100)])
root = List(_template($/party, row))
</a2ui>`);
    expect(parseStoryUi(party)[0].kind).toBe('ui');
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
